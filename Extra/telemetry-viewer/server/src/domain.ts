/**
 * Normalized domain model of the telemetry viewer.
 *
 * Every source (InfluxDB Flux queries, `.lp` line-protocol files) is first
 * normalized into {@link RawEvent}s — one point, tags + fields, nanosecond
 * timestamps — and then projected into {@link Session}s. Sources must produce
 * byte-comparable domain objects (tested by the parity suite), so this module
 * is deliberately free of any source-specific vocabulary.
 */

/** Measurements written by the Unity runtime (Assets/Runtime/Telemetry). */
export const Measurements = {
  UiEvent: "ui_event",
  Session: "session",
  UiSnapshotTaken: "ui_snapshot_taken",
} as const;

export type MeasurementName =
  | typeof Measurements.UiEvent
  | typeof Measurements.Session
  | typeof Measurements.UiSnapshotTaken;

export interface RawEventTags {
  /** Session id; present on every point the runtime emits. */
  session: string;
  /** Event kind (`click`, `toggle`, `view_open`, …) or lifecycle state for `session`. */
  type?: string;
  view?: string;
  view_id?: string;
  element?: string;
  element_type?: string;
}

export interface RawEventFields {
  value?: number;
  on?: boolean;
  dwell?: number;
  // ui_snapshot_taken ledger fields
  key?: string;
  hash?: string;
  nodes?: number;
  width?: number;
  height?: number;
  owner?: string;
  platform?: string;
  screen?: string;
}

export interface RawEvent {
  measurement: MeasurementName;
  /** Nanoseconds since the Unix epoch (line-protocol precision). */
  timestampNs: bigint;
  tags: RawEventTags;
  fields: RawEventFields;
}

export interface RawEventResult {
  events: RawEvent[];
  /** Lines/rows that could not be parsed; reported, never silently dropped … */
  malformedCount: number;
  /** … but if a whole request failed, `error` carries the structured reason. */
  error?: SourceError;
}

export interface SourceError {
  code: string;
  message: string;
  /** HTTP status for REST surface (400/502/503). */
  httpStatus: 400 | 404 | 502 | 503;
  /** Optional source-specific detail (URL, file path, upstream message). */
  detail?: string;
}

export type SourceId = "influx" | "lp-files";

export interface SourceStatus {
  id: SourceId;
  available: boolean;
  state: "ok" | "degraded" | "unavailable" | "unconfigured";
  message?: string;
  /** Cheap measurable facts about the source (counts, root, endpoint …). */
  facts: Record<string, string | number | null>;
}

export interface FetchOptions {
  /** Restrict to specific sessions (e.g. to avoid double-counting merged sources). */
  sessionIds?: string[];
  fromNs?: bigint;
  toNs?: bigint;
}

export interface SourceProvider {
  readonly id: SourceId;
  /** Self-description used by `GET /api/sources`. */
  describe(): Promise<SourceStatus>;
  /** Fetch every relevant point. Returns partial results with structured errors. */
  fetchEvents(options?: FetchOptions): Promise<RawEventResult>;
}

/** One open/close cycle of a view inside a session. */
export interface SessionViewSpan {
  view: string;
  viewId: string | null;
  openNs: bigint;
  closeNs: bigint | null;
  dwellSeconds: number | null;
}

/** A snapshot artifact recorded in the `ui_snapshot_taken` ledger. */
export interface SnapshotLedgerEntry {
  timestampNs: bigint;
  view: string | null;
  viewId: string | null;
  /** Storage key (`snapshots/<yyyy>/<mm>/<dd>/<file>.yaml[.gz]`). Lookup hint only. */
  key: string | null;
  /** SHA-256 of the written bytes — the join key. */
  hash: string | null;
  nodes: number | null;
  width: number | null;
  height: number | null;
}

/** Projected session (light for lists, with `events`/`snapshots` for detail). */
export interface Session {
  id: string;
  /** Which provider's data actually built this session. */
  origin: SourceId | "unknown";
  startNs: bigint | null;
  endNs: bigint | null;
  firstEventNs: bigint | null;
  lastEventNs: bigint | null;
  /** end (or last event) minus start (or first event); null when degenerate. */
  durationNs: bigint | null;
  eventCount: number;
  snapshotCount: number;
  /** Owner info from the ledger — never derived from snapshot YAML. */
  owner: string | null;
  platform: string | null;
  screen: string | null;
  views: SessionViewSpan[];
  snapshots: SnapshotLedgerEntry[];
  eventCountsByType: Record<string, number>;
  /** View-open events still open at the end of the data. */
  openViewCount: number;
}
