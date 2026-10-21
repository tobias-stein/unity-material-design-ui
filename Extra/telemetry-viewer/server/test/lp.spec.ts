import { describe, expect, it } from "vitest";
import { parseLpDocuments, parseLpLine, unescapeTagValue, unescapeFieldString } from "../src/sources/lp.js";
import type { RawEvent } from "../src/domain.js";

describe("lp tag unescaping (parity with LineProtocolSerializer)", () => {
  it("unescapes \\s \\, \\= \\\\ exactly", () => {
    expect(unescapeTagValue("My\\sView\\,Weird\\=Name\\s\\\\\\s\"Quoted\"")).toBe("My View,Weird=Name \\ \"Quoted\"");
  });

  it("keeps unknown escapes verbatim (resilient)", () => {
    expect(unescapeTagValue("\\x")).toBe("\\x");
  });

  it("unescapes field strings only \\\" and \\\\", () => {
    expect(unescapeFieldString("hash\\\"with\\\\backslash")).toBe('hash"with\\backslash');
    // Unity-style \s written into a quoted field stays literal.
    expect(unescapeFieldString("a\\sb")).toBe("a\\sb");
  });
});

describe("parseLpLine", () => {
  it("parses a bare ui_event line (no tags beyond session)", () => {
    const parsed = parseLpLine("session,session=abc,type=start value=1i 1768471200000000000");
    expect(parsed).not.toBeTypeOf("string");
    if (typeof parsed === "string") throw new Error("should parse");
    expect(parsed.measurement).toBe("session");
    expect(parsed.tags).toEqual([
      ["session", "abc"],
      ["type", "start"],
    ]);
    expect(parsed.fields).toEqual([["value", { kind: "int", value: 1 }]]);
    expect(parsed.timestampNs).toBe(1768471200000000000n);
  });

  it("parses fields of every runtime shape", () => {
    const parsed = parseLpLine(
      'ui_event,session=s,type=toggle,element=btn value=1i,on=true,dwell=123.456,hash="ca\\=fe" 1000000000',
    );
    if (typeof parsed === "string") throw new Error("should parse");
    const fields = Object.fromEntries(parsed.fields);
    expect(fields).toEqual({
      value: { kind: "int", value: 1 },
      on: { kind: "bool", value: true },
      dwell: { kind: "float", value: 123.456 },
      hash: { kind: "string", value: "ca\\=fe" },
    });
  });

  it("falls back to RFC3339 timestamps", () => {
    const parsed = parseLpLine("ui_event value=1i 2026-01-15T10:20:30.5Z");
    if (typeof parsed === "string") throw new Error("should parse");
    expect(parsed.timestampNs).toBe(1_768_472_430_500_000_000n);
  });

  it("reports each malformed shape", () => {
    expect(parseLpLine("")).toBeTypeOf("string");
    expect(parseLpLine("ui_event")).toMatch(/missing field section/);
    expect(parseLpLine("ui_event,session=s value=1i")).toMatch(/missing timestamp/);
    expect(parseLpLine("ui_event,session= 1768471200000000000")).toMatch(/missing fields|malformed/);
    expect(parseLpLine("ui_event,session=s,=broken value=1i 1768471200000000000")).toMatch(/malformed tag/);
    expect(parseLpLine("ui_event,session=s value=nonsense 1768471200000000000")).toMatch(/malformed field value/);
    expect(parseLpLine("ui_event,session=s value=1ilienotatime")).toMatch(/malformed field value/);
  });
});

describe("parseLpDocuments over the P0 fixture corpus", () => {
  it("sorts events nanosecond-ascending and skips malformed lines with count", () => {
    const result = parseLpDocuments([
      {
        file: "edge-events.lp",
        content: [
          "session,session=0a11be11caf00d320a11be11caf00d32,type=start value=1i 1768471200000000000",
          "ui_event,session=0a11be11caf00d320a11be11caf00d32,type=view_open,view=UIDemoMainMenu,view_id=a8c1e0f42b7d4f8e9a2c3d405e6f7081 value=1i 1768471201000000000",
          "broken,,line",
        ].join("\n"),
      },
    ]);
    expect(result.events).toHaveLength(2);
    expect(result.malformedCount).toBe(1);
    expect(result.error?.code).toBe("MALFORMED_LINE");
    expect(result.events[0]!.timestampNs).toBeLessThan(result.events[1]!.timestampNs);
  });

  it("normalizes CRLF and ignores comments/blanks", () => {
    const result = parseLpDocuments([
      { file: "crlf.lp", content: "# comment\r\n\r\nui_event,session=s,type=click value=1i 5\r\n" },
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.malformedCount).toBe(0);
  });

  it("maps the escaping fixture into exact domain tags", () => {
    const { events } = parseLpDocuments([
      {
        file: "edge-escaping.lp",
        content: [
          'ui_event,session=1e55capedf1f115e1e55capedf1f115e,type=view_open,view=My\\sView\\,Weird\\=Name\\s\\\\\\s"Quoted",view_id=c8\\\\\\=x\\\\\\,y\\sz000000000000000000000000000 value=1i 1769932800000000000',
        ].join("\n"),
      },
    ]);
    expect(events).toHaveLength(1);
    const e = events[0] as RawEvent;
    expect(e.tags.view).toBe('My View,Weird=Name \\ "Quoted"');
    expect(e.tags.view_id).toBe("c8\\=x\\,y z000000000000000000000000000");
    expect(e.timestampNs / 1_000_000n).toBe(1769932800000n);
  });
});

describe("ui_snapshot_taken wire shape (Unity LineProtocolSerializer contract)", () => {
  const shaKey = "snapshots/2026/10/20/UIDemoMainMenu(Clone)-20261020-100838.yaml";
  const shaHash = "f7d3d4a7779357da44f209298e7a88155150bb75d2fbd23661877675ff013c03";
  const session = "a4e816176fb54bda8ddcbd08f2dc0f8c";

  /** Exactly what `serializeSnapshotTaken` must emit after the separator fix. */
  const wellFormed =
    `ui_snapshot_taken,session=${session},view=UIDemoMainMenu(Clone),view_id=dca8b6d508e74620b67fa2f8b582e39c ` +
    `key="${shaKey}",hash="${shaHash}",nodes=95i,width=1920,height=1080,` +
    'owner="Unity-MaterialDesign-UI",platform="OSXEditor",screen="1920x1080" 1792490918662325000';

  it("parses a fully-formed snapshot ledger point with every field typed", () => {
    const parsed = parseLpLine(wellFormed);
    if (typeof parsed === "string") throw new Error(`should parse: ${parsed}`);
    expect(parsed.measurement).toBe("ui_snapshot_taken");
    expect(parsed.tags).toEqual([
      ["session", session],
      ["view", "UIDemoMainMenu(Clone)"],
      ["view_id", "dca8b6d508e74620b67fa2f8b582e39c"],
    ]);
    expect(parsed.fields).toEqual([
      ["key", { kind: "string", value: shaKey }],
      ["hash", { kind: "string", value: shaHash }],
      ["nodes", { kind: "int", value: 95 }],
      ["width", { kind: "float", value: 1920 }],
      ["height", { kind: "float", value: 1080 }],
      ["owner", { kind: "string", value: "Unity-MaterialDesign-UI" }],
      ["platform", { kind: "string", value: "OSXEditor" }],
      ["screen", { kind: "string", value: "1920x1080" }],
    ]);
    expect(parsed.timestampNs).toBe(1792490918662325000n);

    const { events, malformedCount } = parseLpDocuments([{ file: "snap.lp", content: `${wellFormed}\n` }]);
    expect(malformedCount).toBe(0);
    expect(events[0]!.fields).toMatchObject({ key: shaKey, hash: shaHash, nodes: 95, width: 1920, height: 1080 });
    expect(events[0]!.tags.view_id).toBe("dca8b6d508e74620b67fa2f8b582e39c");
  });

  it("drops the fused tag/field shape Unity emitted before the separator fix", () => {
    // Regression: the first field fused straight onto the tag set (no space),
    // so the only space left was before the timestamp — the parser read the
    // timestamp as the field section and rejected the whole line.
    const fused = wellFormed.replace('view_id=dca8b6d508e74620b67fa2f8b582e39c key=', 'view_id=dca8b6d508e74620b67fa2f8b582e39ckey=');
    const result = parseLpDocuments([{ file: "snap.lp", content: `${fused}\n` }]);
    expect(result.events).toHaveLength(0);
    expect(result.malformedCount).toBe(1);
    expect(result.error?.code).toBe("MALFORMED_LINE");
  });
});
