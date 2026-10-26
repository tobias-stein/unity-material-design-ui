/**
 * MDS binary snapshot decoder (format v3, designed in ADR-0008/0007/0009).
 *
 * The browser-side half of the format migration: the standalone
 * `Extra/snapshot-viewer` page (and any other classic-script consumer) sniffs
 * for the "MDS\n" magic and decodes to the same document shape the YAML path
 * produces — normalizeSnapshot consumes either untouched.
 *
 * The server's `parse.ts` carries a DOM-free structural twin (same byte
 * layout, same doc shape); parity of the two is locked by tests, mirroring the
 * normalize.ts / parse.ts arrangement. The wire layout itself is pinned in
 * `Assets/Runtime/Telemetry/Snapshot/UISnapshotBinaryWriter.cs` (the C# side
 * of the one migration): edit both sides together, in both languages, or a
 * fixture test fails.
 */

/** Shape of one decoded node record — the exact keys the YAML path carries. */
export type MdsNodeDoc = {
  id: string | null;
  kind: string;
  name?: string | null;
  type?: string | null;
  parentId?: string | null;
  siblingIndex: number;
  active: boolean;
  isView: boolean;
  layer?: string | null;
  rect?: { x: number; y: number; width: number; height: number } | null;
  rectLocal?: { x: number; y: number; width: number; height: number } | null;
  anchor?: Record<string, number> | null;
  layout?: Record<string, unknown> | null;
  layoutElement?: Record<string, unknown> | null;
  contentSizeFitter?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  resolved?: Record<string, unknown> | null;
  error?: string | null;
};

export type MdsThemeDoc = {
  seedColor: string | null;
  isDark: boolean;
  deviceType: string | null;
  palette: Record<string, string> | null;
  spacing: Record<string, number> | null;
  sizing: Record<string, number> | null;
  typography: Record<string, Record<string, unknown>> | null;
};

export type MdsHead = {
  formatVersion: number;
  schemaVersion: number;
  timestampUtc: string | null;
  app: Record<string, unknown> | null;
  view: Record<string, unknown> | null;
  theme: MdsThemeDoc | null;
  themeRef: string | null;
  source: string | null;
};

/** One 'MDS' snapshot file's decoded content, in the YAML document's shape where shared. */
export type MdsSnapshotDoc = MdsHead & {
  /** "anchor" (full tree) or "delta" (sparse chain member, ADR-0009). */
  contentMode: "anchor" | "delta";
  /** Anchor-only: full node stream (pre-order, hierarchy via childCount). */
  nodes?: MdsNodeDoc[];
  /** Delta-only fields (ADR-0009) — see UISnapshotBinaryWriter.writeDelta. */
  delta?: {
    baseHash: string;
    bases: string[];
    nodeCount: number;
    fingerprint: number;
    removedIds: string[];
    added: MdsNodeDoc[];
    changed: MdsNodeDoc[];
  } | null;
};

/** Theme manifest artifact (ADR-0007): hash → theme entries. */
export type MdsThemeManifest = Array<{ hash: string; theme: MdsThemeDoc | null }>;

export class MdsDecodeError extends Error {
  constructor(
    readonly code: "MDS_MAGIC_UNKNOWN" | "MDS_FORMAT_VERSION" | "MDS_TRUNCATED" | "MDS_STRING_REF_OUT_OF_RANGE" | "MDS_DATA_KIND",
    message: string,
  ) {
    super(message);
    this.name = "MdsDecodeError";
  }
}

const MAGIC: readonly number[] = [0x4d, 0x44, 0x53, 0x0a]; // "MDS\n"

/** Sniffs: v3 binary starts with the MDS magic (gzip — 0x1f 0x8b — never collides). */
export function hasMdsMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === MAGIC[0] &&
    bytes[1] === MAGIC[1] &&
    bytes[2] === MAGIC[2] &&
    bytes[3] === MAGIC[3]
  );
}

/* Info-bitset positions — must mirror UISnapshotBinaryWriter exactly. */
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

/* resolved presence-mask positions (field order below mirrors the writer). */
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

/* Data sub-value kind tags (see the writer — the only values toPlain produces). */
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
      if (shift > 63) throw new MdsDecodeError("MDS_TRUNCATED", "varint longer than 10 bytes");
    }
  }

  /** Zigzag i32 → signed. Numeric math only (values are ≤ 2^33; no bigint needed). */
  zigzag(): number {
    const raw = this.varUint();
    const negative = raw % 2 === 1;
    const magnitude = (raw - (negative ? 1 : 0)) / 2;
    return negative ? -(magnitude + 1) : magnitude;
  }

  /** Quantized i32 → the 0.01-precision float the writer committed to. */
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

  /** Load the string table (count + sequential entries). */
  loadTable(): void {
    const count = this.varUint();
    this.table = new Array(count);
    for (let i = 0; i < count; i++) {
      this.table[i] = this.inlineString();
    }
  }

  /** 0 = null, n → table[n-1]. */
  stringRef(): string | null {
    const ref = this.varUint();
    if (ref === 0) return null;
    const index = ref - 1;
    if (index < 0 || index >= this.table.length) {
      throw new MdsDecodeError(
        "MDS_STRING_REF_OUT_OF_RANGE",
        `string ref ${ref} beyond the table (${this.table.length} entries)`,
      );
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
      throw new MdsDecodeError("MDS_TRUNCATED", `read of ${count} byte(s) beyond end of file at ${this.offset}`);
    }
  }
}

/** Decode one MDS container: snapshot file (`manifest: false`) or theme manifest (ADR-0007). */
export function decodeMdsBytes(
  bytes: Uint8Array,
  options: { manifest?: boolean } = {},
): MdsSnapshotDoc | { manifest: MdsThemeManifest } {
  if (!hasMdsMagic(bytes)) {
    throw new MdsDecodeError("MDS_MAGIC_UNKNOWN", "not an 'MDS' v3 binary snapshot artifact");
  }

  const r = new MdsReader(bytes);
  r.skipMagic();

  const formatVersion = r.u8();
  const schemaVersion = r.u8();
  if (formatVersion !== 3 || schemaVersion !== 3) {
    throw new MdsDecodeError(
      "MDS_FORMAT_VERSION",
      `formatVersion ${formatVersion} / schemaVersion ${schemaVersion} is not supported (3/3 expected)`,
    );
  }
  const flags = r.u8();
  const deltaMode = !options.manifest && (flags & 1) === 1;

  r.loadTable();

  if (options.manifest) {
    const entries: MdsThemeManifest = new Array(r.varUint());
    for (let i = 0; i < entries.length; i++) {
      const hash = r.inlineString();
      const present = r.varUint() !== 0;
      entries[i] = { hash, theme: present ? decodeTheme(r) : null };
    }
    return { manifest: entries };
  }

  // ---- theme section (mode varint: 0 absent, 1 inline, 2 manifest ref) ----
  let theme: MdsThemeDoc | null = null;
  let themeRef: string | null = null;
  const themeMode = r.varUint();
  if (themeMode === 2) {
    themeRef = r.inlineString();
  } else if (themeMode === 1) {
    theme = decodeTheme(r);
  }

  // ---- head (shared by anchor and delta forms) ----
  const head: MdsHead = {
    formatVersion,
    schemaVersion,
    timestampUtc: r.stringRef(),
    app: r.present() ? decodeApp(r) : null,
    view: r.present() ? decodeView(r) : null,
    theme,
    themeRef,
    source: r.stringRef(),
  };

  return deltaMode ? decodeDelta(r, head) : decodeAnchor(r, head);
}

function decodeApp(r: MdsReader): Record<string, unknown> {
  return {
    productName: r.stringRef(),
    productVersion: r.stringRef(),
    unityVersion: r.stringRef(),
    platform: r.stringRef(),
    deviceType: r.stringRef(),
    sessionId: r.stringRef(),
    screenWidth: r.quantized(),
    screenHeight: r.quantized(),
    scaleFactor: r.quantized(),
  };
}

function decodeView(r: MdsReader): Record<string, unknown> {
  return {
    id: r.stringRef(),
    name: r.stringRef(),
    type: r.stringRef(),
    layer: r.stringRef(),
  };
}

function decodeTheme(r: MdsReader): MdsThemeDoc {
  const isDark = r.varUint() !== 0;
  const seedColor = r.stringRef();
  const deviceType = r.stringRef();

  const palette: Record<string, string> = {};
  const paletteCount = r.varUint();
  for (let i = 0; i < paletteCount; i++) {
    const key = r.stringRef();
    if (key !== null) palette[key] = r.stringRef() ?? "";
  }

  const spacing: Record<string, number> = {};
  const spacingCount = r.varUint();
  for (let i = 0; i < spacingCount; i++) {
    const key = r.stringRef();
    if (key !== null) spacing[key] = r.quantized();
  }

  const sizing: Record<string, number> = {};
  const sizingCount = r.varUint();
  for (let i = 0; i < sizingCount; i++) {
    const key = r.stringRef();
    if (key !== null) sizing[key] = r.quantized();
  }

  const typography: Record<string, Record<string, unknown>> = {};
  const typographyCount = r.varUint();
  for (let i = 0; i < typographyCount; i++) {
    const role = r.stringRef();
    if (role !== null) {
      typography[role] = {
        fontSize: r.quantized(),
        fontWeight: r.stringRef(),
        fontStyle: r.stringRef(),
        fontName: r.stringRef(),
        characterSpacing: r.quantized(),
        lineSpacing: r.quantized(),
      };
    }
  }

  return { seedColor, isDark, deviceType, palette, spacing, sizing, typography };
}

/** Anchor form: pre-order node stream; the childCount stack rebuilds parentId. */
function decodeAnchor(r: MdsReader, head: MdsHead): MdsSnapshotDoc {
  const count = r.varUint();
  const nodes: MdsNodeDoc[] = new Array(count);

  // Classic pre-order reconstruction: `stackIds`/`stack` hold the ancestors'
  // identities and remaining child slots. On each node: pop completed frames,
  // read the node (its parent is the current stack top), consume one parent
  // slot, then push its own frame.
  const stackIds: string[] = [];
  const stack: number[] = [];

  for (let i = 0; i < count; i++) {
    while (stack.length > 0 && stack[stack.length - 1] === 0) {
      stack.pop();
      stackIds.pop();
    }
    const parentId = stackIds.length > 0 ? stackIds[stackIds.length - 1]! : null;

    const childCount = r.varUint();
    const node = decodeNodeBody(r, parentId);
    nodes[i] = node;

    if (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      stack[stack.length - 1] = top - 1;
    }
    stackIds.push(node.id ?? "");
    stack.push(childCount);
  }

  return { ...head, contentMode: "anchor", nodes, delta: null };
}

/** Delta form (ADR-0009): the sparse chain member, stored as its own artifact. */
function decodeDelta(r: MdsReader, head: MdsHead): MdsSnapshotDoc {
  const baseHash = r.inlineString();

  const bases: string[] = [];
  const basesCount = r.varUint();
  for (let i = 0; i < basesCount; i++) {
    bases.push(r.inlineString());
  }

  const nodeCount = r.varUint();
  const fingerprint = r.varUint();

  const removedIds: string[] = [];
  const removedCount = r.varUint();
  for (let i = 0; i < removedCount; i++) {
    removedIds.push(r.stringRef() ?? "");
  }

  const added: MdsNodeDoc[] = [];
  const addedCount = r.varUint();
  for (let i = 0; i < addedCount; i++) {
    added.push(decodePatchNode(r));
  }

  const changed: MdsNodeDoc[] = [];
  const changedCount = r.varUint();
  for (let i = 0; i < changedCount; i++) {
    changed.push(decodePatchNode(r));
  }

  return { ...head, contentMode: "delta", delta: { baseHash, bases, nodeCount, fingerprint, removedIds, added, changed } };
}

/** Patch flavor: id, parentId precede the shared node body (siblingIndex is part of it). */
function decodePatchNode(r: MdsReader): MdsNodeDoc {
  const id = r.stringRef();
  const parentId = r.stringRef();
  const body = decodeNodeBody(r, parentId);
  body.id = id;
  return body;
}

function decodeNodeBody(r: MdsReader, parentId: string | null): MdsNodeDoc {
  const info = r.varUint();
  const siblingIndex = r.zigzag();
  const id = r.stringRef();
  const name = r.stringRef();
  const type = r.stringRef();

  const node: MdsNodeDoc = {
    id,
    kind: info & (1 << InfoKindLayout) ? "layout" : "ui",
    name,
    type,
    siblingIndex,
    parentId,
    active: (info & (1 << InfoActive)) !== 0,
    isView: (info & (1 << InfoIsView)) !== 0,
  };

  if (info & (1 << InfoHasLayer)) node.layer = r.stringRef();

  if (info & (1 << InfoHasRect)) node.rect = decodeRect(r);
  if (info & (1 << InfoHasRectLocal)) node.rectLocal = decodeRect(r);
  if (info & (1 << InfoHasAnchor)) node.anchor = decodeAnchorBlock(r);

  if (info & (1 << InfoHasLayout)) {
    const layoutType = r.stringRef();
    const bools = r.varUint();
    node.layout = {
      type: layoutType,
      paddingLeft: r.quantized(),
      paddingRight: r.quantized(),
      paddingTop: r.quantized(),
      paddingBottom: r.quantized(),
      spacing: r.quantized(),
      childAlignment: r.stringRef(),
      runtimeSwitchable: (bools & 1) !== 0,
      controlChildWidth: (bools & (1 << 1)) !== 0,
      controlChildHeight: (bools & (1 << 2)) !== 0,
      childForceExpandWidth: (bools & (1 << 3)) !== 0,
      childForceExpandHeight: (bools & (1 << 4)) !== 0,
      reverseArrangement: (bools & (1 << 5)) !== 0,
    };
  }

  if (info & (1 << InfoHasLayoutElement)) {
    // Writer order: six quantized floats FIRST, then the ignoreLayout varint.
    const minWidth = r.quantized();
    const minHeight = r.quantized();
    const preferredWidth = r.quantized();
    const preferredHeight = r.quantized();
    const flexibleWidth = r.quantized();
    const flexibleHeight = r.quantized();
    const ignoreLayout = r.varUint() !== 0;
    node.layoutElement = {
      minWidth,
      minHeight,
      preferredWidth,
      preferredHeight,
      flexibleWidth,
      flexibleHeight,
      ignoreLayout,
    };
  }

  if (info & (1 << InfoHasContentSizeFitter)) {
    node.contentSizeFitter = {
      horizontalMode: r.stringRef(),
      verticalMode: r.stringRef(),
    };
  }

  if (info & (1 << InfoHasData)) node.data = decodeDataMap(r);

  if (info & (1 << InfoHasResolved)) {
    const mask = r.varUint();
    const resolved: Record<string, unknown> = {};
    const readString = () => r.stringRef();
    if (mask & (1 << ResolvedColorRoles)) {
      const roles: Record<string, string> = {};
      const count = r.varUint();
      for (let i = 0; i < count; i++) {
        const key = r.stringRef();
        if (key !== null) roles[key] = readString() ?? "";
      }
      resolved["colorRoles"] = roles;
    }
    if (mask & (1 << ResolvedTextRole)) resolved["textRole"] = readString();
    if (mask & (1 << ResolvedText)) resolved["text"] = readString();
    if (mask & (1 << ResolvedFontSize)) resolved["fontSize"] = r.quantized();
    if (mask & (1 << ResolvedFontWeight)) resolved["fontWeight"] = readString();
    if (mask & (1 << ResolvedFontName)) resolved["fontName"] = readString();
    if (mask & (1 << ResolvedTextWidth)) resolved["textWidth"] = r.quantized();
    if (mask & (1 << ResolvedColor)) resolved["color"] = readString();
    if (mask & (1 << ResolvedBackgroundColor)) resolved["backgroundColor"] = readString();
    if (mask & (1 << ResolvedFillColor)) resolved["fillColor"] = readString();
    if (mask & (1 << ResolvedOutlineColor)) resolved["outlineColor"] = readString();
    if (mask & (1 << ResolvedOutlineWidth)) resolved["outlineWidth"] = r.quantized();
    if (mask & (1 << ResolvedOpacity)) resolved["opacity"] = r.quantized();
    if (mask & (1 << ResolvedCornerRadius)) resolved["cornerRadius"] = r.quantized();
    node.resolved = resolved;
  }

  if (info & (1 << InfoHasError)) node.error = r.stringRef();
  return node;
}

function decodeRect(r: MdsReader): { x: number; y: number; width: number; height: number } {
  return {
    x: r.quantized(),
    y: r.quantized(),
    width: r.quantized(),
    height: r.quantized(),
  };
}

function decodeAnchorBlock(r: MdsReader): Record<string, number> {
  return {
    pivotX: r.quantized(),
    pivotY: r.quantized(),
    anchorMinX: r.quantized(),
    anchorMinY: r.quantized(),
    anchorMaxX: r.quantized(),
    anchorMaxY: r.quantized(),
    anchoredX: r.quantized(),
    anchoredY: r.quantized(),
    sizeX: r.quantized(),
    sizeY: r.quantized(),
  };
}

function decodeDataMap(r: MdsReader): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const count = r.varUint();
  for (let i = 0; i < count; i++) {
    const key = r.stringRef();
    if (key !== null) out[key] = decodeDataValue(r);
  }
  return out;
}

function decodeDataValue(r: MdsReader): unknown {
  const kind = r.varUint();
  switch (kind) {
    case DataKindNull:
      return null;
    case DataKindBool:
      return r.varUint() !== 0;
    case DataKindInt:
      return r.zigzag();
    case DataKindFloat:
      return r.quantized();
    case DataKindString:
      return r.stringRef();
    case DataKindList: {
      const list: unknown[] = new Array(r.varUint());
      for (let i = 0; i < list.length; i++) list[i] = decodeDataValue(r);
      return list;
    }
    case DataKindMap: {
      const map: Record<string, unknown> = {};
      const count = r.varUint();
      for (let i = 0; i < count; i++) {
        const key = r.stringRef();
        if (key !== null) map[key] = decodeDataValue(r);
      }
      return map;
    }
    case DataKindSymbol:
      return { code: r.zigzag(), fill: r.varUint() !== 0 };
    default:
      throw new MdsDecodeError("MDS_DATA_KIND", `unknown data value kind ${kind}`);
  }
}
