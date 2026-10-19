/**
 * Snapshot YAML parsing (server-side, plan §5: "Snapshot YAML parsing happens
 * server-side — the web client receives small, pre-shaped JSON").
 *
 * Handles the schema-v2 snapshots the runtime writes
 * (`Assets/Runtime/Telemetry/Snapshot/UISnapshotExporter.cs`, schema v1 is
 * accepted with a warning) and derives exactly what the replica renderer
 * needs on the client, so no YAML/gunzip code ever ships in the web bundle.
 */
import { gunzipSync } from "node:zlib";
import { load as loadYaml } from "js-yaml";

export interface SnapshotNodeShape {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  type?: unknown;
  parentId?: unknown;
  siblingIndex?: unknown;
  active?: unknown;
  isView?: unknown;
  layer?: unknown;
  rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  rectLocal?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  layout?: Record<string, unknown> | null;
  layoutElement?: Record<string, unknown> | null;
  contentSizeFitter?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  resolved?: Record<string, unknown> | null;
}

export interface ParsedSnapshot {
  schemaVersion: number;
  timestampUtc: string | null;
  app: Record<string, unknown> | null;
  view: Record<string, unknown> | null;
  theme: Record<string, unknown> | null;
  /** Node records as captured, after the id-normalization the viewer applies. */
  nodes: SnapshotNodeShape[];
  /** Client-ready hierarchy: children id arrays per node (siblingIndex order). */
  childrenOf: Record<string, string[]>;
  rootId: string;
  /** Warnings (schema drift / geometry), riding the payload for honest display. */
  warnings: string[];
}

export class SnapshotParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SnapshotParseError";
  }
}

const GZIP_MAGIC_1 = 0x1f;
const GZIP_MAGIC_2 = 0x8b;

/** Deserialize snapshot bytes: gzip sniffed by magic, then YAML-wrapped. */
export function decodeSnapshotBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC_1 && bytes[1] === GZIP_MAGIC_2) {
    return gunzipSync(Buffer.from(bytes)).toString("utf8");
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The classic "captured before layout ran" snapshot: most active nodes sit
 * outside the root rect — renders as an essentially empty stage, so the
 * replica surfaces the same warning the standalone snapshot viewer shows.
 */
export function geometryWarning(byId: Map<string, SnapshotNodeShape>, rootId: string): string | null {
  const root = byId.get(rootId);
  const rect = root?.rect;
  const width = typeof rect?.width === "number" ? rect.width : null;
  const height = typeof rect?.height === "number" ? rect.height : null;
  if (width === null || height === null || width === 0 || height === 0) return null;

  let outOfBounds = 0;
  let active = 0;
  for (const node of byId.values()) {
    if (node.active === false || !node.rect) continue;
    const r = node.rect;
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

/** Parse one snapshot document into the client-ready shape. */
export function parseSnapshotText(text: string): ParsedSnapshot {
  let document: unknown;
  try {
    document = loadYaml(text, { json: true });
  } catch (error) {
    throw new SnapshotParseError("SNAPSHOT_YAML_INVALID", `Snapshot YAML is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new SnapshotParseError("SNAPSHOT_YAML_INVALID", "Snapshot YAML is not a mapping.");
  }

  const doc = document as Record<string, unknown>;
  const warnings: string[] = [];

  const schemaVersion = typeof doc.schemaVersion === "number" ? Math.floor(doc.schemaVersion) : null;
  if (schemaVersion === null) warnings.push("missing schemaVersion — best-effort parse");
  else if (schemaVersion > 2) warnings.push(`schemaVersion ${schemaVersion} newer than supported (2) — best-effort parse`);

  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) {
    throw new SnapshotParseError("SNAPSHOT_EMPTY", "Snapshot contains no nodes.");
  }

  // Id normalization mirrors the standalone viewer exactly (render parity is a
  // P5 goal): missing ids get `anon:<n>` fallbacks, duplicates get `#<n>`
  // suffixes in insertion order.
  //
  // This pipeline is the server twin of the standalone viewer's normalization
  // (`@mdu/snapshot-render/normalize`): the shared package owns the *rendering*
  // (P5) and its normalize module drives the standalone page; the server keeps
  // its own DOM-free copy because (a) at production runtime Node cannot load
  // the package's TS sources, and (b) parity is asserted both ways by tests —
  // `test/snapshots.spec.ts` (id normalization equality) and the package's
  // `test/standaloneParity.spec.ts` (actual DOM equality against goldens
  // captured from the pre-extraction viewer).
  const nodes: SnapshotNodeShape[] = doc.nodes.map((rawNode) => ({
    ...((rawNode ?? {}) as Record<string, unknown>),
  }));
  const byId = new Map<string, SnapshotNodeShape>();
  for (const node of nodes) {
    const originalId = typeof node.id === "string" && node.id !== "" ? node.id : null;
    if (originalId === null) node.id = `anon:${byId.size}`;
    if (byId.has(String(node.id))) {
      node.id = `${String(node.id)}#${byId.size}`;
    }
    byId.set(String(node.id), node);
  }

  const childrenOf: Record<string, string[]> = {};
  const roots: string[] = [];
  for (const node of nodes) {
    const id = String(node.id);
    const parentId = typeof node.parentId === "string" && node.parentId !== "" ? node.parentId : null;
    if (parentId !== null && byId.has(parentId)) {
      (childrenOf[parentId] ??= []).push(id);
    } else {
      roots.push(id);
    }
  }
  const siblingIndexOf = (node: SnapshotNodeShape): number =>
    typeof node.siblingIndex === "number" ? node.siblingIndex : 0;
  for (const list of Object.values(childrenOf)) {
    list.sort((a, b) => {
      const nodeA = byId.get(a)!;
      const nodeB = byId.get(b)!;
      const diff = siblingIndexOf(nodeA) - siblingIndexOf(nodeB);
      return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
    });
  }

  // Orphan nodes: attach visually under the first root so nothing disappears.
  const rootId = roots[0] ?? String(nodes[0]!.id);
  if (roots.length > 1) {
    childrenOf[rootId] ??= [];
    for (const orphanId of roots.slice(1)) {
      const orphan = byId.get(orphanId);
      if (orphan !== undefined) {
        orphan.parentId = rootId;
        childrenOf[rootId]?.push(orphanId);
      }
    }
  }

  const geometry = geometryWarning(byId, rootId);
  if (geometry !== null) warnings.push(geometry);

  const theme = doc.theme !== null && typeof doc.theme === "object" ? (doc.theme as Record<string, unknown>) : null;
  const view = doc.view !== null && typeof doc.view === "object" ? (doc.view as Record<string, unknown>) : null;
  const app = doc.app !== null && typeof doc.app === "object" ? (doc.app as Record<string, unknown>) : null;

  return {
    schemaVersion: schemaVersion ?? 0,
    timestampUtc: typeof doc.timestampUtc === "string" ? doc.timestampUtc : null,
    app,
    view,
    theme,
    nodes,
    childrenOf,
    rootId,
    warnings,
  };
}

export function parseSnapshotBytes(bytes: Uint8Array): ParsedSnapshot {
  return parseSnapshotText(decodeSnapshotBytes(bytes));
}
