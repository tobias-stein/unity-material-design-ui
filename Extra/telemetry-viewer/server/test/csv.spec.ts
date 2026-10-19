import { describe, expect, it } from "vitest";
import { parseAnnotatedCsv, rfc3339ToNs, splitCsvLine } from "../src/sources/csv.js";

describe("rfc3339ToNs", () => {
  it("keeps full nanosecond precision", () => {
    expect(rfc3339ToNs("2026-01-15T10:20:30.123456789Z")).toBe(1_768_472_430_123_456_789n);
    expect(rfc3339ToNs("2026-01-15T10:20:30.123456789-02:00")).toBe(1_768_479_630_123_456_789n);
    expect(rfc3339ToNs("2025-10-09T08:53:20Z")).toBe(1_760_000_000_000_000_000n);
  });

  it("rejects garbage", () => {
    expect(rfc3339ToNs("not-a-time")).toBeNull();
    expect(rfc3339ToNs("")).toBeNull();
  });
});

describe("splitCsvLine", () => {
  it("honors quoting", () => {
    expect(splitCsvLine('a,"b,c","豪华 ""quoted"" value"')).toEqual(["a", "b,c", '豪华 "quoted" value']);
  });
});

describe("parseAnnotatedCsv (Influx wire format)", () => {
  it("parses the committed Influx reference corpus for smoketest01", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const fixture = await readFile(
      path.join(import.meta.dirname, "fixtures", "csv-smoketest01.csv"),
      "utf8",
    );
    const parsed = parseAnnotatedCsv(fixture);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      _measurement: "ui_event",
      _field: "value",
      _value: "1",
      session: "smoketest01",
      type: "click",
      view: "MainView",
      view_id: "v1",
      element: "e1",
      element_type: "mdu.ui.Button",
      _time: "2025-10-09T08:53:20Z",
    });
  });

  it("consumes full annotation rows and typed cells", () => {
    const csv = [
      "#datatype,string,string,dateTime:RFC3339,double,string,string,boolean",
      "#group,false,false,false,false,false,false,false",
      "#default,_result,,,,,,,",
      ",result,table,_time,_value,_field,_measurement,flag",
      ',_result,0,2026-01-15T10:20:30.5Z,0.5,dwell,ui_event,false',
      ",_result,0,2026-01-15T10:20:31Z,,missing,ui_event,true",
    ].join("\r\n");
    const parsed = parseAnnotatedCsv(csv);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]!._value).toBe(0.5);
    expect(parsed.records[0]!.flag).toBe(false);
    expect(parsed.records[1]!._value).toBe(null);
    expect(parsed.records[1]?.flag).toBe(true);
  });

  it("preserves rows whose values contain commas/newlines", () => {
    const csv = ',result,_time,value\n,_result,"2026-01-15T10:20:30Z","multi,\nline"';
    const parsed = parseAnnotatedCsv(csv);
    expect(parsed.records[0]!.value).toBe("multi,\nline");
  });

  it("handles multi-table OSS output (blank line + new header per table)", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const fixture = await readFile(
      path.join(import.meta.dirname, "fixtures", "csv-multi-table-smoketest.csv"),
      "utf8",
    );
    const parsed = parseAnnotatedCsv(fixture);
    // Two sessions → several result tables with per-table headers; each row
    // is one field value; records must be typed and complete per column.
    expect(parsed.records.length).toBeGreaterThan(10);
    for (const record of parsed.records) {
      expect(["ui_event", "session"]).toContain(record["_measurement"]);
      expect(typeof record["_time"]).toBe("string");
      expect(typeof record["session"]).toBe("string");
    }
    expect(parsed.records.some((r) => r["_field"] === "dwell" && (r["_value"] as number) > 0)).toBe(true);
    expect(parsed.records.some((r) => r["_field"] === "value")).toBe(true);
  });
});
