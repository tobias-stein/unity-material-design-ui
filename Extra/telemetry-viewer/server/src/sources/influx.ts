/**
 * InfluxDB v2 source — the "metadata ledger" (§3.3–4). Strictly read-only:
 * the only upstream requests are `GET /health` and `POST /api/v2/query`
 * (a Flux query). Point rows (one row per field per tag-set) are grouped
 * back into raw events matching the `.lp` file source exactly.
 */
import type {
  FetchOptions,
  MeasurementName,
  RawEvent,
  RawEventFields,
  RawEventResult,
  SourceError,
  SourceProvider,
  SourceStatus,
} from "../domain.js";
import { Measurements } from "../domain.js";
import { parseAnnotatedCsv, rfc3339ToNs, type CsvRecord } from "./csv.js";

/** Only runtime measurements are projected; unknown ones are skipped. */
const KNOWN_MEASUREMENTS: ReadonlySet<string> = new Set(Object.values(Measurements));

export interface InfluxSourceOptions {
  url: string;
  org: string;
  bucket: string;
  token: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export class InfluxSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 404 | 502 | 503,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "InfluxSourceError";
  }
}

const EVENT_COLUMNS = [
  "_time",
  "_measurement",
  "_field",
  "_value",
  "session",
  "type",
  "view",
  "view_id",
  "element",
  "element_type",
  "layer",
] as const;

export class FluxInfluxSource implements SourceProvider {
  readonly id = "influx" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: InfluxSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  get endpoint(): string {
    return this.options.url;
  }

  /**
   * Flux for every runtime point in the bucket. One `group(columns: [])` keeps
   * the CSV to a single result table; `keep` trims to the columns the domain
   * model needs (annotation handling is in the CSV parser).
   */
  private buildFlux(options?: FetchOptions): string {
    const lines: string[] = [];
    lines.push(`from(bucket: ${fluxString(this.options.bucket)})`);
    lines.push(`    |> range(start: ${fluxTime(options?.fromNs ?? 0n)}${options?.toNs !== undefined ? `, stop: ${fluxTime(options.toNs)}` : ""})`);
    lines.push(...EVENT_MEASUREMENT_SANITIZER);
    if (options?.sessionIds !== undefined) {
      lines.push(
        `    |> filter(fn: (r) => ${options.sessionIds.map((id) => `r.session == ${fluxString(id)}`).join(" or ")})`,
      );
    }
    lines.push(...EVENT_QUERY_TAIL);
    return lines.join("\n");
  }

  private async requestText(
    url: string,
    init: RequestInit & { headers: Record<string, string> },
  ): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new InfluxSourceError(
          "INFLUX_TIMEOUT",
          `InfluxDB did not answer within ${this.timeoutMs} ms.`,
          503,
          url,
        );
      }
      throw new InfluxSourceError(
        "INFLUX_UNAVAILABLE",
        `Cannot reach InfluxDB at ${this.options.url}: ${error instanceof Error ? error.message : String(error)}`,
        503,
        url,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** `GET /health` — no token needed, mirrors the Influx readiness state. */
  async describe(): Promise<SourceStatus> {
    try {
      const { status, body } = await this.requestText(
        `${this.options.url}/health`,
        { method: "GET", headers: {} },
      );
      if (status !== 200) {
        return {
          id: this.id,
          available: false,
          state: "unavailable",
          message: `InfluxDB /health returned HTTP ${status}: ${truncate(body, 200)}`,
          facts: { url: this.options.url, org: this.options.org, bucket: this.options.bucket, sessions: null },
        };
      }
      let sessions: number | null = null;
      try {
        sessions = await this.countSessions();
      } catch {
        sessions = null; // reachable but query-authorized?
      }
      return {
        id: this.id,
        available: sessions !== null,
        state: sessions !== null ? "ok" : "degraded",
        message: sessions === null ? "Reachable, but Flux queries failed (check token/org/bucket)." : undefined,
        facts: { url: this.options.url, org: this.options.org, bucket: this.options.bucket, sessions },
      };
    } catch (error) {
      return {
        id: this.id,
        available: false,
        state: "unavailable",
        message: error instanceof Error ? error.message : String(error),
        facts: { url: this.options.url, org: this.options.org, bucket: this.options.bucket, sessions: null },
      };
    }
  }

  /** Cheap distinct-session count for the source dashboard. */
  async countSessions(): Promise<number> {
    const flux =
      `from(bucket: ${fluxString(this.options.bucket)})\n` +
      `    |> range(start: 0)\n` +
      `    |> filter(fn: (r) => r._measurement == "ui_event" and r._field == "value")\n` +
      `    |> group(columns: [])\n` +
      `    |> keep(columns: ["_value", "session"])\n` +
      `    |> distinct(column: "session")\n` +
      `    |> keep(columns: ["_value"])`;
    const csv = await this.queryCsv(flux);
    return csv.records.filter((r) => typeof r._value === "string").length;
  }

  private async queryCsv(flux: string): Promise<{ columns: string[]; records: CsvRecord[] }> {
    const { status, body } = await this.requestText(
      `${this.options.url}/api/v2/query?org=${encodeURIComponent(this.options.org)}`,
      {
        method: "POST",
        headers: {
          "authorization": `Token ${this.options.token}`,
          "content-type": "application/vnd.flux",
          "accept": "application/csv",
        },
        body: flux,
      },
    );
    if (status === 401 || status === 403) {
      throw new InfluxSourceError(
        "INFLUX_UNAUTHORIZED",
        "InfluxDB rejected the token for this org/bucket.",
        502,
        truncate(body, 200),
      );
    }
    if (status === 404) {
      throw new InfluxSourceError(
        "INFLUX_NOT_FOUND",
        `InfluxDB has no org "${this.options.org}" (or the query endpoint path is wrong).`,
        502,
        truncate(body, 200),
      );
    }
    if (status >= 500) {
      throw new InfluxSourceError(
        "INFLUX_QUERY_FAILED",
        `InfluxDB query failed (HTTP ${status}).`,
        502,
        truncate(body, 300),
      );
    }
    if (status !== 200) {
      throw new InfluxSourceError(
        "INFLUX_QUERY_REJECTED",
        `InfluxDB query was rejected (HTTP ${status}).`,
        400,
        truncate(body, 300),
      );
    }
    return parseAnnotatedCsv(body);
  }

  async queryCsvErrors(flux: string): Promise<{ columns: string[]; records: CsvRecord[]; error?: SourceError }> {
    try {
      return await this.queryCsv(flux);
    } catch (error) {
      if (error instanceof InfluxSourceError) {
        return {
          columns: [],
          records: [],
          error: { code: error.code, message: error.message, httpStatus: error.httpStatus, detail: error.detail },
        };
      }
      throw error;
    }
  }

  async fetchEvents(options?: FetchOptions): Promise<RawEventResult> {
    const csv = await this.queryCsvErrors(this.buildFlux(options));
    if (csv.error) {
      return { events: [], malformedCount: 0, error: csv.error };
    }
    const events = recordsToRawEvents(csv.records);
    return { events, malformedCount: 0 };
  }
}


const EVENT_MEASUREMENT_SANITIZER = [
  `    |> filter(fn: (r) => ${[
    `r._measurement == ${fluxString(Measurements.UiEvent)}`,
    `r._measurement == ${fluxString(Measurements.Session)}`,
    `r._measurement == ${fluxString(Measurements.UiSnapshotTaken)}`,
  ].join(" or ")})`,
] as const;

const EVENT_QUERY_TAIL = [
  // A single result table (promised in the buildFlux docstring): collapse every
  // series with `group(columns: [])`. Two prerequisites:
  // 1. `_value` must be cast to string first — one table now mixes field types
  //    across series (string key/hash, int nodes, float width), and Flux
  //    rejects mixed `_value` types within a table ("cannot group integer and
  //    float types together"). The consumer (`applyFieldValue`) coerces back.
  // 2. `recordsToRawEvents` keys events WITHOUT the CSV table id (see there) —
  //    otherwise each per-field table would split a point into fragments.
  `    |> map(fn: (r) => ({ r with _value: string(v: r._value) }))`,
  `    |> group(columns: [])`,
  `    |> keep(columns: [${EVENT_COLUMNS.map((c) => fluxString(c)).join(", ")}])`,
  `    |> sort(columns: ["_time", "_field"])`,
] as const;

function fluxString(value: string): string {
  return JSON.stringify(value); // Flux string literal ≈ JSON string literal
}

/** epoch ns → Flux time literal (RFC3339 with ns). */
export function fluxTime(ns: bigint): string {
  const ms = ns / 1_000_000n;
  const remainder = ns % 1_000_000n;
  const date = new Date(Number(ms));
  const iso = date.toISOString();
  if (remainder === 0n) return iso;
  return `${iso.slice(0, -1)}.${String(remainder).padStart(9, "0")}Z`;
}

/**
 * Group one-row-per-field CSV rows into normalized raw events.
 * Rows are keyed by (measurement, timestamp, session, type, view, view_id,
 * element, element_type) — the full series identity; the first field-bearing
 * row wins on duplicates so like-for-like output matches the `.lp` parser.
 * The CSV `table`/`result` columns are deliberately NOT part of the key: how
 * Influx partitions rows across result tables is an output-detail (one table
 * per field is possible), not a series identity — keying on it splits every
 * ledger point into per-field fragments.
 */
export function recordsToRawEvents(records: CsvRecord[]): RawEvent[] {
  const events = new Map<string, RawEvent>();
  for (const record of records) {
    const timeNs = rfc3339ToNs(String(record._time ?? ""));
    if (timeNs === null) continue;
    const measurement = record._measurement;
    if (typeof measurement !== "string" || !KNOWN_MEASUREMENTS.has(measurement)) continue;

    const key = [
      measurement,
      timeNs.toString(),
      record.session ?? "",
      record.type ?? "",
      record.view ?? "",
      record.view_id ?? "",
      record.element ?? "",
      record.element_type ?? "",
      record.layer ?? "",
    ].join("\u0000");

    let event = events.get(key);
    if (event === undefined) {
      event = {
        measurement: measurement as MeasurementName,
        timestampNs: timeNs,
        tags: {
          session: stringOrNull(record.session) ?? "",
          ...(record.type !== undefined && record.type !== null ? { type: String(record.type) } : {}),
          ...(record.view !== undefined && record.view !== null ? { view: String(record.view) } : {}),
          ...(record.view_id !== undefined && record.view_id !== null ? { view_id: String(record.view_id) } : {}),
          ...(record.element !== undefined && record.element !== null ? { element: String(record.element) } : {}),
          ...(record.element_type !== undefined && record.element_type !== null
            ? { element_type: String(record.element_type) }
            : {}),
          ...(record.layer !== undefined && record.layer !== null
            ? { layer: String(record.layer) }
            : {}),
        },
        fields: {},
      };
      events.set(key, event);
    }
    applyFieldValue(event.fields, String(record._field ?? ""), record._value);
  }
  const list = [...events.values()];
  list.sort((a, b) => (a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : 0));
  return list;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return String(value);
}

/** Store one CSV `_field`/`_value` pair in the normalized fields bag. */
function applyFieldValue(fields: RawEventFields, field: string, rawValue: unknown): void {
  if (field === "" || rawValue === null || rawValue === undefined || rawValue === "") return;
  switch (field) {
    case "value": fields.value = coerceNumber(rawValue); break;
    case "on": fields.on = rawValue === true || rawValue === "true"; break;
    case "dwell": fields.dwell = coerceNumber(rawValue); break;
    case "key": fields.key = String(rawValue); break;
    case "hash": fields.hash = String(rawValue); break;
    case "nodes": fields.nodes = coerceNumber(rawValue); break;
    case "width": fields.width = coerceNumber(rawValue); break;
    case "height": fields.height = coerceNumber(rawValue); break;
    case "owner": fields.owner = String(rawValue); break;
    case "platform": fields.platform = String(rawValue); break;
    case "screen": fields.screen = String(rawValue); break;
    case "source": fields.source = String(rawValue); break;
    case "mode": fields.mode = String(rawValue); break;
    case "theme": fields.theme = String(rawValue); break;
    case "base": fields.base = String(rawValue); break;
    case "anchor": fields.anchor = String(rawValue); break;
    default: break;
  }
}

function coerceNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
