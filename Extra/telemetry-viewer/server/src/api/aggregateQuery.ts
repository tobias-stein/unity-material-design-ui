/** Aggregate selection query parsing (plan §8: `sessions=…` XOR `from/to`). */
import { ApiError } from "./errorHandling.js";
import { parseTimeParam } from "./queryParams.js";

/** Aggregate selection caps: a local tool, but payload/parse work is real. */
export const MAX_AGGREGATE_SESSIONS = 100;

export type AggregateMode = "a";

export interface AggregateQuery {
  /** Explicit session ids (mutually exclusive with the UTC range). */
  sessions: string[];
  /** UTC range (inclusive bounds, epoch ms) on session start. */
  fromMs: number | undefined;
  toMs: number | undefined;
  mode: AggregateMode;
}

export function parseAggregateQuery(query: Record<string, unknown>): AggregateQuery {
  const sessionsRaw = query.sessions;
  const sessions =
    typeof sessionsRaw === "string" && sessionsRaw.trim() !== ""
      ? dedupe(
          sessionsRaw
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id !== ""),
        )
      : [];

  const fromMs = parseTimeParam(query.from, "from");
  const toMs = parseTimeParam(query.to, "to");

  const hasRange = fromMs !== undefined || toMs !== undefined;
  if (sessions.length > 0 && hasRange) {
    throw new ApiError(
      "AGGREGATE_SELECTION_INVALID",
      'Choose either `sessions=` or a `from`/`to` range — not both.',
      400,
    );
  }
  if (sessions.length === 0 && !hasRange) {
    throw new ApiError(
      "AGGREGATE_SELECTION_MISSING",
      'Aggregate needs a selection: pass `sessions=<id,id,…>` or `from`/`to` (UTC).',
      400,
    );
  }
  if (sessions.length > MAX_AGGREGATE_SESSIONS) {
    throw new ApiError(
      "AGGREGATE_SELECTION_TOO_LARGE",
      `At most ${MAX_AGGREGATE_SESSIONS} sessions per aggregate query.`,
      400,
    );
  }
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new ApiError("INVALID_RANGE", "`from` must not be after `to`.", 400);
  }

  const modeRaw = typeof query.mode === "string" ? query.mode.trim() : "";
  let mode: AggregateMode = "a";
  if (modeRaw !== "" && modeRaw !== "a") {
    throw new ApiError(
      "AGGREGATE_MODE_NOT_AVAILABLE",
      modeRaw === "b" || modeRaw === "c"
        ? `Version mode "${modeRaw}" ships with P4 — mode A (common-only) is the only implemented surface.`
        : `Unknown aggregate mode "${modeRaw}".`,
      400,
    );
  }

  return { sessions, fromMs, toMs, mode };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
