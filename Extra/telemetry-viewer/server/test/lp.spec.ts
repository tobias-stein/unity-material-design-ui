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
