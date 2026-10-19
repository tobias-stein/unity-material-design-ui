/** Aggregate selection query parsing (plan §8: `sessions=…` XOR `from/to`). */
import { ApiError } from "./errorHandling.js";
import { parseTimeParam } from "./queryParams.js";

/** Regex of a mode-C ground-truth pick: `<viewKey>#<versionIndex>`. */
const GROUP_PATTERN = /^([^#]+)#(\d+)$/u;

/** Aggregate selection caps: a local tool, but payload/parse work is real. */
export const MAX_AGGREGATE_SESSIONS = 100;

export type AggregateMode = "a" | "b" | "c";

/** A mode-C pick parsed *syntactically*; existence is checked against data. */
export interface GroundTruthPick {
  viewKey: string;
  versionIndex: number;
}

export interface AggregateQuery {
  /** Explicit session ids (mutually exclusive with the UTC range). */
  sessions: string[];
  /** UTC range (inclusive bounds, epoch ms) on session start. */
  fromMs: number | undefined;
  toMs: number | undefined;
  mode: AggregateMode;
  /** Mode C ground-truth pick (`group=<viewKey>#<versionIndex>`). */
  groundTruth: GroundTruthPick | null;
  /** Raw group string for echo in the selection DTO. */
  group: string | null;
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
  if (modeRaw !== "" && modeRaw !== "a" && modeRaw !== "b" && modeRaw !== "c") {
    throw new ApiError(
      "AGGREGATE_MODE_NOT_AVAILABLE",
      `Unknown aggregate mode "${modeRaw}" (available: a, b, c).`,
      400,
    );
  }
  if (modeRaw !== "") mode = modeRaw as AggregateMode;

  const groupRaw = typeof query.group === "string" ? query.group.trim() : "";
  let groundTruth: GroundTruthPick | null = null;
  let group: string | null = null;
  if (groupRaw !== "") {
    if (mode !== "c") {
      throw new ApiError(
        "AGGREGATE_GROUP_MODE_MISMATCH",
        '`group=` is the mode-C ground-truth pick (`<viewKey>#<versionIndex>`) — it needs `mode=c`.',
        400,
      );
    }
    const match = GROUP_PATTERN.exec(groupRaw);
    if (match === null) {
      throw new ApiError(
        "AGGREGATE_GROUP_INVALID",
        `Group pick must be \`<viewKey>#<versionIndex>\` (e.g. "mdu.ui.Dialog#1"); got: ${groupRaw}.`,
        400,
      );
    }
    groundTruth = { viewKey: match[1]!, versionIndex: Number.parseInt(match[2]!, 10) };
    group = groupRaw;
  }
  if (mode === "c" && groupRaw === "") {
    throw new ApiError(
      "AGGREGATE_GROUP_MISSING",
      'Mode c needs a `group=<viewKey>#<versionIndex>` pick — take the `groupId` of a version group from a mode-b response.',
      400,
    );
  }

  return { sessions, fromMs, toMs, mode, groundTruth, group };
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
