/**
 * Aggregate version modes B + C (P4, plan §7).
 *
 * - **Mode B — version split.** Divergent viewKeys get one group per
 *   structure version (plan §6.2 fingerprints); each group carries its own
 *   template snapshot and its own counts, attributed by *which snapshot the
 *   interaction actually resolved through* — never re-parsed or inferred.
 *   Non-divergent viewKeys render exactly like mode A (§7 B's "in A" rule).
 * - **Mode C — ground-truth merge.** The user picks one version group as the
 *   ground truth. Its template geometry is the only geometry; every key of
 *   the *other* versions is matched onto a ground-truth key by the plan's
 *   **hierarchical longest-common-ancestry walk**: path segments must be
 *   equal at the same depth, compared **from the leaf upward** — this is
 *   what keeps a *moved* element (different ancestor chains, same leaf)
 *   matchable. Index-only fallback segments may wildcard against another
 *   fallback of the same `kind:type` at any depth, and against *any*
 *   segment when sitting at the **leaf** position and the canonical
 *   `elementType` matches (greedy, no weights, explainable). Matched counts
 *   fold into the ground truth; **unmatched keys never disappear** — they
 *   surface with their counts, and the fold always satisfies the invariant
 *   `Σ(merged counts) + Σ(unmatched counts) = all events of the viewKey`.
 *   Exiting C → B keeps the picked version (§7 C).
 */
import { CANONICAL_SEPARATOR, isFallbackSegment } from "./canonical.js";
import { compareKeys, type VersionedSnapshotRef } from "./fingerprint.js";
import type { ParsedSnapshot } from "../snapshots/parse.js";
import type { AggregateCountRow } from "./heatmap.js";

/** Structural metadata of one canonical key, derived from a parsed snapshot. */
export interface KeyMeta {
  key: string;
  elementType: string | null;
  leafLabel: string;
  confidence: "exact" | "approximate";
}

/* ------------------------------------------------------------------ matching */

export interface KeyMatch {
  /** The ground-truth canonical key the source folds into. */
  targetKey: string;
  /** Matched path segments (leaf upward, contiguous). ≥ 1. */
  matched: number;
  /** Path segments of the source key (excluding viewKey + terminator). */
  sourceSegments: number;
  /** Path segments of the matched ground-truth key. */
  targetSegments: number;
  /** How many matched segments came from a wildcard rule. */
  wildcards: number;
}

/** `kind:type[i]` minus its index — the identity of an index-only segment. */
function fallbackIdentity(segment: string): string | null {
  return isFallbackSegment(segment) ? segment.replace(/\[\d+\]$/, "") : null;
}

/**
 * One depth comparison of the walk. Rules (plan §7 C): same name/type at
 * the same depth; index-only segments wildcard against another index-only
 * segment of the same `kind:type` at any depth; the **leaf** index-only
 * segment wildcards fully when `elementType` matches (checked by caller).
 */
function segmentsMatch(
  source: string,
  target: string,
  atLeaf: boolean,
): { matched: true; wildcard: boolean } | { matched: false } {
  if (source === target) return { matched: true, wildcard: false };
  const sourceFallback = fallbackIdentity(source);
  const targetFallback = fallbackIdentity(target);
  if (sourceFallback !== null && targetFallback !== null && sourceFallback === targetFallback) {
    return { matched: true, wildcard: true }; // sibling index drift ok
  }
  if (atLeaf && (sourceFallback !== null || targetFallback !== null)) {
    return { matched: true, wildcard: true };
  }
  return { matched: false };
}

/**
 * Match one canonical key onto ground-truth candidates.
 *
 * Pre-filter: candidates must share the source's `elementType` (the key's
 * terminator; a key without one matches only keys without one). The walk
 * compares path segments from the leaf upward and stops at the first
 * mismatch (longest contiguous common ancestry). Greedy, deterministic
 * tie-break: max depth → fewer wildcards → lexicographically smallest key.
 * Returns null when no candidate shares as much as one path segment —
 * the key is **unmatched** and must be reported with its counts.
 */
export function matchCanonicalKey(
  sourceKey: string,
  sourceElementType: string | null,
  candidates: readonly KeyMeta[],
): KeyMatch | null {
  const sourceParts = canonicalKeyParts(sourceKey);
  const sourceViewKey = sourceParts[0] ?? "";
  const sourcePath = stripElementType(sourceParts, sourceElementType);

  let best: { candidate: KeyMeta; matched: number; wildcards: number; targetSegments: number } | null = null;
  for (const candidate of candidates) {
    if (!elementsCompatible(sourceElementType, candidate.elementType)) continue;
    const candidateParts = canonicalKeyParts(candidate.key);
    if (candidateParts[0] !== sourceViewKey) continue;
    const candidatePath = stripElementType(candidateParts, candidate.elementType);

    if (sourcePath.length === 0) {
      // Degenerate key with no path segments at all: only an identical
      // (viewKey, elementType) pair is an honest match.
      if (candidatePath.length !== 0) continue;
      const wins =
        best === null || compareKeys(candidate.key, best.candidate.key) < 0;
      if (wins) {
        best = { candidate, matched: 0, wildcards: 0, targetSegments: 0 };
      }
      continue;
    }

    let matched = 0;
    let wildcards = 0;
    let s = sourcePath.length - 1;
    let t = candidatePath.length - 1;
    while (s >= 0 && t >= 0) {
      const atLeaf = s === sourcePath.length - 1 && t === candidatePath.length - 1;
      const result = segmentsMatch(sourcePath[s]!, candidatePath[t]!, atLeaf);
      if (!result.matched) break;
      matched++;
      if (result.wildcard) wildcards++;
      s--;
      t--;
    }
    if (matched === 0) continue; // elementType alone is not an identity
    if (
      best === null ||
      matched > best.matched ||
      (matched === best.matched &&
        (wildcards < best.wildcards ||
          (wildcards === best.wildcards && compareKeys(candidate.key, best.candidate.key) < 0)))
    ) {
      best = { candidate, matched, wildcards, targetSegments: candidatePath.length };
    }
  }

  if (best === null) return null;
  return {
    targetKey: best.candidate.key,
    matched: best.matched,
    sourceSegments: sourcePath.length,
    targetSegments: best.targetSegments,
    wildcards: best.wildcards,
  };
}

function elementsCompatible(a: string | null, b: string | null): boolean {
  return (a === null && b === null) || (a !== null && a === b);
}

/** Split a canonical key at the separator. */
export function canonicalKeyParts(key: string): string[] {
  return key.split(CANONICAL_SEPARATOR);
}

/** Path segments = everything between the viewKey and the type terminator. */
export function stripElementType(parts: readonly string[], elementType: string | null): string[] {
  if (elementType !== null && parts[parts.length - 1] === elementType) return parts.slice(1, -1);
  return parts.slice(1);
}

/* -------------------------------------------------------- version group I/O */

export type CanonicalEntryLike = {
  elementType: string | null;
  leafLabel: string;
  confidence: "exact" | "approximate";
};

/** Node id of a canonical key inside a parsed snapshot's canonical index. */
export type CanonicalIndexLookup = {
  nodeIdFor(key: string): string | null;
  entryFor(nodeId: string): CanonicalEntryLike | null;
};

/** One resolved template snapshot with its lookup structures. */
export interface VersionTemplate {
  hash: string | null;
  storageKey: string | null;
  viewId: string | null;
  parsed: ParsedSnapshot;
  index: CanonicalIndexLookup;
  dimensionsOf(nodeId: string | null): { width: number | null; height: number | null } | null;
}

/** Assembly inputs the shared counting loop prepares for this viewKey. */
export interface VersionAssemblyContext {
  viewKey: string;
  /** The viewKey's clusters, first-occurrence sorted (fingerprint module). */
  clusters: ReadonlyArray<{
    fingerprint: string;
    keys: readonly string[];
    snapshots: readonly VersionedSnapshotRef[];
  }>;
  /** Resolve a cluster snapshot into its template payload (+ lookups). */
  templateOf: (snapshot: VersionedSnapshotRef) => VersionTemplate | null;
  /** Event counts per (key, versionIndex) for this viewKey. */
  perVersion: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** Warning collector (bounded upstream). */
  warn: (message: string) => void;
}

/** One structure-version group of a divergent viewKey (mode B/C payload). */
export interface AggregateVersionGroup {
  /** Chronological ordinal (first-occurrence order, deterministic). */
  index: number;
  /** Stable group id: `<viewKey>#<index>` — the mode-C query param. */
  groupId: string;
  viewKey: string;
  fingerprint: string;
  snapshotCount: number;
  /** Distinct canonical keys *of this version only* (sorted). */
  keys: string[];
  keyCount: number;
  /** Count rows attributed to this version, incl. zero-count structure rows. */
  counts: AggregateCountRow[];
  /** Events whose resolving snapshot belongs to this version. */
  eventCount: number;
  /** ⊕/⊖ diff vs the *earliest* version (§7 B), full keys for tooltips. */
  addedKeys: string[];
  removedKeys: string[];
  template: {
    hash: string | null;
    storageKey: string | null;
    viewId: string | null;
  } | null;
}

export interface AggregateFoldEntry {
  /** The other version's canonical key that folded here (explainable). */
  key: string;
  versionIndex: number;
  count: number;
  /** Longest-common-ancestry depth (≥ 1 path segment matched). */
  matched: number;
  wildcards: number;
}

export interface AggregateMergeRow extends AggregateCountRow {
  /** Own (ground-truth version) share of `count`. */
  ownCount: number;
  /** Explainable fold receipts from the other versions. */
  folded: AggregateFoldEntry[];
}

export interface AggregateUnmatchedRow {
  key: string;
  versionIndex: number;
  count: number;
  leafLabel: string;
  elementType: string | null;
}

export interface AggregateMerge {
  groupId: string;
  viewKey: string;
  groundTruthIndex: number;
  fingerprint: string;
  /** Ground-truth rows: own + folded counts (incl. zero-count keys). */
  rows: AggregateMergeRow[];
  /** (key, version) pairs that matched nothing — never silently dropped. */
  unmatched: AggregateUnmatchedRow[];
  /** Events folded from other versions. */
  foldedEvents: number;
  unmatchedEvents: number;
}

/** Failure of a mode-C pick against the actual data (mapped to a 400). */
export class AggregateGroupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AggregateGroupError";
  }
}

/* ----------------------------------------------------------------- assembly */

/** Latest snapshot of a cluster (timestamp, then hash — stable). */
function latestIn(snapshots: readonly VersionedSnapshotRef[]): VersionedSnapshotRef | null {
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

/** Key → visual metadata for one version, derived from its own template. */
function keyMetasFor(cluster: { keys: readonly string[] }, template: VersionTemplate | null): Map<string, KeyMeta> {
  const metas = new Map<string, KeyMeta>();
  if (cluster === undefined || template === null) return metas;
  for (const key of cluster.keys) {
    const nodeId = template.index.nodeIdFor(key);
    const entry = nodeId === null ? null : template.index.entryFor(nodeId);
    if (entry !== null) {
      metas.set(key, {
        key,
        elementType: entry.elementType,
        leafLabel: entry.leafLabel,
        confidence: entry.confidence,
      });
    } else {
      // Defensive: derive a plain label from the canonical key itself.
      const parts = canonicalKeyParts(key);
      metas.set(key, {
        key,
        elementType: null,
        leafLabel: parts[parts.length - 1] ?? key,
        confidence: "exact",
      });
    }
  }
  return metas;
}

/** Mode B (§7): one group per structure version, own template + counts. */
export function buildVersionGroups(ctx: VersionAssemblyContext): AggregateVersionGroup[] {
  const groups: AggregateVersionGroup[] = [];
  const earliest = ctx.clusters[0];
  const earliestKeys = new Set(earliest?.keys ?? []);

  ctx.clusters.forEach((cluster, index) => {
    const snapshot = latestIn(cluster.snapshots);
    const template = snapshot === null ? null : ctx.templateOf(snapshot);
    if (template === null) {
      ctx.warn(`template for version ${index} of "${ctx.viewKey}" could not be loaded; a group counts without overlay geometry.`);
    }
    const metas = keyMetasFor(cluster, template);

    const counts: AggregateVersionGroup["counts"] = [];
    const clusterKeys = [...cluster.keys].sort(compareKeys);
    let eventCount = 0;
    for (const key of clusterKeys) {
      const perVersion = ctx.perVersion.get(key);
      const versionCount = perVersion?.get(index) ?? 0;
      eventCount += versionCount;
      const meta = metas.get(key);
      const parts = canonicalKeyParts(key);
      const templateNodeId =
        template === null ? null : (template.index.nodeIdFor(key) ?? null);
      counts.push({
        key,
        count: versionCount,
        elementType: meta?.elementType ?? null,
        leafLabel: meta?.leafLabel ?? parts[parts.length - 1] ?? key,
        confidence: meta?.confidence ?? "exact",
        templateNodeId,
        dimensions: template === null ? null : template.dimensionsOf(templateNodeId),
      });
    }

    const keys = new Set(cluster.keys);
    groups.push({
      index,
      groupId: `${ctx.viewKey}#${index}`,
      viewKey: ctx.viewKey,
      fingerprint: cluster.fingerprint,
      snapshotCount: cluster.snapshots.length,
      keys: clusterKeys,
      keyCount: cluster.keys.length,
      counts,
      eventCount,
      addedKeys: cluster.keys.filter((key) => !earliestKeys.has(key)).sort(compareKeys),
      removedKeys: [...earliestKeys].filter((key) => !keys.has(key)).sort(compareKeys),
      template:
        template === null
          ? null
          : { hash: template.hash, storageKey: template.storageKey, viewId: template.viewId },
    });
  });
  return groups;
}

/**
 * Mode C (§7): fold the other versions' event counts into the picked
 * ground-truth version. Ground-truth geometry only; unmatched keys land in
 * the dedicated panel. Invariant: `Σrows(count) + Σunmatched(count)` equals
 * every event the viewKey resolved (own + folded + unmatched partition).
 */
export function buildGroundTruthMerge(
  ctx: VersionAssemblyContext,
  groundTruthIndex: number,
): AggregateMerge {
  const cluster = ctx.clusters[groundTruthIndex];
  if (cluster === undefined) {
    throw new AggregateGroupError(
      "AGGREGATE_GROUP_UNKNOWN",
      `Version group #${groundTruthIndex} of "${ctx.viewKey}" does not exist in this selection.`,
    );
  }
  if (ctx.clusters.length < 2) {
    throw new AggregateGroupError(
      "AGGREGATE_GROUP_NOT_DIVERGENT",
      `"${ctx.viewKey}" has a single structure version — there is nothing to merge.`,
    );
  }

  const snapshot = latestIn(cluster.snapshots);
  const template = snapshot === null ? null : ctx.templateOf(snapshot);
  if (template === null) {
    ctx.warn(`the picked ground-truth template (version ${groundTruthIndex} of "${ctx.viewKey}") could not be loaded; merged counts lose their overlay geometry.`);
  }

  const gtMeta = keyMetasFor(cluster, template);
  const gtKeys = [...cluster.keys].sort(compareKeys);
  const gtCandidates: KeyMeta[] = gtKeys.map((key) =>
    gtMeta.get(key) ?? {
      key,
      elementType: null,
      leafLabel: lastPart(key),
      confidence: "exact",
    },
  );

  // Metadata from each cluster's own template (leaf labels of other versions).
  const metaByCluster = ctx.clusters.map((other) => {
    const otherSnapshot = latestIn(other.snapshots);
    return keyMetasFor(other, otherSnapshot === null ? null : ctx.templateOf(otherSnapshot));
  });
  const metaFor = (key: string, versionIndex: number): { leafLabel: string; elementType: string | null } => {
    const meta = metaByCluster[versionIndex]?.get(key);
    if (meta !== undefined) return { leafLabel: meta.leafLabel, elementType: meta.elementType };
    return { leafLabel: lastPart(key), elementType: terminatorOf(key) };
  };

  interface RowAcc {
    ownCount: number;
    folded: AggregateFoldEntry[];
  }
  const rows = new Map<string, RowAcc>();
  const unmatched: AggregateUnmatchedRow[] = [];
  let foldedEvents = 0;
  let unmatchedEvents = 0;

  for (const [key, perVersion] of [...ctx.perVersion.entries()].sort(([a], [b]) => compareKeys(a, b))) {
    for (const [versionIndex, count] of [...perVersion.entries()].sort(([a], [b]) => a - b)) {
      if (versionIndex === groundTruthIndex) {
        const row = rows.get(key) ?? { ownCount: 0, folded: [] };
        row.ownCount += count;
        rows.set(key, row);
        continue;
      }
      const meta = metaFor(key, versionIndex);
      const match = matchCanonicalKey(key, meta.elementType, gtCandidates);
      if (match === null) {
        unmatched.push({ key, versionIndex, count, leafLabel: meta.leafLabel, elementType: meta.elementType });
        unmatchedEvents += count;
        continue;
      }
      foldedEvents += count;
      const row = rows.get(match.targetKey) ?? { ownCount: 0, folded: [] };
      row.folded.push({
        key,
        versionIndex,
        count,
        matched: match.matched,
        wildcards: match.wildcards,
      });
      rows.set(match.targetKey, row);
    }
  }

  const resolvedRows: AggregateMergeRow[] = [];
  for (const key of gtKeys) {
    const acc = rows.get(key) ?? { ownCount: 0, folded: [] };
    const meta = gtMeta.get(key);
    const templateNodeId = template === null ? null : template.index.nodeIdFor(key);
    resolvedRows.push({
      key,
      count: acc.ownCount + acc.folded.reduce((sum, fold) => sum + fold.count, 0),
      ownCount: acc.ownCount,
      folded: acc.folded.sort(
        (a, b) => b.count - a.count || b.versionIndex - a.versionIndex || compareKeys(a.key, b.key),
      ),
      elementType: meta?.elementType ?? null,
      leafLabel: meta?.leafLabel ?? lastPart(key),
      confidence: meta?.confidence ?? "exact",
      templateNodeId,
      dimensions: template === null ? null : template.dimensionsOf(templateNodeId),
    });
    // A folded contribution always targets a key from the ground truth's own
    // key set (candidates derive from it), so `rows` never holds keys beyond
    // `gtKeys`; anything else would have gone to `unmatched`.
  }

  return {
    groupId: `${ctx.viewKey}#${groundTruthIndex}`,
    viewKey: ctx.viewKey,
    groundTruthIndex,
    fingerprint: cluster.fingerprint,
    rows: resolvedRows.sort((a, b) => b.count - a.count || compareKeys(a.key, b.key)),
    unmatched: unmatched.sort(
      (a, b) => b.count - a.count || a.versionIndex - b.versionIndex || compareKeys(a.key, b.key),
    ),
    foldedEvents,
    unmatchedEvents,
  };
}

/** Last path-part label (allows keys outside any template index). */
function lastPart(key: string): string {
  const parts = canonicalKeyParts(key);
  return parts[parts.length - 1] ?? key;
}

/** The canonical key's terminator when the key carries one (heuristics-safe). */
function terminatorOf(key: string): string | null {
  const parts = canonicalKeyParts(key);
  return parts.length >= 3 ? parts[parts.length - 1]! : null;
}
