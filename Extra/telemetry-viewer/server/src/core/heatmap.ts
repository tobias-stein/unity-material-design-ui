/**
 * Aggregate heatmap builder — P3/P4, plan §6.3 + §7 modes A/B/C.
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
 * - the counting loop is **mode-agnostic per event**: each resolved event
 *   also knows *which structure version* its snapshot belongs to (P4), so
 *   the mode assembly never re-parses anything;
 * - mode A (default) counts only canonical keys present in **all** structure
 *   versions of their viewKey (intersection); keys outside are quantified
 *   (badge) and excluded from the counts;
 * - mode B splits divergent viewKeys into per-version groups (own template +
 *   own counts); mode C folds other versions' events into a user-picked
 *   ground truth via longest-common-ancestry matching (§7, versioning.ts);
 * - events that cannot be resolved at all are never dropped: they land in
 *   the `unresolved` bucket grouped by view + `element_type` only (§6.1/§6.2);
 * - template snapshots are pure data-content picks (timestamp, hash
 *   tiebreak), so the same query always renders the same geometry.
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
import {
  buildVersionGroups,
  buildGroundTruthMerge,
  AggregateGroupError,
  type AggregateVersionGroup,
  type AggregateMerge,
  type VersionAssemblyContext,
  type VersionTemplate,
} from "./versioning.js";

/** Aggregate mode state machine (plan §7): default a; b via split; c via pick. */
export type AggregateMode = "a" | "b" | "c";

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
  /** Version mode (§7): `b` splits versions, `c` merges into a pick. Default a. */
  mode?: AggregateMode;
  /** Mode C pick: the ground-truth group (`<viewKey>`, version index). */
  groundTruth?: { viewKey: string; versionIndex: number } | null;
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
  /** Intersected (counted) canonical keys in mode A (0 for modes b/c). */
  intersectionKeyCount: number;
  /** Mode A only: keys existing in some-but-not-all versions. */
  hiddenKeyCount: number;
  hiddenEventCount: number;
  /**
   * Event-bearing (or, in a mode-C merge, ground-truth) count rows. Empty
   * for a divergent viewKey in mode B (see `versions`).
   */
  counts: AggregateCountRow[];
  template: AggregateTemplate | null;
  /** Modes B/C only: one group per structure version (divergent viewKeys). */
  versions: AggregateVersionGroup[] | null;
  /** Mode C only: the ground-truth merge of the picked viewKey. */
  merge: AggregateMerge | null;
}

export interface AggregateUnresolvedRow {
  view: string;
  elementType: string;
  count: number;
  reasons: Record<UnresolvedReason, number>;
}

export interface AggregateResult {
  mode: AggregateMode;
  totals: {
    sessions: number;
    interactionEvents: number;
    resolvedEvents: number;
    /** Mode A: hidden events (keyed events outside the intersection). */
    hiddenEvents: number;
    unresolvedEvents: number;
    viewKeys: number;
    divergentViewKeys: number;
    /** Distinct hidden keys across all viewKeys (mode-A badge's M; 0 in b/c). */
    hiddenKeys: number;
    /** Mode C: events folded into picked ground truths (sum over views). */
    foldedEvents: number;
    /** Mode C: events that stayed unmatched after the merge. */
    unmatchedEvents: number;
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

  // P4: per-snapshot version attribution — the counting loop below stamps
  // every event with the structure version its resolving snapshot belongs to,
  // which is what makes mode B/C counts event-faithful (never re-derived).
  const versionIndexByDedupe = new Map<string, { viewKey: string; versionIndex: number }>();
  for (const [viewKey, versionClusters] of clusters) {
    versionClusters.forEach((cluster, versionIndex) => {
      for (const snapshot of cluster.snapshots) {
        if (!versionIndexByDedupe.has(snapshot.hash)) {
          versionIndexByDedupe.set(snapshot.hash, { viewKey, versionIndex });
        }
      }
    });
  }

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
    /** Event counts per structure-version index (P4: B/C attribution). */
    perVersion: Map<number, number>;
    /** Dominant *node* types (canonical terminator, distinct from tags). */
    nodeTypes: Map<string, number>;
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
      const versionIndex = versionIndexByDedupe.get(dedupeKey);
      const shownVersion =
        versionIndex !== undefined && versionIndex.viewKey === viewKey ? versionIndex.versionIndex : null;

      // Row bookkeeping happens for every resolved event in every mode: the
      // mode assembly (nothing else) decides which slice is visible.
      let rows = rowsByViewKey.get(viewKey);
      if (rows === undefined) {
        rows = new Map();
        rowsByViewKey.set(viewKey, rows);
      }
      let row = rows.get(entry.key);
      if (row === undefined) {
        row = {
          count: 0,
          perVersion: new Map(),
          nodeTypes: new Map(),
          elementTypes: new Map(),
          leafLabel: entry.leafLabel,
          confidence: "exact",
        };
        rows.set(entry.key, row);
      }
      row.count++;
      if (shownVersion !== null) {
        row.perVersion.set(shownVersion, (row.perVersion.get(shownVersion) ?? 0) + 1);
      }
      if (entry.elementType !== null) {
        row.nodeTypes.set(entry.elementType, (row.nodeTypes.get(entry.elementType) ?? 0) + 1);
      }
      const reportedType = event.tags.element_type ?? entry.elementType ?? "(unknown type)";
      row.elementTypes.set(reportedType, (row.elementTypes.get(reportedType) ?? 0) + 1);
      if (entry.confidence === "approximate") row.confidence = "approximate";

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

      resolvedEvents++;
    }
  }

  /* ---- 5. assemble view payloads per mode (deterministic templates) ------- */

  const mode: AggregateMode = input.mode ?? "a";

  // Mode C: validate the ground-truth pick against the actual version
  // clusters up front — unknown viewKey / unknown ordinal / single-version
  // viewKey are all 400s (mapped by the API layer), never silent no-ops.
  if (mode === "c" && input.groundTruth !== null && input.groundTruth !== undefined) {
    const targetClusters = clusters.get(input.groundTruth.viewKey) ?? [];
    if (targetClusters.length === 0 || input.groundTruth.versionIndex >= targetClusters.length) {
      throw new AggregateGroupError(
        "AGGREGATE_GROUP_UNKNOWN",
        `Version group #${input.groundTruth.versionIndex} of "${input.groundTruth.viewKey}" does not exist in this selection (${targetClusters.length} versions: 0…${targetClusters.length - 1}).`,
      );
    }
    if (targetClusters.length < 2) {
      throw new AggregateGroupError(
        "AGGREGATE_GROUP_NOT_DIVERGENT",
        `"${input.groundTruth.viewKey}" has a single structure version — there is nothing to merge.`,
      );
    }
  }

  const versionTemplateOf = (snapshot: VersionedSnapshotRef): VersionTemplate | null => {
    const parsed = parsedByDedupe.get(snapshot.hash);
    const index = indexByDedupe.get(snapshot.hash);
    const anchor = anchorByDedupe.get(snapshot.hash);
    if (parsed === null || parsed === undefined || index === undefined || anchor === undefined) return null;
    return {
      hash: anchor.hash,
      storageKey: anchor.key,
      viewId: anchor.viewId,
      parsed,
      index: {
        nodeIdFor: (key) => index.byKey.get(key) ?? null,
        entryFor: (nodeId) => index.byNodeId.get(nodeId) ?? null,
      },
      dimensionsOf: (nodeId) => {
        if (nodeId === null) return null;
        const node = parsed.nodes.find((candidate) => String(candidate.id) === nodeId);
        const width = typeof node?.rect?.width === "number" ? node.rect.width : null;
        const height = typeof node?.rect?.height === "number" ? node.rect.height : null;
        if (width === null && height === null) return null;
        return { width, height };
      },
    };
  };

  const views: AggregateViewInfo[] = [];
  for (const [viewKey, build] of [...viewBuilds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const versions = clusters.get(viewKey) ?? [];
    const intersection = build.intersection;
    if (intersection === null) continue; // unreachable: every build had ≥1 ref
    const divergent = versions.length > 1;

    const assemblyContext: VersionAssemblyContext = {
      viewKey,
      clusters: versions,
      templateOf: versionTemplateOf,
      perVersion: perVersionOf(viewKey),
      warn: pushWarning,
    };

    // Mode B/C: divergent viewKeys split into per-version groups (§7 B);
    // the picked ground truth (§7 C) additionally folds the others in.
    if (divergent && (mode === "b" || mode === "c")) {
      let merge: AggregateMerge | null = null;
      let pickedTemplate: AggregateTemplate | null = null;
      if (mode === "c") {
        const groundTruth = input.groundTruth ?? null;
        if (groundTruth === null) {
          throw new AggregateGroupError(
            "AGGREGATE_GROUP_MISSING",
            'Mode c needs a `group=<viewKey>#<versionIndex>` pick (the id a mode-b response reports).',
          );
        }
        if (groundTruth.viewKey !== viewKey) {
          merge = null; // other divergent viewKeys stay in split rendering
        } else if (groundTruth.versionIndex < 0 || groundTruth.versionIndex >= versions.length) {
          throw new AggregateGroupError(
            "AGGREGATE_GROUP_UNKNOWN",
            `Version group #${groundTruth.versionIndex} of "${viewKey}" does not exist in this selection (${versions.length} versions: 0…${versions.length - 1}).`,
          );
        } else {
          merge = buildGroundTruthMerge(assemblyContext, groundTruth.versionIndex);
          const picked = versions[groundTruth.versionIndex]!;
          const latest = latestSnapshotOf(picked.snapshots);
          pickedTemplate = latest === null ? null : templateInfoOf(latest.hash);
        }
      }

      if (merge !== null) {
        views.push({
          viewKey,
          divergent,
          versionCount: versions.length,
          intersectionKeyCount: 0,
          hiddenKeyCount: 0,
          hiddenEventCount: 0,
          counts: merge.rows.map((row) => ({
            key: row.key,
            count: row.count,
            elementType: row.elementType,
            leafLabel: row.leafLabel,
            confidence: row.confidence,
            templateNodeId: row.templateNodeId,
            dimensions: row.dimensions,
          })),
          template: pickedTemplate,
          versions: null,
          merge,
        });
      } else {
        views.push({
          viewKey,
          divergent,
          versionCount: versions.length,
          intersectionKeyCount: versions.length === 1 ? intersection.size : 0,
          hiddenKeyCount: 0,
          hiddenEventCount: 0,
          counts: [],
          template: null,
          versions: buildVersionGroups(assemblyContext),
          merge: null,
        });
      }
      continue;
    }

    // Mode A (and non-divergent views of any mode): intersection counting +
    // the latest snapshot whose key set covers the whole intersection.
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
        if (mode === "a" && !intersection.has(key)) continue; // mode A scope
        if (mode !== "a" && row.count === 0) continue;
        if (mode === "a" && build.hidden.has(key)) continue; // defensive double-check
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
      divergent,
      versionCount: versions.length,
      intersectionKeyCount: intersection.size,
      hiddenKeyCount: build.hidden.size,
      hiddenEventCount: sumHidden(hiddenByViewKey.get(viewKey) ?? new Map()),
      counts,
      template,
      versions: null,
      merge: null,
    });
  }

  /* ---- 6. totals ----------------------------------------------------------- */

  let divergentViewKeys = 0;
  let hiddenKeys = 0;
  let foldedEvents = 0;
  let unmatchedEvents = 0;
  for (const view of views) {
    if (view.divergent) divergentViewKeys++;
    hiddenKeys += view.hiddenKeyCount;
    if (view.merge !== null) {
      foldedEvents += view.merge.foldedEvents;
      unmatchedEvents += view.merge.unmatchedEvents;
    }
  }

  return {
    mode,
    totals: {
      sessions: input.sessions.length,
      interactionEvents,
      // Modes B/C hide nothing: every keyed event is counted somewhere.
      resolvedEvents: mode === "a" ? resolvedEvents : resolvedEvents + hiddenEvents,
      hiddenEvents: mode === "a" ? hiddenEvents : 0,
      unresolvedEvents,
      viewKeys: views.length,
      divergentViewKeys,
      hiddenKeys: mode === "a" ? hiddenKeys : 0,
      foldedEvents,
      unmatchedEvents,
    },
    views,
    unresolved: [...unresolvedMap.values()].sort(
      (a, b) => b.count - a.count || a.view.localeCompare(b.view) || a.elementType.localeCompare(b.elementType),
    ),
    warnings,
  };

  /** Per-(key, version) event attribution of one viewKey (drops empties). */
  function perVersionOf(viewKey: string): Map<string, Map<number, number>> {
    const result = new Map<string, Map<number, number>>();
    for (const [key, row] of rowsByViewKey.get(viewKey) ?? []) {
      if (row.perVersion.size === 0) continue;
      result.set(key, row.perVersion);
    }
    return result;
  }

  /** The latest snapshot of a version cluster (timestamp, then hash). */
  function latestSnapshotOf(snapshots: readonly VersionedSnapshotRef[]): VersionedSnapshotRef | null {
    let best: VersionedSnapshotRef | null = null;
    for (const snapshot of snapshots) {
      if (
        best === null ||
        snapshot.timestampNs > best.timestampNs ||
        (snapshot.timestampNs === best.timestampNs && snapshot.hash < best.hash)
      ) {
        best = snapshot;
      }
    }
    return best;
  }

  /** Full template payload for a dedupe key, or null (warning already sent). */
  function templateInfoOf(dedupeKey: string): AggregateTemplate | null {
    const parsed = parsedByDedupe.get(dedupeKey) ?? null;
    const anchor = anchorByDedupe.get(dedupeKey);
    if (parsed === null || anchor === undefined) return null;
    return { hash: anchor.hash, storageKey: anchor.key, viewId: anchor.viewId, parsed };
  }

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
 * RFC-4180 CSV of the counted aggregates. Mode-dependent rows (§8's CSV is
 * the aggregate table, so unresolved diagnostics stay in the JSON payload):
 *
 * - **mode a** (unchanged P3 contract): one row per intersection key;
 * - **mode b**: one row per version key — `view` = `<viewKey>#<i>` (the
 *   group id), `viewId` = that version's template;
 * - **mode c**: merged ground-truth rows for the picked viewKey (`view` =
 *   the plain viewKey) plus its unmatched keys (`view` = `<viewKey>#<i>`,
 *   the source version); other viewKeys appear as in mode b.
 *
 * Zero-count rows never enter the CSV (it is a count table).
 * Columns: `canonicalKey,view,viewId,element,count,dimensions`
 */
export function aggregateToCsv(result: AggregateResult): string {
  const lines: string[] = [AGGREGATE_CSV_HEADER];
  for (const view of result.views) {
    // Merged ground truth (mode C pick): view column is the bare viewKey.
    for (const row of [...view.counts].sort((a, b) => b.count - a.count || compareKeys(a.key, b.key))) {
      if (row.count === 0 && view.merge !== null) continue; // structure-only rows (mode C) stay out
      const viewId = view.merge !== null ? (view.template?.viewId ?? "") : (view.template?.viewId ?? "");
      pushRow(lines, row.key, view.viewKey, viewId, row.leafLabel, row.count, row.dimensions);
    }
    for (const group of view.versions ?? []) {
      const viewId = group.template?.viewId ?? "";
      const viewLabel = `${view.viewKey}#${group.index}`;
      for (const row of [...group.counts].sort((a, b) => b.count - a.count || compareKeys(a.key, b.key))) {
        if (row.count === 0) continue;
        pushRow(lines, row.key, viewLabel, viewId, row.leafLabel, row.count, row.dimensions);
      }
    }
    if (view.merge !== null) {
      for (const row of view.merge.unmatched) {
        pushRow(lines, row.key, `${view.viewKey}#${row.versionIndex}`, "", row.leafLabel, row.count, null);
      }
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

function pushRow(
  lines: string[],
  key: string,
  view: string,
  viewId: string,
  element: string,
  count: number,
  dimensions: { width: number | null; height: number | null } | null,
): void {
  const dimensionsText =
    dimensions === null || (dimensions.width === null && dimensions.height === null)
      ? ""
      : `${dimensions.width ?? ""}x${dimensions.height ?? ""}`;
  lines.push([key, view, viewId, element, String(count), dimensionsText].map(csvField).join(","));
}

/** RFC-4180 §2.6/§2.7: quote when the field contains any special character. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
