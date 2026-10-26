/**
 * Fixture MDS mini-encoder (wire-format contract, test-size subset) — mirrors
 * the byte layout pinned in UISnapshotBinaryWriter.cs so drift between the
 * encoders and binaryDecode.ts/parse.ts is caught by whichever test fails.
 * Test-side only, never imported by src.
 */
import { createHash } from "node:crypto";

export interface MdsTestTheme {
  isDark: boolean;
  seedColor: string;
  deviceType: string;
  palette: Record<string, string>;
  spacing: Record<string, number>;
  sizing: Record<string, number>;
  typography: Record<string, { fontSize: number; fontWeight: string; fontStyle: string; fontName: string; characterSpacing: number; lineSpacing: number }>;
}

export interface TestNode {
  id: string;
  name: string;
  type?: string;
  kind?: "ui" | "layout";
  siblingIndex?: number;
  parentId?: string | null;
  active?: boolean;
  isView?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface TestDelta {
  baseHash: string;
  bases: string[];
  removedIds: string[];
  added: TestNode[];
  changed: TestNode[];
}

export class MdsEncode {
  readonly table: string[] = [];
  private readonly tableIndex = new Map<string, number>();
  readonly data: number[] = [];

  varUint(value: number): void {
    let v = value;
    for (;;) {
      const byte = v & 0x7f;
      v = Math.floor(v / 128);
      this.data.push(v ? byte | 0x80 : byte);
      if (!v) return;
    }
  }

  i32(value: number): void {
    this.varUint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  quant(f: number): number {
    return Math.round(f * 100);
  }

  ref(value: string | null): void {
    if (value === null) {
      this.varUint(0);
      return;
    }
    let index = this.tableIndex.get(value);
    if (index === undefined) {
      index = this.table.length;
      this.tableIndex.set(value, index);
      this.table.push(value);
    }
    this.varUint(index + 1);
  }

  inline(value: string): void {
    const bytes = [...new TextEncoder().encode(value)];
    this.varUint(bytes.length);
    this.data.push(...bytes);
  }

  rect(rect: { x: number; y: number; width: number; height: number }): void {
    this.i32(this.quant(rect.x));
    this.i32(this.quant(rect.y));
    this.i32(this.quant(rect.width));
    this.i32(this.quant(rect.height));
  }

  theme(theme: MdsTestTheme): void {
    this.varUint(theme.isDark ? 1 : 0);
    this.ref(theme.seedColor);
    this.ref(theme.deviceType);
    this.varUint(Object.keys(theme.palette).length);
    for (const key of Object.keys(theme.palette).sort()) {
      this.ref(key);
      this.ref(theme.palette[key]!);
    }
    this.varUint(Object.keys(theme.spacing).length);
    for (const key of Object.keys(theme.spacing).sort()) {
      this.ref(key);
      this.i32(this.quant(theme.spacing[key]!));
    }
    this.varUint(Object.keys(theme.sizing).length);
    for (const key of Object.keys(theme.sizing).sort()) {
      this.ref(key);
      this.i32(this.quant(theme.sizing[key]!));
    }
    this.varUint(Object.keys(theme.typography).length);
    for (const role of Object.keys(theme.typography).sort()) {
      const style = theme.typography[role]!;
      this.ref(role);
      this.i32(this.quant(style.fontSize));
      this.ref(style.fontWeight);
      this.ref(style.fontStyle);
      this.ref(style.fontName);
      this.i32(this.quant(style.characterSpacing));
      this.i32(this.quant(style.lineSpacing));
    }
  }

  app(app: { sessionId: string }): void {
    this.varUint(1); // present
    this.ref("Unity-MaterialDesign-UI");
    this.ref("0.1.0-test");
    this.ref("6000.0.0f1");
    this.ref("OSXEditor");
    this.ref("Desktop");
    this.ref(app.sessionId);
    this.i32(this.quant(1920));
    this.i32(this.quant(1080));
    this.i32(this.quant(2));
  }

  view(view: { id: string; name: string }): void {
    this.varUint(1); // present
    this.ref(view.id);
    this.ref(view.name);
    this.ref("mdu.ui." + view.name);
    this.ref("DEFAULT");
  }

  nodeBody(node: TestNode): void {
    let info = 0;
    if (node.rect) info |= 1 << 3; // InfoHasRect
    if (node.isView) info |= 1 << 1; // InfoIsView
    if (node.active !== false) info |= 1 << 2; // InfoActive
    if (node.kind === "layout") info |= 1 << 0; // InfoKindLayout
    this.varUint(info);
    this.i32(node.siblingIndex ?? 0);
    this.ref(node.id);
    this.ref(node.name);
    this.ref(node.type ?? "mdu.ui.Test");
    if (node.rect) this.rect(node.rect);
  }

  finish(flags: number): Uint8Array {
    const out: number[] = [0x4d, 0x44, 0x53, 0x0a, 3, 3, flags & 0xff];
    const emitVar = (value: number, into: number[]): void => {
      let v = value;
      for (;;) {
        const byte = v & 0x7f;
        v = Math.floor(v / 128);
        into.push(v ? byte | 0x80 : byte);
        if (!v) return;
      }
    };
    emitVar(this.table.length, out);
    for (const entry of this.table) {
      const bytes = [...new TextEncoder().encode(entry)];
      emitVar(bytes.length, out);
      out.push(...bytes);
    }
    out.push(...this.data);
    return Uint8Array.from(out);
  }
}

export const testTheme: MdsTestTheme = {
  isDark: false,
  seedColor: "#6750A4",
  deviceType: "Default",
  palette: { Primary: "#6750A4", Secondary: "#7C4DFF" },
  spacing: { m1: 0.75 },
  sizing: { h1: 12.5 },
  typography: {
    Title: {
      fontSize: 22,
      fontWeight: "Regular",
      fontStyle: "Normal",
      fontName: "Roboto-Regular SDF",
      characterSpacing: 0,
      lineSpacing: -1.5,
    },
  },
};

export function childrenOf(order: TestNode[], parent: TestNode): number {
  return order.filter((n) => (n.parentId ?? null) === (parent.id ?? null) && n !== parent).length;
}

const baseOrder = (): TestNode[] => [
  { id: "root", name: "UIDemoMainMenu", isView: true, active: true, siblingIndex: 0, parentId: null, rect: { x: 0, y: 0, width: 800, height: 600 } },
  { id: "label", name: "PlayLabel", active: true, siblingIndex: 0, parentId: "root", rect: { x: 40, y: 80, width: 200, height: 24 } },
  { id: "btn", name: "PlayButton", active: true, siblingIndex: 1, parentId: "root", rect: { x: 100, y: 100, width: 120, height: 40 } },
];

/** Anchor file: two-node view with an inline theme (mode 1), pre-order + childCount. */
export function encodeAnchor(): Uint8Array {
  const w = new MdsEncode();
  w.varUint(1); // theme mode inline
  w.theme(testTheme);
  w.ref("2026-10-25T10:00:00Z");
  w.app({ sessionId: "sess-1" });
  w.view({ id: "view1", name: "UIDemoMainMenu" });
  w.ref("view-transition");
  const order = baseOrder();
  w.varUint(order.length);
  for (const node of order) {
    w.varUint(childrenOf(order, node));
    w.nodeBody(node);
  }
  return w.finish(0);
}

/** Anchor bytes with the theme as a manifest ref (mode 2) — ADR-0007 wire form. */
export function encodeThemeRefAnchor(manifestHashHex: string): Uint8Array {
  const w = new MdsEncode();
  w.varUint(2); // theme mode: manifest ref
  w.inline(manifestHashHex);
  w.ref("2026-10-25T10:00:00Z");
  w.app({ sessionId: "sess-1" });
  w.view({ id: "view1", name: "UIDemoMainMenu" });
  w.ref("view-transition");
  const order = baseOrder();
  w.varUint(order.length);
  for (const node of order) {
    w.varUint(childrenOf(order, node));
    w.nodeBody(node);
  }
  return w.finish(0);
}

/** Theme manifest artifact (ADR-0007): hash → theme entries. */
export function encodeManifest(entries: Array<[string, MdsTestTheme | null]>): Uint8Array {
  const w = new MdsEncode();
  w.varUint(entries.length);
  for (const [hash, theme] of entries) {
    w.inline(hash);
    w.varUint(theme === null ? 0 : 1);
    if (theme !== null) w.theme(theme);
  }
  return w.finish(0);
}

/** Delta file: theme mode 0 (absent), flags bit0 = delta content mode. */
export function encodeDelta(delta: TestDelta): Uint8Array {
  const w = new MdsEncode();
  w.varUint(0); // theme absent on delta heads (the anchor carries it)
  w.ref("2026-10-25T10:00:05Z");
  w.app({ sessionId: "sess-1" });
  w.view({ id: "view1", name: "UIDemoMainMenu" });
  w.ref("mutation");

  w.inline(delta.baseHash);
  w.varUint(delta.bases.length);
  for (const base of delta.bases) w.inline(base);

  w.varUint(3); // materialized node count (fixture keeps tree shape here)
  w.varUint(0xaabbccdd); // fingerprint
  w.varUint(delta.removedIds.length);
  for (const id of delta.removedIds) w.ref(id); // removed ids are interned refs
  w.varUint(delta.added.length);
  for (const node of delta.added) {
    w.ref(node.id); // patch flavor: id + parentId precede the body
    w.ref(node.parentId ?? null);
    w.nodeBody(node);
  }
  w.varUint(delta.changed.length);
  for (const node of delta.changed) {
    w.ref(node.id);
    w.ref(node.parentId ?? null);
    w.nodeBody(node);
  }
  return w.finish(1); // flags bit0 = delta
}

export const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
