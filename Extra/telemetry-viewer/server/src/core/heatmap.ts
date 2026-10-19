/**
 * Aggregate heatmap builder — P3, plan §6.3 + §7 mode A (common-only).
 *
 * Selected sessions (explicit ids or a UTC range) are folded into one read
 * model:
 *
 * - every interaction event (`click`/`toggle`/`close`/`backdrop_click`) is
 *   resolved via the exact §6.1 rule used by the timeline playhead — latest
 *   ledger anchor of the same `view_id` at or before the event — and then by
 *   id-join onto the parsed snapshot's node (`element` tag = runtime `_id`);
 * - the matched node's canonical key (§6.2) accumulates the count, so the
 *   *same logical element* sums across sessions despite different runtime
 *   `_id`s;
 * - mode A counts only canonical keys present in **all** structure versions
 *   of their viewKey (intersection, computed from structure fingerprints);
 *   keys that exist in some-but-not-all versions are quantified (badge) and
 *   excluded from the counts;
 * - events that cannot be resolved at all are never dropped: they land in
 *   the `unresolved` bucket grouped by view + `element_type` only (§6.1/§6.2);
 * - each viewKey gets a **template snapshot**: the latest snapshot whose
 *   structure covers the whole intersecting key set (§7 A). Selection is a
 *   pure function of data content (timestamp, tie-broken by hash), so the
 *   same query always renders the same geometry (test-locked stability).
 */
import type { ParsedSnapshot } from "../snapshots/parse.js";
import type { RawEvent, Session, SnapshotLedgerEntry } from "../domain.js";
import { findPriorAnchor } from "./timeline.js";
import {
  buildCanonicalIndex,
  nodeIdForCanonicalKey,
  UNKNOWN_VIEW,
  type CanonicalConfidence,
} from "./canonical.js";
import {
  clusterPerViewKey,
  compareKeys,
  hiddenKeysOf,
  type VersionedSnapshotRef,
} from "./fingerprint.js";

/** Interaction event types the aggregate counts (timeline lanes minus views). */
export const AGGREGATE_EVENT_TYPES = ["click", "toggle", "close", "backdrop_click"] as const;

export type UnresolvedReason = "no-snapshot" | "snapshot-unavailable" | "element-missing";

export interface SnapshotLoadResult {
  parsed: ParsedSnapshot | null;
  /** Failure code from the resolution layer (for warnings); null when OK. */
  errorCode: string | null;
}

/** Resolve one ledger anchor to its parsed snapshot (bounded LRU in the API layer). */
export type SnapshotLoader = (
  entry: SnapshotLedgerEntry & { sessionId: string },
) => Promise<SnapshotLoadResult>;

export interface AggregateInput {
  /** Selected sessions, with their producing provider's events. */
  sessions: readonly Session[];
  eventsBySession: Map<string, readonly RawEvent[]>;
  loadSnapshot: SnapshotLoader;
  /** Concurrency for snapshot resolution (I/O bound; default 6). */
  concurrency?: number;
}

export interface AggregateCountRow {
  key: string;
  count: number;
  elementType: string | null;
  /** Leaf label of the canonical key (element display name or fallback). */
  leafLabel: string;
  /** Most degraded confidence seen for this key (`exact` ⊇ `approximate`). */
  confidence: CanonicalConfidence;
  /** Node id of the key inside the viewKey's template snapshot (overlay target). */
  templateNodeId: string | null;
  /** Template node rect size, for the CSV `dimensions` column. */
  dimensions: { width: number | null; height: number | null } | null;
}

/** Resolved parsed snapshot + its ledger identity (the template payload). */
export interface AggregateTemplate {
  hash: string | null;
  storageKey: string | null;
  viewId: string | null;
  parsed: ParsedSnapshot;
}

export interface AggregateViewInfo {
  viewKey: string;
  divergent: boolean;
  versionCount: number;
  /** Intersected (counted) canonical keys in mode A. */
  intersectionKeyCount: number;
  /** Keys that exist in some-but-not-all versions → hidden from the counts. */
  hiddenKeyCount: number;
  hiddenEventCount: number;
  counts: AggregateCountRow[];
  template: AggregateTemplate | null;
}

export interface AggregateUnresolvedRow {
  view: string;
  elementType: string;
  count: number;
  reasons: Record<UnresolvedReason, number>;
}

export interface AggregateResult {
  mode: "a";
  totals: {
    sessions: number;
    interactionEvents: number;
    resolvedEvents: number;
    /** Mode A hidden events (keyed events outside the intersection). */
    hiddenEvents: number;
    unresolvedEvents: number;
    viewKeys: number;
    divergentViewKeys: number;
    /** Distinct hidden keys across all viewKeys (the badge's M). */
    hiddenKeys: number;
  };
  views: AggregateViewInfo[];
  unresolved: AggregateUnresolvedRow[];
  /** Snapshot resolution problems; capped for payload sanity. */
  warnings: string[];
}

export type CanonicalIndexFor = ReturnType<typeof buildCanonicalIndex>;

const INTERACTION_TYPES = new Set<string>(AGGREGATE_EVENT_TYPES);

/** Ledger join key: content hash when present, storage key as the fallback. */
function dedupeKeyOf(hash: string | null, key: string | null): string {
  return hash !== null && hash !== "" ? hash : `key:${key ?? ""}`;
}

export async function buildAggregate(input: AggregateInput): Promise<AggregateResult> {
  const warnings: string[] = [];
  const pushWarning = (message: string): void => {
    if (warnings.length < 50) warnings.push(message);
  };

  /* ---- 1. collect every ledger anchor of the selected sessions ------------ */

  interface AnchorRef extends SnapshotLedgerEntry {
    sessionId: string;
  }
  const anchors: AnchorRef[] = [];
  for (const session of input.sessions) {
    for (const anchor of session.snapshots) anchors.push({ ...anchor, sessionId: session.id });
  }

  // Same bytes may be captured in several sessions — one document, one parse.
  const anchorByDedupe = new Map<string, AnchorRef>();
  for (const anchor of anchors) {
    const dedupeKey = dedupeKeyOf(anchor.hash, anchor.key);
    if (!anchorByDedupe.has(dedupeKey)) anchorByDedupe.set(dedupeKey, anchor);
  }

  /* ---- 2. resolve + parse + index snapshots (bounded concurrency) --------- */

  const parsedByDedupe = new Map<string, ParsedSnapshot | null>();
  const errorCodeByDedupe = new Map<string, string>();

  const loadOne = async (anchor: AnchorRef): Promise<void> => {
    const dedupeKey = dedupeKeyOf(anchor.hash, anchor.key);
    if (parsedByDedupe.has(dedupeKey)) return;
    try {
      const result = await input.loadSnapshot(anchor);
      parsedByDedupe.set(dedupeKey, result.parsed);
      if (result.errorCode !== null) errorCodeByDedupe.set(dedupeKey, result.errorCode);
    } catch (error) {
      // The loader contract covers failures; a throw still degrades honestly.
      parsedByDedupe.set(dedupeKey, null);
      errorCodeByDedupe.set(dedupeKey, error instanceof Error ? error.message : String(error));
    }
  };

  const pending = [...anchorByDedupe.values()];
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 6, pending.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < pending.length) {
        const anchor = pending[cursor++]!;
        await loadOne(anchor);
      }
    }),
  );

  /* ---- 3. canonical indexes + structure-version clustering ---------------- */

  const indexByDedupe = new Map<string, CanonicalIndexFor>();
  const versionedRefs: VersionedSnapshotRef[] = [];
  for (const [dedupeKey, parsed] of parsedByDedupe) {
    if (parsed === null) continue;
    const index = buildCanonicalIndex(parsed);
    indexByDedupe.set(dedupeKey, index);
    const anchor = anchorByDedupe.get(dedupeKey)!;
    versionedRefs.push({
      hash: anchor.hash ?? dedupeKey,
      viewKey: index.viewKey,
      timestampNs: anchor.timestampNs,
      index,
    });
  }

  for (const [dedupeKey, errorCode] of errorCodeByDedupe) {
    const anchor = anchorByDedupe.get(dedupeKey);
    if (anchor === undefined || parsedByDedupe.get(dedupeKey) !== null) continue;
    pushWarning(
      `snapshot unavailable for session ${anchor.sessionId} (view ${anchor.view ?? "?"}): ${errorCode || "unknown error"}`,
    );
  }

  const clusters = clusterPerViewKey(versionedRefs);

  interface ViewKeyBuild {
    viewKey: string;
    intersection: Set<string> | null;
    hidden: Set<string>;
  }
  const viewBuilds = new Map<string, ViewKeyBuild>();
  for (const ref of versionedRefs) {
    if (!viewBuilds.has(ref.viewKey)) {
      viewBuilds.set(ref.viewKey, { viewKey: ref.viewKey, intersection: null, hidden: new Set() });
    }
  }
  for (const [viewKey, build] of viewBuilds) {
    const versions = clusters.get(viewKey) ?? [];
    const hidden = hiddenKeysOf(versions);
    build.intersection = hidden.intersection;
    build.hidden = hidden.hidden;
  }

  /* ---- 4. count interaction events by canonical key ----------------------- */

  interface RowAcc {
    count: number;
    elementTypes: Map<string, number>;
    leafLabel: string;
    confidence: CanonicalConfidence;
  }
  const rowsByViewKey = new Map<string, Map<string, RowAcc>>();
  const hiddenByViewKey = new Map<string, Map<string, number>>();
  const unresolvedMap = new Map<string, AggregateUnresolvedRow>();
  let interactionEvents = 0;
  let resolvedEvents = 0;
  let hiddenEvents = 0;
  let unresolvedEvents = 0;

  const noteUnresolved = (view: string | null, elementType: string | null, reason: UnresolvedReason): void => {
    unresolvedEvents++;
    const mapKey = `${view ?? UNKNOWN_VIEW}\u241F${elementType ?? "(unknown type)"}`;
    let row = unresolvedMap.get(mapKey);
    if (row === undefined) {
      row = {
        view: view ?? UNKNOWN_VIEW,
        elementType: elementType ?? "(unknown type)",
        count: 0,
        reasons: { "no-snapshot": 0, "snapshot-unavailable": 0, "element-missing": 0 },
      };
      unresolvedMap.set(mapKey, row);
    }
    row.count++;
    row.reasons[reason]++;
  };

  for (const session of input.sessions) {
    const events = input.eventsBySession.get(session.id) ?? [];

    // §6.1 anchor index: per view_id, ledger anchors in time order.
    const anchorsByView = new Map<string, SnapshotLedgerEntry[]>();
    for (const anchor of session.snapshots) {
      if (anchor.viewId === null) continue;
      let list = anchorsByView.get(anchor.viewId);
      if (list === undefined) {
        list = [];
        anchorsByView.set(anchor.viewId, list);
      }
      list.push(anchor);
    }

    for (const event of events) {
      if (event.measurement !== "ui_event") continue;
      const type = event.tags.type ?? "";
      if (!INTERACTION_TYPES.has(type)) continue;
      interactionEvents++;

      const viewId = event.tags.view_id;
      const anchorList = viewId !== undefined && viewId !== "" ? anchorsByView.get(viewId) : undefined;
      const anchorPosition = anchorList === undefined ? null : findPriorAnchor(anchorList, event.timestampNs);
      const anchor = anchorPosition !== null ? anchorList![anchorPosition]! : null;

      if (anchor === null) {
        noteUnresolved(event.tags.view ?? null, event.tags.element_type ?? null, "no-snapshot");
        continue;
      }
      const dedupeKey = dedupeKeyOf(anchor.hash, anchor.key);
      const index = indexByDedupe.get(dedupeKey);
      if (index === undefined) {
        // Snapshot bytes unresolvable/unparseable — honestly degraded.
        noteUnresolved(event.tags.view ?? null, event.tags.element_type ?? null, "snapshot-unavailable");
        continue;
      }
      const elementId = event.tags.element ?? "";
      if (elementId === "") {
        noteUnresolved(event.tags.view ?? null, event.tags.element_type ?? null, "element-missing");
        continue;
      }
      const entry = index.byNodeId.get(elementId);
      if (entry === undefined) {
        noteUnresolved(event.tags.view ?? null, event.tags.element_type ?? null, "element-missing");
        continue;
      }

      const viewKey = entry.viewKey;
      const build = viewBuilds.get(viewKey)!;

      if (build.hidden.has(entry.key)) {
        // Mode A: outside the intersection → quantified, not counted.
        hiddenEvents++;
        let perKey = hiddenByViewKey.get(viewKey);
        if (perKey === undefined) {
          perKey = new Map();
          hiddenByViewKey.set(viewKey, perKey);
        }
        perKey.set(entry.key, (perKey.get(entry.key) ?? 0) + 1);
        continue;
      }

      let rows = rowsByViewKey.get(viewKey);
      if (rows === undefined) {
        rows = new Map();
        rowsByViewKey.set(viewKey, rows);
      }
      let row = rows.get(entry.key);
      if (row === undefined) {
        row = { count: 0, elementTypes: new Map(), leafLabel: entry.leafLabel, confidence: "exact" };
        rows.set(entry.key, row);
      }
      row.count++;
      const reportedType = event.tags.element_type ?? entry.elementType ?? "(unknown type)";
      row.elementTypes.set(reportedType, (row.elementTypes.get(reportedType) ?? 0) + 1);
      if (entry.confidence === "approximate") row.confidence = "approximate";
      resolvedEvents++;
    }
  }

  /* ---- 5. assemble view payloads with deterministic templates ------------- */

  const views: AggregateViewInfo[] = [];
  for (const [viewKey, build] of [...viewBuilds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const versions = clusters.get(viewKey) ?? [];
    const intersection = build.intersection;
    if (intersection === null) continue; // unreachable: every build had ≥1 ref

    // Template: latest snapshot (by data content, hash-tiebreak) whose key set
    // *covers the whole intersection* (⊇). Non-divergent viewKeys: each
    // snapshot carries exactly one version, which trivially covers itself.
    let templateRef: { dedupeKey: string; hash: string | null; timestampNs: bigint } | null = null;
    for (const cluster of versions) {
      const keys = new Set(cluster.keys);
      const coversAll =
        versions.length === 1 || [...intersection].every((key) => keys.has(key));
      if (!coversAll) continue;
      for (const snap of cluster.snapshots) {
        if (parsedByDedupe.get(snap.hash) == null) continue;
        if (
          templateRef === null ||
          snap.timestampNs > templateRef.timestampNs ||
          (snap.timestampNs === templateRef.timestampNs &&
            templateRef.hash !== null &&
            snap.hash < templateRef.hash)
        ) {
          templateRef = { dedupeKey: snap.hash, hash: snap.hash, timestampNs: snap.timestampNs };
        }
      }
    }

    let template: AggregateTemplate | null = null;
    let templateIndex: CanonicalIndexFor | null = null;
    if (templateRef !== null) {
      const parsed = parsedByDedupe.get(templateRef.dedupeKey) ?? null;
      const anchor = anchorByDedupe.get(templateRef.dedupeKey);
      if (parsed !== null && anchor !== undefined) {
        templateIndex = indexByDedupe.get(templateRef.dedupeKey) ?? null;
        template = {
          hash: anchor.hash,
          storageKey: anchor.key,
          viewId: anchor.viewId,
          parsed,
        };
      } else {
        pushWarning(`template snapshot for view ${viewKey} could not be loaded.`);
      }
    }

    const counts: AggregateCountRow[] = [];
    const rows = rowsByViewKey.get(viewKey);
    if (rows !== undefined) {
      const templateDedupe = templateRef?.dedupeKey ?? null;
      const templateParsed = templateDedupe !== null ? parsedByDedupe.get(templateDedupe) ?? null : null;
      for (const key of [...rows.keys()].sort(compareKeys)) {
        const row = rows.get(key)!;
        if (!intersection.has(key)) continue; // defensive: mode A scope
        let templateNodeId: string | null = null;
        let dimensions: AggregateCountRow["dimensions"] = null;
        if (templateIndex !== null && templateParsed !== null) {
          const nodeId = nodeIdForCanonicalKey(templateIndex, key);
          if (nodeId !== null) {
            templateNodeId = nodeId;
            const node = templateParsed.nodes.find((candidate) => String(candidate.id) === nodeId);
            const width = typeof node?.rect?.width === "number" ? node.rect.width : null;
            const height = typeof node?.rect?.height === "number" ? node.rect.height : null;
            if (width !== null || height !== null) dimensions = { width, height };
          }
        }
        counts.push({
          key,
          count: row.count,
          elementType: dominant(row.elementTypes),
          leafLabel: row.leafLabel,
          confidence: row.confidence,
          templateNodeId,
          dimensions,
        });
      }
    }

    views.push({
      viewKey,
      divergent: versions.length > 1,
      versionCount: versions.length,
      intersectionKeyCount: intersection.size,
      hiddenKeyCount: build.hidden.size,
      hiddenEventCount: sumHidden(hiddenByViewKey.get(viewKey) ?? new Map()),
      counts,
      template,
    });
  }

  /* ---- 6. totals ----------------------------------------------------------- */

  let divergentViewKeys = 0;
  let hiddenKeys = 0;
  for (const view of views) {
    if (view.divergent) divergentViewKeys++;
    hiddenKeys += view.hiddenKeyCount;
  }

  return {
    mode: "a",
    totals: {
      sessions: input.sessions.length,
      interactionEvents,
      resolvedEvents,
      hiddenEvents,
      unresolvedEvents,
      viewKeys: views.length,
      divergentViewKeys,
      hiddenKeys,
    },
    views,
    unresolved: [...unresolvedMap.values()].sort(
      (a, b) => b.count - a.count || a.view.localeCompare(b.view) || a.elementType.localeCompare(b.elementType),
    ),
    warnings,
  };

  function sumHidden(perKey: Map<string, number>): number {
    let sum = 0;
    for (const count of perKey.values()) sum += count;
    return sum;
  }

  function dominant(elementTypes: Map<string, number>): string | null {
    let best: string | null = null;
    let bestCount = -1;
    for (const [type, count] of [...elementTypes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (count > bestCount) {
        best = type;
        bestCount = count;
      }
    }
    return best;
  }
}

/* -------------------------------------------------------------------------- */
/* CSV export (plan §8 + P3 acceptance: exact header, RFC-4180 quoting).       */
/* -------------------------------------------------------------------------- */

export const AGGREGATE_CSV_HEADER = "canonicalKey,view,viewId,element,count,dimensions" as const;

/**
 * RFC-4180 CSV of the resolved (canonical-keyed) counts. Unresolved events do
 * not carry a canonical key, so they stay in the JSON payload (per §8 the CSV
 * is the aggregate table, not the diagnostics dump).
 *
 * Columns: `canonicalKey,view,viewId,element,count,dimensions`
 * - `view`       = the canonical viewKey
 * - `viewId`     = the template snapshot's `view_id` (or "")
 * - `element`    = the key's leaf label (display name or fallback segment)
 * - `dimensions` = template node rect as `<width>x<height>` (or "")
 */
export function aggregateToCsv(result: AggregateResult): string {
  const lines: string[] = [AGGREGATE_CSV_HEADER];
  for (const view of result.views) {
    const viewId = view.template?.viewId ?? "";
    for (const row of [...view.counts].sort((a, b) => b.count - a.count || compareKeys(a.key, b.key))) {
      const dimensions =
        row.dimensions === null || (row.dimensions.width === null && row.dimensions.height === null)
          ? ""
          : `${row.dimensions.width ?? ""}x${row.dimensions.height ?? ""}`;
      lines.push(
        [row.key, view.viewKey, viewId, row.leafLabel, String(row.count), dimensions]
          .map(csvField)
          .join(","),
      );
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** RFC-4180 §2.6/§2.7: quote when the field contains any special character. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
