/**
 * Snapshot normalization — the single implementation that used to exist twice
 * (standalone `viewer.js` applySnapshot and the server's `parse.ts`).
 *
 * Pipeline, in order (both consumers apply the same steps, warnings wording
 * parametrized):
 *   1. document shape validation (mapping, nodes present)
 *   2. schema-version drift warning (missing / newer than supported)
 *   3. node id normalization: missing ids → `anon:<n>` fallbacks, duplicate
 *      ids → `#<n>` suffixes in insertion order
 *   4. hierarchy derivation from `parentId` + `siblingIndex` (robust against
 *      missing `children` lists), orphan nodes re-attached under the root
 *   5. geometry warning ("captured before layout ran") via node bounds vs root
 *
 * The geometry/shepherding uses the guarded numeric checks the server parser
 * introduced — identical results for all real snapshots (rects are always
 * numbers in exporter output) and more robust for hand-written fixtures.
 */
import type { SnapshotAppInfo, SnapshotNode, SnapshotTheme, SnapshotViewInfo, UISnapshot } from "./model.js";

/** Shape of one raw node coming out of YAML (any property may be missing/mistyped). */
export type RawSnapshotNode = Record<string, unknown>;

export class SnapshotShapeError extends Error {
  constructor(
    readonly code: "SNAPSHOT_NOT_MAPPING" | "SNAPSHOT_EMPTY",
    message: string,
  ) {
    super(message);
    this.name = "SnapshotShapeError";
  }
}

export interface NormalizeOptions {
  /**
   * Highest schemaVersion the caller supports (standalone page: 1; server
   * parser: 2). Drives the "newer than supported" warning wording.
   */
  supportedSchemaVersion?: number;
  /**
   * Verb in schema-drift warnings: `render` (standalone viewer) or `parse`
   * (server) — both communities expect their exact historical strings.
   */
  bestEffortKind?: "render" | "parse";
  /**
   * Child-list ordering for equal `siblingIndex`: `insertion` keeps YAML
   * order (viewer DOM parity), `lexicographic` id-compares (the server's
   * historical stable output). Deterministic either way.
   */
  childrenTieBreak?: "insertion" | "lexicographic";
}

/** The normalized document: same fields the renderers consume everywhere. */
export type NormalizedSnapshot = UISnapshot;

/**
 * Normalize one YAML-parsed snapshot document for rendering. Throws
 * `SnapshotShapeError` with a stable `code` on unusable input; the caller
 * decides which user-facing message to surface.
 *
 * `timestampUtc` passes through **raw** (the vendored js-yaml parses YAML 1.1
 * timestamps into Date objects and the standalone status line prints them;
 * typed consumers filter on `typeof === "string"` themselves).
 */
export function normalizeSnapshot(raw: unknown, options: NormalizeOptions = {}): NormalizedSnapshot {
  const supportedSchemaVersion = options.supportedSchemaVersion ?? 1;
  const kind = options.bestEffortKind ?? "render";

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SnapshotShapeError("SNAPSHOT_NOT_MAPPING", "not a YAML mapping");
  }
  const doc = raw as Record<string, unknown>;

  const warnings: string[] = [];
  const schemaVersion = typeof doc.schemaVersion === "number" ? Math.floor(doc.schemaVersion) : null;
  if (schemaVersion === null) {
    warnings.push(`missing schemaVersion — best-effort ${kind}`);
  } else if (schemaVersion > supportedSchemaVersion) {
    warnings.push(`schemaVersion ${schemaVersion} newer than supported (${supportedSchemaVersion}) — best-effort ${kind}`);
  }

  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) {
    throw new SnapshotShapeError("SNAPSHOT_EMPTY", "snapshot contains no nodes");
  }

  // Copies: never alias (and thereby mutate) the caller's YAML objects.
  const nodes = (doc.nodes as unknown[]).map((rawNode) => ({ ...((rawNode ?? {}) as RawSnapshotNode) }));
  const byId = normalizeNodeIds(nodes as unknown as SnapshotNode[]);

  const childrenOf = deriveHierarchy(nodes as unknown as SnapshotNode[], byId, options.childrenTieBreak ?? "insertion");

  const rootId = snapshotRootId(nodes, byId);
  if (rootId === "") throw new SnapshotShapeError("SNAPSHOT_EMPTY", "snapshot contains no nodes");
  attachOrphans(nodes, byId, rootId, childrenOf);

  const geometry = geometryWarningForNodes(nodes as unknown as GeometryNode[], rootId);
  if (geometry !== null) warnings.push(geometry);

  const theme = doc.theme !== null && typeof doc.theme === "object" ? (doc.theme as SnapshotTheme) : null;
  const view = doc.view !== null && typeof doc.view === "object" ? (doc.view as SnapshotViewInfo) : null;
  const app = doc.app !== null && typeof doc.app === "object" ? (doc.app as SnapshotAppInfo) : null;

  return {
    schemaVersion,
    timestampUtc: (doc.timestampUtc ?? null) as NormalizedSnapshot["timestampUtc"],
    app,
    view,
    theme,
    nodes: nodes as unknown as SnapshotNode[],
    childrenOf,
    rootId,
    warnings,
  };
}

/* ------------------------------------------------- id + hierarchy (shared) */

/**
 * Step 3 of the pipeline. Mutates each node's `id` in place: missing/empty
 * ids get `anon:<n>` fallbacks, duplicates get `#<n>` suffixes (insertion
 * order), returns the byId map with string-coerced keys.
 */
export function normalizeNodeIds(nodes: RawSnapshotNode[]): Map<string, RawSnapshotNode> {
  const byId = new Map<string, RawSnapshotNode>();
  for (const node of nodes) {
    if (node.id == null || node.id === "") node.id = `anon:${byId.size}`;
    const id = String(node.id);
    if (byId.has(id)) node.id = `${id}#${byId.size}`;
    byId.set(String(node.id), node);
  }
  return byId;
}

const siblingIndexOf = (node: RawSnapshotNode): number =>
  typeof node.siblingIndex === "number" ? node.siblingIndex : 0;

/**
 * Step 4: children id arrays per node (siblingIndex order), the root id, and
 * — multi-root documents — orphan re-attachment under the first root
 * (nothing disappears; `parentId` is updated on the orphan node copies).
 */
export function deriveHierarchy(
  nodes: SnapshotNode[],
  byId: Map<string, RawSnapshotNode>,
  tieBreak: "insertion" | "lexicographic" = "insertion",
): Record<string, string[]> {
  const childrenOf: Record<string, string[]> = {};
  for (const raw of nodes as unknown as RawSnapshotNode[]) {
    const id = String(raw.id);
    const parentId = typeof raw.parentId === "string" && raw.parentId !== "" ? raw.parentId : null;
    if (parentId !== null && byId.has(parentId)) {
      (childrenOf[parentId] ??= []).push(id);
    }
  }
  for (const list of Object.values(childrenOf)) {
    list.sort((a, b) => {
      const diff = siblingIndexOf(byId.get(a)!) - siblingIndexOf(byId.get(b)!);
      if (diff !== 0) return diff;
      return tieBreak === "lexicographic" ? (a < b ? -1 : a > b ? 1 : 0) : 0;
    });
  }
  return childrenOf;
}

/** Root candidate: the first unparented node, else the first node overall. */
export function snapshotRootId(nodes: RawSnapshotNode[], byId: Map<string, RawSnapshotNode>): string {
  const rootIds: string[] = [];
  for (const node of nodes) {
    const parentId = node.parentId;
    if (parentId == null || parentId === "" || (typeof parentId === "string" && !byId.has(parentId))) {
      rootIds.push(String(node.id));
    }
  }
  // Root fallback chain identical to the original viewer: first root, else
  // the very first node (documents always render something).
  return String(rootIds[0] || (nodes[0]?.id ?? ""));
}

/* ------------------------------------------------------- geometry warning */

/** Minimal shape both the typed package nodes and the server's loose records satisfy. */
export interface GeometryNode {
  id: unknown;
  rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  active?: unknown;
}

/**
 * Detects the classic "captured before layout ran" snapshot: most active
 * nodes sit outside the root rect (Unity layout not applied yet →
 * prefab-authored rects), which renders as an essentially empty stage.
 */
export function geometryWarningForNodes(nodes: ReadonlyArray<GeometryNode>, rootId: string): string | null {
  const node = nodes.find((candidate) => candidate.id === rootId);
  const rect = node?.rect;
  const width = typeof rect?.width === "number" ? rect.width : null;
  const height = typeof rect?.height === "number" ? rect.height : null;
  if (width === null || height === null || width === 0 || height === 0) return null;

  let outOfBounds = 0;
  let active = 0;
  for (const candidate of nodes) {
    if (candidate.active === false || !candidate.rect) continue;
    const r = candidate.rect;
    const x = typeof r.x === "number" ? r.x : null;
    const y = typeof r.y === "number" ? r.y : null;
    const w = typeof r.width === "number" ? r.width : null;
    const h = typeof r.height === "number" ? r.height : null;
    if (x === null || y === null || w === null || h === null) continue;
    active++;
    const outside = x >= width || y >= height || x + w <= 0 || y + h <= 0;
    if (outside) outOfBounds++;
  }

  if (active > 0 && outOfBounds / active > 0.2) {
    return `${outOfBounds} of ${active} nodes lie outside the root — capture likely ran before layout was applied`;
  }
  return null;
}

function roots(
  byId: Map<string, RawSnapshotNode>,
  childrenOf: Record<string, string[]>,
  nodes: RawSnapshotNode[],
): string | null {
  const rootCandidates = nodes.filter((node) => {
    const id = String(node.id);
    const parentId = typeof node.parentId === "string" && node.parentId !== "" ? node.parentId : null;
    return parentId === null || !byId.has(parentId);
  });
  const rootId = rootCandidates[0] ? String(rootCandidates[0].id) : String(nodes[0]?.id ?? "");
  return rootId === "" ? null : (childrenOf[rootId] ?? true) && rootId;
}

function attachOrphans(
  nodes: RawSnapshotNode[],
  byId: Map<string, RawSnapshotNode>,
  rootId: string,
  childrenOf: Record<string, string[]>,
): void {
  const orphans = nodes.filter((node) => {
    const id = String(node.id);
    if (id === rootId) return false;
    const parentId = typeof node.parentId === "string" && node.parentId !== "" ? node.parentId : null;
    return parentId === null || !byId.has(parentId);
  });
  if (orphans.length === 0) return;
  // Orphans: attach visually under root so nothing disappears.
  childrenOf[rootId] ??= [];
  for (const orphan of orphans) {
    const orphanId = String(orphan.id);
    orphan.parentId = rootId;
    childrenOf[rootId]?.push(orphanId);
  }
}
