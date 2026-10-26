/**
 * Snapshot artifact parsing (server-side, plan §5: "Snapshot YAML parsing happens
 * server-side — the web client receives small, pre-shaped JSON").
 *
 * Handles every storage artifact the runtime can emit:
 * - schema-v2 YAML (schema v1 accepted with a warning) — the legacy escape hatch,
 *   never removed (ADR-0008);
 * - gzip-of-YAML, sniffed by magic bytes (`decodeSnapshotBytes` keeps it working
 *   for the pre-v3 backlog);
 * - the v3 "MDS" binary format (ADR-0008: string table + varint + columnar
 *   nodes), sniffed by its own magic (`hasMdsMagic`); theme manifest refs and
 *   delta chain members decode here too (ADR-0007/0009) — theme resolution and
 *   chain materialization happen in `snapshotService` (+ `snapshotChain.ts`),
 *   so `parse.ts` stays single-artifact.
 *
 * This module is the server twin of the shared decoder
 * (`packages/snapshot-render/src/binaryDecode.ts`) — the server keeps its own
 * DOM-free copy for the same reasons as normalize (production Node cannot load
 * the package's TS sources); fidelity of the two is locked by tests.
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
  anchor?: Record<string, number> | null;
  layout?: Record<string, unknown> | null;
  layoutElement?: Record<string, unknown> | null;
  contentSizeFitter?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  resolved?: Record<string, unknown> | null;
  error?: string | null;
}

export interface ParsedSnapshot {
  schemaVersion: number;
  timestampUtc: string | null;
  app: Record<string, unknown> | null;
  view: Record<string, unknown> | null;
  theme: Record<string, unknown> | null;
  /**
   * ADR-0007 session theme-manifest hash (`theme-manifest-<sessionId>.mds`)
   * when the file referenced its theme by hash — after `snapshotService`
   * resolves the manifest the same doc carries the theme inline; the ref stays
   * for provenance. Null on inline themes and legacy YAML files.
   */
  themeRef: string | null;
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

/** Evaluated only on bytes that `hasMdsMagic` already passed. */
export function hasMdsMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x0a;
}

/** Deserialize snapshot bytes *when they are (gzip of) YAML*; MDS bytes go through the binary branch. */
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

/* --------------------------------------------------------------------- *
 * MDS v3 binary decode (structural twin of binaryDecode.ts — see header).
 * Wire layout pinned in UISnapshotBinaryWriter.cs; edit both, keep both.
 * ------------------------------------------------------------------- */

export type MdsSnapshotDoc = {
  formatVersion: number;
  schemaVersion: number;
  contentMode: "anchor" | "delta";
  timestampUtc: string | null;
  app: Record<string, unknown> | null;
  view: Record<string, unknown> | null;
  theme: Record<string, unknown> | null;
  themeRef: string | null;
  source: string | null;
  nodes?: SnapshotNodeShape[];
  delta?: {
    baseHash: string;
    bases: string[];
    nodeCount: number;
    fingerprint: number;
    removedIds: string[];
    added: SnapshotNodeShape[];
    changed: SnapshotNodeShape[];
  } | null;
};

export type MdsThemeManifest = Array<{ hash: string; theme: Record<string, unknown> | null }>;

const InfoKindLayout = 0;
const InfoIsView = 1;
const InfoActive = 2;
const InfoHasRect = 3;
const InfoHasRectLocal = 4;
const InfoHasAnchor = 5;
const InfoHasLayout = 6;
const InfoHasLayoutElement = 7;
const InfoHasContentSizeFitter = 8;
const InfoHasData = 9;
const InfoHasResolved = 10;
const InfoHasError = 11;
const InfoHasLayer = 12;

const ResolvedColorRoles = 0;
const ResolvedTextRole = 1;
const ResolvedText = 2;
const ResolvedFontSize = 3;
const ResolvedFontWeight = 4;
const ResolvedFontName = 5;
const ResolvedTextWidth = 6;
const ResolvedColor = 7;
const ResolvedBackgroundColor = 8;
const ResolvedFillColor = 9;
const ResolvedOutlineColor = 10;
const ResolvedOutlineWidth = 11;
const ResolvedOpacity = 12;
const ResolvedCornerRadius = 13;

const DataKindNull = 0;
const DataKindBool = 1;
const DataKindInt = 2;
const DataKindFloat = 3;
const DataKindString = 4;
const DataKindList = 5;
const DataKindMap = 6;
const DataKindSymbol = 7;

class MdsReader {
  private view: DataView;
  private decoder = new TextDecoder("utf-8");
  private offset = 0;
  private table: string[] = [];

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    this.need(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  varUint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) throw new SnapshotParseError("SNAPSHOT_MDS_TRUNCATED", "MDS varint longer than 10 bytes");
    }
  }

  zigzag(): number {
    const raw = this.varUint();
    const negative = raw % 2 === 1;
    const magnitude = (raw - (negative ? 1 : 0)) / 2;
    return negative ? -(magnitude + 1) : magnitude;
  }

  quantized(): number {
    return this.zigzag() / 100;
  }

  inlineString(): string {
    const len = this.varUint();
    this.need(len);
    const slice = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return this.decoder.decode(slice);
  }

  loadTable(): void {
    const count = this.varUint();
    this.table = new Array(count);
    for (let i = 0; i < count; i++) {
      this.table[i] = this.inlineString();
    }
  }

  stringRef(): string | null {
    const ref = this.varUint();
    if (ref === 0) return null;
    const index = ref - 1;
    if (index < 0 || index >= this.table.length) {
      throw new SnapshotParseError("SNAPSHOT_MDS_INVALID", `string ref ${ref} beyond the string table (${this.table.length} entries)`);
    }
    return this.table[index]!;
  }

  present(): boolean {
    return this.varUint() !== 0;
  }

  /** Skip the magic ("MDS\n") — the header's formatVersion starts at byte 4. */
  skipMagic(): void {
    this.need(4);
    this.offset += 4;
  }

  need(count: number): void {
    if (this.offset + count > this.view.byteLength) {
      throw new SnapshotParseError("SNAPSHOT_MDS_TRUNCATED", `MDS read of ${count} byte(s) beyond end of file at ${this.offset}`);
    }
  }
}

function decodeAppOrView(reader: MdsReader, kind: "app" | "view"): Record<string, unknown> {
  return kind === "app"
    ? {
        productName: reader.stringRef(),
        productVersion: reader.stringRef(),
        unityVersion: reader.stringRef(),
        platform: reader.stringRef(),
        deviceType: reader.stringRef(),
        sessionId: reader.stringRef(),
        screenWidth: reader.quantized(),
        screenHeight: reader.quantized(),
        scaleFactor: reader.quantized(),
      }
    : {
        id: reader.stringRef(),
        name: reader.stringRef(),
        type: reader.stringRef(),
        layer: reader.stringRef(),
      };
}

function decodeTheme(reader: MdsReader): Record<string, unknown> {
  const isDark = reader.varUint() !== 0;
  const seedColor = reader.stringRef();
  const deviceType = reader.stringRef();

  const readNameMap = () => {
    const out: Record<string, string> = {};
    const count = reader.varUint();
    for (let i = 0; i < count; i++) {
      const key = reader.stringRef();
      if (key !== null) out[key] = reader.stringRef() ?? "";
    }
    return out;
  };
  const readQuantMap = () => {
    const out: Record<string, number> = {};
    const count = reader.varUint();
    for (let i = 0; i < count; i++) {
      const key = reader.stringRef();
      if (key !== null) out[key] = reader.quantized();
    }
    return out;
  };

  const palette = readNameMap();
  const spacing = readQuantMap();
  const sizing = readQuantMap();

  const typography: Record<string, Record<string, unknown>> = {};
  const typographyCount = reader.varUint();
  for (let i = 0; i < typographyCount; i++) {
    const role = reader.stringRef();
    if (role !== null) {
      typography[role] = {
        fontSize: reader.quantized(),
        fontWeight: reader.stringRef(),
        fontStyle: reader.stringRef(),
        fontName: reader.stringRef(),
        characterSpacing: reader.quantized(),
        lineSpacing: reader.quantized(),
      };
    }
  }

  return { seedColor, isDark, deviceType, palette, spacing, sizing, typography };
}

function decodeNodeBody(reader: MdsReader, parentId: string | null): SnapshotNodeShape {
  const info = reader.varUint();
  const siblingIndex = reader.zigzag();
  const id = reader.stringRef();
  const name = reader.stringRef();
  const type = reader.stringRef();

  const node: SnapshotNodeShape = {
    id,
    kind: info & (1 << InfoKindLayout) ? "layout" : "ui",
    name,
    type,
    parentId,
    siblingIndex,
    active: (info & (1 << InfoActive)) !== 0,
    isView: (info & (1 << InfoIsView)) !== 0,
  };

  if (info & (1 << InfoHasLayer)) node.layer = reader.stringRef();

  const decodeRect = () => ({
    x: reader.quantized(),
    y: reader.quantized(),
    width: reader.quantized(),
    height: reader.quantized(),
  });

  if (info & (1 << InfoHasRect)) node.rect = decodeRect();
  if (info & (1 << InfoHasRectLocal)) node.rectLocal = decodeRect();
  if (info & (1 << InfoHasAnchor)) {
    node.anchor = {
      pivotX: reader.quantized(),
      pivotY: reader.quantized(),
      anchorMinX: reader.quantized(),
      anchorMinY: reader.quantized(),
      anchorMaxX: reader.quantized(),
      anchorMaxY: reader.quantized(),
      anchoredX: reader.quantized(),
      anchoredY: reader.quantized(),
      sizeX: reader.quantized(),
      sizeY: reader.quantized(),
    };
  }

  if (info & (1 << InfoHasLayout)) {
    const layoutType = reader.stringRef();
    const bools = reader.varUint();
    node.layout = {
      type: layoutType,
      paddingLeft: reader.quantized(),
      paddingRight: reader.quantized(),
      paddingTop: reader.quantized(),
      paddingBottom: reader.quantized(),
      spacing: reader.quantized(),
      childAlignment: reader.stringRef(),
      runtimeSwitchable: (bools & 1) !== 0,
      controlChildWidth: (bools & (1 << 1)) !== 0,
      controlChildHeight: (bools & (1 << 2)) !== 0,
      childForceExpandWidth: (bools & (1 << 3)) !== 0,
      childForceExpandHeight: (bools & (1 << 4)) !== 0,
      reverseArrangement: (bools & (1 << 5)) !== 0,
    };
  }

  if (info & (1 << InfoHasLayoutElement)) {
    // Writer order: six quantized floats first, then the ignoreLayout varint.
    const minWidth = reader.quantized();
    const minHeight = reader.quantized();
    const preferredWidth = reader.quantized();
    const preferredHeight = reader.quantized();
    const flexibleWidth = reader.quantized();
    const flexibleHeight = reader.quantized();
    const ignoreLayout = reader.varUint() !== 0;
    node.layoutElement = { minWidth, minHeight, preferredWidth, preferredHeight, flexibleWidth, flexibleHeight, ignoreLayout };
  }

  if (info & (1 << InfoHasContentSizeFitter)) {
    node.contentSizeFitter = { horizontalMode: reader.stringRef(), verticalMode: reader.stringRef() };
  }

  if (info & (1 << InfoHasData)) {
    const data: Record<string, unknown> = {};
    const count = reader.varUint();
    for (let i = 0; i < count; i++) {
      const key = reader.stringRef();
      if (key !== null) data[key] = decodeDataValue(reader);
    }
    node.data = data;
  }

  if (info & (1 << InfoHasResolved)) {
    const mask = reader.varUint();
    const resolved: Record<string, unknown> = {};
    const readString = () => reader.stringRef();
    if (mask & (1 << ResolvedColorRoles)) {
      const roles: Record<string, string> = {};
      const count = reader.varUint();
      for (let i = 0; i < count; i++) {
        const key = reader.stringRef();
        if (key !== null) roles[key] = readString() ?? "";
      }
      resolved["colorRoles"] = roles;
    }
    if (mask & (1 << ResolvedTextRole)) resolved["textRole"] = readString();
    if (mask & (1 << ResolvedText)) resolved["text"] = readString();
    if (mask & (1 << ResolvedFontSize)) resolved["fontSize"] = reader.quantized();
    if (mask & (1 << ResolvedFontWeight)) resolved["fontWeight"] = readString();
    if (mask & (1 << ResolvedFontName)) resolved["fontName"] = readString();
    if (mask & (1 << ResolvedTextWidth)) resolved["textWidth"] = reader.quantized();
    if (mask & (1 << ResolvedColor)) resolved["color"] = readString();
    if (mask & (1 << ResolvedBackgroundColor)) resolved["backgroundColor"] = readString();
    if (mask & (1 << ResolvedFillColor)) resolved["fillColor"] = readString();
    if (mask & (1 << ResolvedOutlineColor)) resolved["outlineColor"] = readString();
    if (mask & (1 << ResolvedOutlineWidth)) resolved["outlineWidth"] = reader.quantized();
    if (mask & (1 << ResolvedOpacity)) resolved["opacity"] = reader.quantized();
    if (mask & (1 << ResolvedCornerRadius)) resolved["cornerRadius"] = reader.quantized();
    node.resolved = resolved;
  }

  if (info & (1 << InfoHasError)) node.error = reader.stringRef();
  return node;
}

function decodeDataValue(reader: MdsReader): unknown {
  const kind = reader.varUint();
  switch (kind) {
    case DataKindNull:
      return null;
    case DataKindBool:
      return reader.varUint() !== 0;
    case DataKindInt:
      return reader.zigzag();
    case DataKindFloat:
      return reader.quantized();
    case DataKindString:
      return reader.stringRef();
    case DataKindList: {
      const list: unknown[] = new Array(reader.varUint());
      for (let i = 0; i < list.length; i++) list[i] = decodeDataValue(reader);
      return list;
    }
    case DataKindMap: {
      const map: Record<string, unknown> = {};
      const count = reader.varUint();
      for (let i = 0; i < count; i++) {
        const key = reader.stringRef();
        if (key !== null) map[key] = decodeDataValue(reader);
      }
      return map;
    }
    case DataKindSymbol:
      return { code: reader.zigzag(), fill: reader.varUint() !== 0 };
    default:
      throw new SnapshotParseError("SNAPSHOT_MDS_INVALID", `unknown MDS data value kind ${kind}`);
  }
}

/** Decode one "MDS" artifact: snapshot file or (manifest: true) theme manifest. */
export function decodeMdsBytes(
  bytes: Uint8Array,
  manifest = false,
): MdsSnapshotDoc | { manifest: MdsThemeManifest } {
  if (!hasMdsMagic(bytes)) {
    throw new SnapshotParseError("SNAPSHOT_MDS_INVALID", "not an 'MDS' v3 binary snapshot artifact");
  }

  const reader = new MdsReader(bytes);
  reader.skipMagic();
  const formatVersion = reader.u8();
  const schemaVersion = reader.u8();
  if (formatVersion !== 3 || schemaVersion !== 3) {
    throw new SnapshotParseError(
      "SNAPSHOT_MDS_VERSION",
      `MDS formatVersion ${formatVersion} / schemaVersion ${schemaVersion} is not supported (3/3 expected)`,
    );
  }
  const flags = reader.u8();
  const deltaMode = !manifest && (flags & 1) === 1;

  reader.loadTable();

  if (manifest) {
    const entries: MdsThemeManifest = new Array(reader.varUint());
    for (let i = 0; i < entries.length; i++) {
      const hash = reader.inlineString();
      const present = reader.varUint() !== 0;
      entries[i] = { hash, theme: present ? decodeTheme(reader) : null };
    }
    return { manifest: entries };
  }

  const themeMode = reader.varUint();
  let theme: Record<string, unknown> | null = null;
  let themeRef: string | null = null;
  if (themeMode === 2) {
    themeRef = reader.inlineString();
  } else if (themeMode === 1) {
    theme = decodeTheme(reader);
  } // mode 0 = absent (decodeTheme may itself degrade to absent only mid-payload — tolerated)

  const head = {
    formatVersion,
    schemaVersion,
    timestampUtc: reader.stringRef(),
    app: reader.present() ? decodeAppOrView(reader, "app") : null,
    view: reader.present() ? decodeAppOrView(reader, "view") : null,
    theme,
    themeRef,
    source: reader.stringRef(),
  };

  if (deltaMode) {
    const baseHash = reader.inlineString();
    const bases: string[] = new Array(reader.varUint());
    for (let i = 0; i < bases.length; i++) bases[i] = reader.inlineString();
    return decodeDeltaBody(reader, head, baseHash, bases);
  }

  // Anchor form: pre-order node stream, hierarchy via the childCount stack.
  const count = reader.varUint();
  const nodes: SnapshotNodeShape[] = new Array(count);
  const stackIds: string[] = [];
  const stack: number[] = [];
  for (let i = 0; i < count; i++) {
    while (stack.length > 0 && stack[stack.length - 1] === 0) {
      stack.pop();
      stackIds.pop();
    }
    const parentId = stackIds.length > 0 ? stackIds[stackIds.length - 1]! : null;
    const childCount = reader.varUint();
    const node = decodeNodeBody(reader, parentId);
    nodes[i] = node;
    if (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      stack[stack.length - 1] = top - 1;
    }
    stackIds.push(String(node.id ?? ""));
    stack.push(childCount);
  }

  return { ...head, contentMode: "anchor", nodes, delta: null };
}

function decodeDeltaBody(
  reader: MdsReader,
  head: Omit<MdsSnapshotDoc, "contentMode" | "nodes" | "delta">,
  baseHash: string,
  bases: string[],
): MdsSnapshotDoc {
  const nodeCount = reader.varUint();
  const fingerprint = reader.varUint();

  const removedIds: string[] = new Array(reader.varUint());
  for (let i = 0; i < removedIds.length; i++) removedIds[i] = reader.stringRef() ?? "";

  const added: SnapshotNodeShape[] = new Array(reader.varUint());
  for (let i = 0; i < added.length; i++) {
    added[i] = decodePatchNode(reader);
  }
  const changed: SnapshotNodeShape[] = new Array(reader.varUint());
  for (let i = 0; i < changed.length; i++) {
    changed[i] = decodePatchNode(reader);
  }

  return {
    ...head,
    contentMode: "delta",
    delta: { baseHash, bases, nodeCount, fingerprint, removedIds, added, changed },
  };
}

/** Patch flavor: id + parentId precede the shared body (siblingIndex lives in it). */
function decodePatchNode(reader: MdsReader): SnapshotNodeShape {
  const id = reader.stringRef();
  const parentId = reader.stringRef();
  const node = decodeNodeBody(reader, parentId);
  node.id = id;
  return node;
}

/* --------------------------------------------------------------------- *
 * Finalizing — the pipeline shared by the YAML and the binary branches.
 * ------------------------------------------------------------------- */

export interface ParseOptions {
  /**
   * Highest schemaVersion supported by the *input encoding*; drives the drift
   * warning wording. The MDS branch passes 3 (its header is authoritative);
   * YAML keeps 2.
   */
  supportedSchemaVersion?: number;
}

/**
 * Parse one snapshot document (already decoded to a plain object) into the
 * client-ready shape. Id normalization mirrors the standalone viewer exactly
 * (render parity is a P5 goal): missing ids get `anon:<n>` fallbacks,
 * duplicates get `#<n>` suffixes in insertion order.
 *
 * This pipeline is the server twin of the standalone viewer's normalization
 * (`@mdu/snapshot-render/normalize`): the shared package owns the *rendering*
 * (P5) and its normalize module drives the standalone page; the server keeps
 * its own DOM-free copy because (a) at production runtime Node cannot load
 * the package's TS sources, and (b) parity is asserted both ways by tests —
 * `test/snapshots.spec.ts` (id normalization equality) and the package's
 * `test/standaloneParity.spec.ts` (actual DOM equality against goldens
 * captured from the pre-extraction viewer).
 */
export function finalizeSnapshot(doc: unknown, warnings: string[], options: ParseOptions = {}): ParsedSnapshot {
  const supportedSchemaVersion = options.supportedSchemaVersion ?? 2;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new SnapshotParseError("SNAPSHOT_YAML_INVALID", "Snapshot is not a mapping.");
  }

  const document = doc as Record<string, unknown>;

  const schemaVersion = typeof document.schemaVersion === "number" ? Math.floor(document.schemaVersion) : null;
  if (schemaVersion === null) warnings.push("missing schemaVersion — best-effort parse");
  else if (schemaVersion > supportedSchemaVersion) warnings.push(`schemaVersion ${schemaVersion} newer than supported (${supportedSchemaVersion}) — best-effort parse`);

  if (!Array.isArray(document.nodes) || document.nodes.length === 0) {
    throw new SnapshotParseError("SNAPSHOT_EMPTY", "Snapshot contains no nodes.");
  }

  const nodes: SnapshotNodeShape[] = (document.nodes as unknown[]).map((rawNode) => ({
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

  const theme = document.theme !== null && typeof document.theme === "object" ? (document.theme as Record<string, unknown>) : null;
  const themeRef = typeof document.themeRef === "string" && document.themeRef !== "" ? document.themeRef : null;
  const view = document.view !== null && typeof document.view === "object" ? (document.view as Record<string, unknown>) : null;
  const app = document.app !== null && typeof document.app === "object" ? (document.app as Record<string, unknown>) : null;

  return {
    schemaVersion: schemaVersion ?? 0,
    timestampUtc: typeof document.timestampUtc === "string" ? document.timestampUtc : null,
    app,
    view,
    theme,
    themeRef,
    nodes,
    childrenOf,
    rootId,
    warnings,
  };
}

/** Parse one YAML document into the client-ready shape. */
export function parseSnapshotText(text: string): ParsedSnapshot {
  let document: unknown;
  try {
    document = loadYaml(text, { json: true });
  } catch (error) {
    throw new SnapshotParseError("SNAPSHOT_YAML_INVALID", `Snapshot YAML is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  return finalizeSnapshot(document, []);
}

/** Parse one artifact's bytes: gzip/YAML and MDS binary, sniffed by magic. */
export function parseSnapshotBytes(bytes: Uint8Array): ParsedSnapshot {
  if (hasMdsMagic(bytes)) {
    const doc = decodeMdsBytes(bytes) as MdsSnapshotDoc;
    // ADR-0009: delta members are chain storage — a single artifact has no
    // base to replay. The service materializes the chain (snapshotChain.ts);
    // direct single-file callers get the honest error instead of a half doc.
    if (doc.contentMode === "delta" || doc.delta != null) {
      throw new SnapshotParseError(
        "SNAPSHOT_CHAIN_DELTA",
        "Delta chain capture — materialize through the snapshot service (needs the chain members), not as a standalone file.",
      );
    }
    // Manifest-ref themes resolve through the session manifest — `snapshotService`
    // does the lookup and reinjects the resolved theme before finalizing. A pure
    // ref (mode 2) carries `theme: null`, which degrades the same way inline-free
    // docs always have.
    if (doc.nodes === undefined || doc.nodes.length === 0) {
      throw new SnapshotParseError("SNAPSHOT_EMPTY", "Snapshot contains no nodes.");
    }
    return finalizeSnapshot(
      {
        schemaVersion: doc.schemaVersion,
        timestampUtc: doc.timestampUtc,
        app: doc.app,
        view: doc.view,
        theme: doc.theme ?? undefined,
        themeRef: doc.themeRef,
        source: doc.source,
        nodes: doc.nodes,
      },
      [],
      { supportedSchemaVersion: 3 },
    );
  }
  return parseSnapshotText(decodeSnapshotBytes(bytes));
}

/** Chain materialization helper: apply one delta's diffs to a node map (see snapshotChain.ts). */
export function applyDeltaToMap(
  nodes: Map<string, SnapshotNodeShape>,
  delta: NonNullable<MdsSnapshotDoc["delta"]>,
): void {
  for (const removedId of delta.removedIds) {
    nodes.delete(removedId);
  }
  for (const addedNode of delta.added) {
    const id = String(addedNode.id ?? "");
    if (id !== "") nodes.set(id, addedNode);
  }
  for (const changedNode of delta.changed) {
    const id = String(changedNode.id ?? "");
    if (id !== "") nodes.set(id, changedNode);
  }
}

/** Deterministic pre-order of a materialized node map (parent → children by siblingIndex). */
export function orderMaterializedNodes(nodes: Iterable<SnapshotNodeShape>): SnapshotNodeShape[] {
  // Single membership pass first: delta `changed` nodes may carry a parent the
  // *empty* map has not seen yet (reparenting), and anchor docs always list
  // parents before children — collecting before wiring keeps the check total.
  const byId = new Map<string, SnapshotNodeShape>();
  for (const node of nodes) {
    const id = String(node.id ?? "");
    if (id === "") continue;
    byId.set(id, node);
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of byId.values()) {
    const id = String(node.id ?? "");
    const parentId = typeof node.parentId === "string" && node.parentId !== "" ? node.parentId : null;
    if (parentId !== null && parentId !== id && byId.has(parentId)) {
      const list = children.get(parentId);
      if (list === undefined) children.set(parentId, [id]);
      else list.push(id);
    } else {
      roots.push(id);
    }
  }
  const siblingIndexOf = (node: SnapshotNodeShape): number =>
    typeof node.siblingIndex === "number" ? node.siblingIndex : 0;
  for (const list of children.values()) {
    list.sort((a, b) => {
      const diff = siblingIndexOf(byId.get(a)!) - siblingIndexOf(byId.get(b)!);
      return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
    });
  }

  const ordered: SnapshotNodeShape[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const child of children.get(id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // Any node not reached (cyclic parent refs — materialization invariant
  // should make this impossible): append so nothing disappears.
  for (const node of byId.values()) {
    const id = String(node.id ?? "");
    if (!visited.has(id)) ordered.push(node);
  }
  return ordered;
}
