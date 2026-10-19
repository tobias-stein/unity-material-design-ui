/**
 * Canonical element keys — cross-session element identity (plan §6.2).
 *
 * Runtime `_id`s are NOT stable across sessions (`UI.ensureUniqueId`, fresh
 * view instances per navigation), so aggregate counting keys elements by
 * their **element tree path** inside a snapshot:
 *
 * ```
 * canonicalKey = viewKey › <path segments…> › elementType
 * ```
 *
 * - `viewKey`   = the snapshot's `view.type` (fallback `view.name`) with a
 *   trailing "(Clone)" stripped.
 * - Each path segment, walking from the view root (exclusive) down to the
 *   element node (inclusive): the node's `name` when meaningful (trimmed,
 *   non-empty, not an `anon:*` fallback id) — otherwise the plan's fallback
 *   `{kind}:{type}[{siblingIndex}]`.
 * - Confidence: **exact** when every segment is a real name, **approximate**
 *   once one or more fallback/anonymous segments appear (§6.2). Events with
 *   *no* matched snapshot node are not graded at all — they surface in the
 *   `unresolved` bucket grouped by `element_type` only.
 *
 * Identity heuristic note: the target node itself contributes the final path
 * segment (the plan resolves the path up to `node.parent`, which would make
 * two sibling buttons of the same type collide). This extension keeps the
 * acceptance shape ("… › path › Button") via the `elementType` terminator and
 * any fallback segment's `[siblingIndex]`, while separating same-named-or-
 * same-typed siblings as far as the captured tree allows.
 */
import type { ParsedSnapshot, SnapshotNodeShape } from "../snapshots/parse.js";

/** Separator between canonical key components (also inside the path). */
export const CANONICAL_SEPARATOR = " › ";

/** The placeholder viewKey for snapshots without a usable view identity. */
export const UNKNOWN_VIEW = "(unknown view)";

/** Anonymous fallback ids minted by the snapshot parser (`anon:<n>`/`anon:path`). */
const ANON_PREFIX = "anon:";

export type CanonicalConfidence = "exact" | "approximate";

/** Identity of one node inside one parsed snapshot. */
export interface CanonicalEntry {
  /** Full canonical key: `viewKey › path… › elementType`. */
  key: string;
  viewKey: string;
  /** The key's terminating element type (the snapshot node's `type`). */
  elementType: string | null;
  /** Human label of the leaf node (`name` or the fallback segment). */
  leafLabel: string;
  /** `exact` = all named segments; `approximate` = any fallback segment. */
  confidence: CanonicalConfidence;
  /** True when at least one path segment was the anonymous fallback. */
  approximateSegments: number;
}

/** Per-snapshot lookup: normalized node id → canonical identity. */
export interface CanonicalIndex {
  viewKey: string;
  readonly byNodeId: Map<string, CanonicalEntry>;
  /** Node document order (first occurrence wins for duplicate keys). */
  readonly byKey: Map<string, string>;
}

/**
 * The viewKey of a snapshot: `view.type` minus a trailing "(Clone)",
 * falling back to `view.name`, then to {@link UNKNOWN_VIEW}.
 */
export function viewKeyOf(snapshot: ParsedSnapshot): string {
  const view = snapshot.view ?? {};
  const type = typeof view["type"] === "string" ? view["type"] : "";
  const name = typeof view["name"] === "string" ? view["name"] : "";
  return stripCloneSuffix(type) || stripCloneSuffix(name) || UNKNOWN_VIEW;
}

export function stripCloneSuffix(value: string): string {
  return value.replace(/\(Clone\)$/, "").trim();
}

/** One path segment per §6.2: name when meaningful, else the kind/type/index fallback. */
export function pathSegmentOf(node: SnapshotNodeShape, id: string): string {
  const rawName = typeof node.name === "string" ? node.name : "";
  const name = stripCloneSuffix(rawName);
  if (name !== "" && !id.startsWith(ANON_PREFIX)) return name;
  const kind = typeof node.kind === "string" && node.kind !== "" ? node.kind : "?";
  const type = typeof node.type === "string" && node.type !== "" ? node.type : "?";
  const siblingIndex = typeof node.siblingIndex === "number" ? node.siblingIndex : 0;
  return `${kind}:${type}[${siblingIndex}]`;
}

/** Whether a path segment is the anonymous fallback (not a real name). */
export function isFallbackSegment(segment: string): boolean {
  return /^[^:]+:[^[]+\[\d+\]$/.test(segment);
}

function elementTypeOf(node: SnapshotNodeShape): string | null {
  return typeof node.type === "string" && node.type !== "" ? node.type : null;
}

/**
 * Full canonical key from already-computed pieces. Exported for tests; the
 * production path is {@link buildCanonicalIndex}.
 */
export function canonicalKeyFromSegments(
  viewKey: string,
  segments: readonly string[],
  elementType: string | null,
): string {
  const parts = [viewKey, ...segments];
  if (elementType !== null) parts.push(elementType);
  return parts.join(CANONICAL_SEPARATOR);
}

/**
 * Build the canonical index of one parsed snapshot: every active/returned
 * node (parser output norm) gets its canonical entry keyed by its node id,
 * so interaction events (`element` tag = runtime `_id`) can be resolved into
 * cross-session identity by id-join (§6.1).
 */
export function buildCanonicalIndex(snapshot: ParsedSnapshot): CanonicalIndex {
  const viewKey = viewKeyOf(snapshot);
  const byNodeId = new Map<string, CanonicalEntry>();
  const byKey = new Map<string, string>();

  const nodesById = new Map<string, SnapshotNodeShape>();
  for (const node of snapshot.nodes) nodesById.set(String(node.id), node);
  const rootNode = nodesById.get(snapshot.rootId) ?? snapshot.nodes[0];

  for (const node of snapshot.nodes) {
    const id = String(node.id);
    const chain: Array<{ id: string; node: SnapshotNodeShape; segment: string }> = [];
    let cursor: SnapshotNodeShape | null = node;
    while (cursor !== null) {
      const current: SnapshotNodeShape = cursor;
      chain.unshift({ id: String(current.id), node: current, segment: pathSegmentOf(current, String(current.id)) });
      const parentId: unknown = current.parentId;
      cursor =
        typeof parentId === "string" && parentId !== "" && nodesById.has(parentId)
          ? nodesById.get(parentId) ?? null
          : null;
    }

    // Drop nodes outside the view chain (defensive: the parser folds orphans
    // under the first root already).
    if (rootNode !== undefined && !inChainToRoot(chain, rootNode)) continue;

    // Path segments: strict descendants of the view root, down to the node.
    const segments: string[] = [];
    let approximateSegments = 0;
    for (let i = 1; i < chain.length; i++) {
      const step = chain[i]!;
      segments.push(step.segment);
      if (isFallbackSegment(step.segment)) approximateSegments++;
    }

    const leaf = chain[chain.length - 1]!;
    const elementType = elementTypeOf(node);
    const entry: CanonicalEntry = {
      key: canonicalKeyFromSegments(viewKey, segments, elementType),
      viewKey,
      elementType,
      leafLabel: leaf.segment,
      confidence: approximateSegments === 0 ? "exact" : "approximate",
      approximateSegments,
    };
    byNodeId.set(id, entry);
    if (!byKey.has(entry.key)) byKey.set(entry.key, id);
  }

  return { viewKey, byNodeId, byKey };
}

function inChainToRoot(
  chain: Array<{ id: string; node: SnapshotNodeShape }>,
  rootNode: SnapshotNodeShape,
): boolean {
  const first = chain[0];
  return first !== undefined && first.id === String(rootNode.id);
}

/** The node id a canonical key resolves to (deterministic first occurrence). */
export function nodeIdForCanonicalKey(index: CanonicalIndex, key: string): string | null {
  return index.byKey.get(key) ?? null;
}
