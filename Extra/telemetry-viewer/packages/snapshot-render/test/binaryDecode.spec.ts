/**
 * MDS decoder contract tests (snapshot package copy, ADR-0008/0007).
 *
 * The mini-encoder here is a deliberately independent implementation of the
 * wire contract pinned in UISnapshotBinaryWriter.cs — two TS encoders of the
 * same contract locking the one TS decoder this package ships (the server's
 * parse.ts twin runs the richer chain/materialization fixtures in
 * telemetry-viewer/server/test/mdsFormat.spec.ts).
 */
import { describe, expect, it } from "vitest";
import { decodeMdsBytes, hasMdsMagic, MdsDecodeError, type MdsSnapshotDoc } from "../src/binaryDecode.js";

class Enc {
  table: string[] = [];
  private ids = new Map<string, number>();
  data: number[] = [];
  varUint(v: number): void {
    let value = v;
    for (;;) {
      const b = value & 0x7f;
      value = Math.floor(value / 128);
      this.data.push(value ? b | 0x80 : b);
      if (!value) return;
    }
  }
  i32(v: number): void {
    this.varUint(((v << 1) ^ (v >> 31)) >>> 0);
  }
  quant(f: number): number {
    return Math.round(f * 100);
  }
  ref(s: string | null): void {
    if (s === null) {
      this.varUint(0);
      return;
    }
    let i = this.ids.get(s);
    if (i === undefined) {
      i = this.table.length;
      this.ids.set(s, i);
      this.table.push(s);
    }
    this.varUint(i + 1);
  }

  inline(value: string): void {
    const bytes = [...new TextEncoder().encode(value)];
    this.varUint(bytes.length);
    this.data.push(...bytes);
  }

  finish(flags: number): Uint8Array {
    const out: number[] = [0x4d, 0x44, 0x53, 0x0a, 3, 3, flags & 0xff];
    const ev = (v: number, into: number[]): void => {
      let value = v;
      for (;;) {
        const b = value & 0x7f;
        value = Math.floor(value / 128);
        into.push(value ? b | 0x80 : b);
        if (!value) return;
      }
    };
    ev(this.table.length, out);
    for (const s of this.table) {
      const b = [...new TextEncoder().encode(s)];
      ev(b.length, out);
      out.push(...b);
    }
    out.push(...this.data);
    return Uint8Array.from(out);
  }
}

function anchorBytes(): Uint8Array {
  const w = new Enc();
  w.varUint(1); // theme inline (empty theme: 0 maps)
  w.varUint(0); // isDark
  w.ref("#6750A4"); // seed
  w.ref("Default"); // device
  w.varUint(0); // palette
  w.varUint(0); // spacing
  w.varUint(0); // sizing
  w.varUint(0); // typography
  w.ref("t");
  w.varUint(1); // app present
  w.ref("prod"); w.ref("1.0"); w.ref("6000"); w.ref("OSX"); w.ref("Desktop"); w.ref("s1");
  w.i32(w.quant(1920)); w.i32(w.quant(1080)); w.i32(w.quant(2));
  w.varUint(1); // view present
  w.ref("v1"); w.ref("Demo"); w.ref("mdu.ui.Demo"); w.ref("DEFAULT");
  w.ref("view-transition");
  w.varUint(3); // node count
  // root (2 children)
  w.varUint(2);
  w.varUint((1 << 2) | (1 << 1) | (1 << 3)); // active | isView | rect
  w.i32(0);
  w.ref("root"); w.ref("Demo"); w.ref("mdu.ui.Demo");
  w.i32(w.quant(0)); w.i32(w.quant(0)); w.i32(w.quant(800)); w.i32(w.quant(600));
  // child A (leaf)
  w.varUint(0);
  w.varUint(1 << 2); // active
  w.i32(0);
  w.ref("a"); w.ref("Btn"); w.ref("mdu.ui.Button");
  // child B (leaf)
  w.varUint(0);
  w.varUint(1 << 2);
  w.i32(1);
  w.ref("b"); w.ref("Label"); w.ref("mdu.ui.Text");

  const out: number[] = [0x4d, 0x44, 0x53, 0x0a, 3, 3, 0];
  const ev = (v: number): void => {
    let value = v;
    for (;;) {
      const b = value & 0x7f;
      value = Math.floor(value / 128);
      out.push(value ? b | 0x80 : b);
      if (!value) return;
    }
  };
  ev(w.table.length);
  for (const s of w.table) {
    const b = [...new TextEncoder().encode(s)];
    ev(b.length);
    out.push(...b);
  }
  out.push(...w.data);
  return Uint8Array.from(out);
}

describe("binaryDecode (ADR-0008)", () => {
  it("sniffs the MDS magic and never a gzip/YAML header", () => {
    expect(hasMdsMagic(anchorBytes())).toBe(true);
    expect(hasMdsMagic(new Uint8Array([0x1f, 0x8b, 0, 0]))).toBe(false);
    expect(hasMdsMagic(new Uint8Array([0x4d, 0x44, 0x53, 0x0a]))).toBe(true);
  });

  it("decodes an anchor doc: string table, quantized rects, pre-order hierarchy", () => {
    const doc = decodeMdsBytes(anchorBytes()) as MdsSnapshotDoc;
    expect(doc.contentMode).toBe("anchor");
    expect(doc.schemaVersion).toBe(3);
    expect(doc.app?.sessionId).toBe("s1");
    expect(doc.view?.name).toBe("Demo");
    expect(doc.theme?.seedColor).toBe("#6750A4");
    expect(doc.nodes?.map((n) => n.id)).toEqual(["root", "a", "b"]);
    expect(doc.nodes?.[0]!.rect).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(doc.nodes?.[1]!.parentId).toBe("root");
    expect(doc.nodes?.[2]!.parentId).toBe("root");
    expect(doc.nodes?.[2]!.siblingIndex).toBe(1);
  });

  it("rejects bad headers and truncation with typed errors", () => {
    const badVersion = anchorBytes();
    badVersion[4] = 2;
    expect(() => decodeMdsBytes(badVersion)).toThrow(MdsDecodeError);
    const truncated = anchorBytes().slice(0, -3);
    expect(() => decodeMdsBytes(truncated)).toThrow(MdsDecodeError);
  });

  it("decodes a theme manifest artifact (hash → theme entries)", () => {
    const w = new Enc();
    const manifestHash = "abcd1234";
    w.varUint(1); // entries
    w.inline(manifestHash); // hash rides inline (not interned)
    w.varUint(1); // present
    w.varUint(0); // isDark
    w.ref("#6750A4"); // seedColor (interned)
    w.ref("Default"); // deviceType
    w.varUint(0); w.varUint(0); w.varUint(0); w.varUint(0); // palette/spacing/sizing/typography
    const bytes = w.finish(0);

    const decoded = decodeMdsBytes(bytes, { manifest: true }) as { manifest: Array<{ hash: string; theme: Record<string, unknown> | null }> };
    expect(decoded.manifest).toHaveLength(1);
    expect(decoded.manifest[0]!.hash).toBe(manifestHash);
    expect(decoded.manifest[0]!.theme?.seedColor).toBe("#6750A4");
  });
});
