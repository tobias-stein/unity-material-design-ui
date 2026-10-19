/** `from`/`to`/`limit` query parsing for the REST surface. */
import { ApiError } from "./errorHandling.js";
import { rfc3339ToNs } from "../sources/csv.js";

export interface ParsedRangeQuery {
  q: string | undefined;
  fromMs: number | undefined;
  toMs: number | undefined;
  limit: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

export function parseRangeQuery(query: Record<string, unknown>): ParsedRangeQuery {
  const qRaw = query.q;
  const q = typeof qRaw === "string" && qRaw.trim() !== "" ? qRaw.trim() : undefined;
  const fromMs = parseTimeParam(query.from, "from");
  const toMs = parseTimeParam(query.to, "to");
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new ApiError("INVALID_RANGE", "`from` must not be after `to`.", 400);
  }
  const limitRaw = query.limit;
  let limit = DEFAULT_LIMIT;
  if (typeof limitRaw === "string" && limitRaw !== "") {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ApiError("INVALID_LIMIT", "`limit` must be a positive integer.", 400);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }
  return { q, fromMs, toMs, limit };
}

/**
 * Accepted shapes: epoch milliseconds (`1768471200000`), ISO date
 * (`2026-01-15`), or RFC3339 with optional nanoseconds.
 */
export function parseTimeParam(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new ApiError("INVALID_QUERY", `Query parameter "${name}" must be a string.`, 400);
  }
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) {
    return Number(value); // epoch ms
  }
  const ns = rfc3339ToNs(value);
  if (ns !== null) {
    return Number(ns / 1_000_000n);
  }
  // Bare ISO date
  const dateMs = Date.parse(`${value}${value.length === 10 ? "T00:00:00.000Z" : ""}`);
  if (Number.isFinite(dateMs)) return dateMs;
  throw new ApiError(
    "INVALID_TIME",
    `Query parameter "${name}" is not a valid time (use epoch ms, ISO date, or RFC3339).`,
    400,
  );
}

/** epoch ns → JSON-safe epoch ms (fractional ns truncates). */
export function nsToMs(ns: bigint | null): number | null {
  return ns === null ? null : Number(ns / 1_000_000n);
}
