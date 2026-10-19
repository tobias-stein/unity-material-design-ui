/**
 * Parity suite (P1 acceptance §14): the `.lp` file source and the InfluxDB
 * source must produce **identical raw events → identical sessions**.
 *
 * The committed reference corpus carries both wire shapes of the same traffic:
 * `replay-*.lp` files (the canonical replays) and `csv-smoketest01.csv`
 * (the exact Flux/annotated-CSV response for the same session). Any future
 * divergence between the source paths fails here.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseLpDocuments } from "../src/sources/lp.js";
import { parseAnnotatedCsv } from "../src/sources/csv.js";
import { recordsToRawEvents } from "../src/sources/influx.js";
import { projectSessions } from "../src/core/sessionProjection.js";
import { LpFileListSource } from "../src/sources/lpFiles.js";
import { buildSessionCatalog, filterSessions } from "../src/core/sessionCatalog.js";
import { Measurements, type RawEvent, type SourceProvider } from "../src/domain.js";

const fixturesDir = path.join(import.meta.dirname, "fixtures");

async function lpEvents(file: string): Promise<RawEvent[]> {
  const content = await readFile(path.join(fixturesDir, file), "utf8");
  return parseLpDocuments([{ file, content }]).events;
}

/** CSV-cell escaping exactly as InfluxDB quotes it (double-quote doubling). */
function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe("parity: annotated-CSV (Influx wire) ↔ line protocol", () => {
  it("smoketest01: CSV rows and the replay .lp file yield identical raw events and sessions", async () => {
    const csvText = await readFile(path.join(fixturesDir, "csv-smoketest01.csv"), "utf8");
    const parsed = parseAnnotatedCsv(csvText);
    expect(parsed.columns.length).toBeGreaterThan(5);

    const fromCsv = recordsToRawEvents(parsed.records);
    const fromLp = await lpEvents("replay-smoketest01.lp");

    expect(stableEvents(fromCsv)).toEqual(stableEvents(fromLp));
    expect(stableSessions(projectSessions(fromCsv))).toEqual(stableSessions(projectSessions(fromLp)));
  });

  it("escaped runtime values survive the Influx CSV round-trip", () => {
    const lpText =
      "ui_event,element=btn\\s\\\\\\sAdd\\\\\\,Load\\=1\\\\,element_type=mdu.ui.Fancy\\sButton," +
      'session=s1,type=click,view=My\\sView\\,Weird\\=Name\\s\\\\\\s"Quoted",view_id=v-abc value=1i 1769932800123456789\n';
    const row = [
      "_result",
      "0",
      "2026-02-01T08:00:00.123456789Z",
      "1",
      "value",
      Measurements.UiEvent,
      "btn \\ Add\\,Load=1\\",
      "mdu.ui.Fancy Button",
      "s1",
      "click",
      'My View,Weird=Name \\ "Quoted"',
      "v-abc",
    ]
      .map(csvCell)
      .join(",");
    const csvText = [
      "#datatype,string,string,dateTime:RFC3339,double,string,string,string,string,string,string,string",
      "#group,false,false,false,false,false,false,false,false,false,false,false",
      "#default,_result,,,,,,,,,,",
      ",result,table,_time,_value,_field,_measurement,element,element_type,session,type,view,view_id",
      `,${row}`,
    ].join("\n");

    const fromLp = parseLpDocuments([{ file: "a.lp", content: lpText }]).events;
    const fromCsv = recordsToRawEvents(parseAnnotatedCsv(csvText).records);

    expect(fromLp).toHaveLength(1);
    expect(fromCsv).toHaveLength(1);
    expect(fromCsv[0]!.tags.element).toBe(fromLp[0]!.tags.element);
    expect(fromCsv[0]!.tags.view).toBe(fromLp[0]!.tags.view);
    expect(fromCsv[0]!.tags.view_id).toBe(fromLp[0]!.tags.view_id);
    expect(fromCsv[0]!.tags.element_type).toBe(fromLp[0]!.tags.element_type);
    expect(fromCsv[0]!.fields.value).toBe(1);
    expect(fromCsv[0]!.timestampNs).toBe(fromLp[0]!.timestampNs);
  });

  it("catalog: file-backed sessions win over Influx and are counted once", async () => {
    const influxEcho: SourceProvider = {
      id: "influx",
      describe: async () => ({ id: "influx", available: true, state: "ok", facts: {} }),
      // Pretend Influx already ingested everything (flushed outbox); per §6.1
      // those sessions must be ignored in favor of the file source.
      fetchEvents: async () => ({ events: await lpEvents("edge-events.lp"), malformedCount: 0 }),
    };
    const files = new LpFileListSource({ root: fixturesDir });

    const catalog = await buildSessionCatalog([files, influxEcho]);
    const ids = catalog.sessions.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate sessions

    const demoIds = new Set((await lpEvents("replay-58177227c27f4653831b5487ddc9aef7.lp")).map((e) => e.tags.session));
    const fileBacked = catalog.sessions.filter((s) => demoIds.has(s.id));
    expect(fileBacked.length).toBeGreaterThan(0);
    for (const session of fileBacked) {
      expect(session.origin).toBe("lp-files");
    }

    // Edge-events session appears exactly once, attributed to files.
    const counted = ids.filter((id) => id === "0a11be11caf00d320a11be11caf00d32");
    expect(counted).toHaveLength(1);
    expect(catalog.sessions.find((s) => s.id === "0a11be11caf00d320a11be11caf00d32")!.origin).toBe("lp-files");
  });

  it("filterSessions: q / from / to / limit behave as documented", async () => {
    const files = new LpFileListSource({ root: fixturesDir });
    const catalog = await buildSessionCatalog([files]);
    const all = catalog.sessions;

    const byQ = filterSessions(all, { q: "smoketest" });
    expect(byQ.map((s) => s.id)).toEqual(["smoketest01"]);
    expect(byQ[0]!.owner).toBeNull(); // replay fixtures predate the ledger

    const limited = filterSessions(all, { limit: 2 });
    expect(limited).toHaveLength(Math.min(2, all.length));

    // Edge-events fixture: session 0a11be… spans 2026-01-15T10:00:00–10:02:11Z.
    const bounded = filterSessions(all, { fromMs: 1768471100000, toMs: 1768471350000 });
    expect(bounded.map((s) => s.id)).toContain("0a11be11caf00d320a11be11caf00d32");
    expect(filterSessions(all, { fromMs: 2_000_000_000_000 })).toHaveLength(0); // year 2033
  });
});

function stableEvents(events: RawEvent[]): unknown {
  return events.map((event) => ({
    measurement: event.measurement,
    timestampNs: event.timestampNs.toString(),
    tags: definedEntries(event.tags),
    fields: definedEntries(event.fields),
  }));
}

function stableSessions(sessions: unknown): unknown {
  return JSON.stringify(sessions, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function definedEntries(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
