/**
 * Catalog merge behavior (regression 2026-10-21): a session id can exist in
 * both the lp-files provider (a leftover `pending-*.lp` holding only the tail
 * of a session) and InfluxDB (the acknowledged, complete picture). First-wins
 * merging discarded the Influx projection, hiding ledger snapshots from the
 * viewer — the union must keep both providers' events for the same id.
 *
 * Second regression (same day): the detail read models (timeline, aggregate)
 * re-derived events from the session's `origin` provider run. After the union
 * that run may hold only the tail (or just the start/end points), so the
 * session *looked* complete in the list yet its timeline showed zero events —
 * no marbles on any track. The catalog therefore exposes the unioned stream
 * per session, and detail models must read it, never the origin run alone.
 */
import { describe, expect, it } from "vitest";
import { buildSessionCatalog } from "../src/core/sessionCatalog.js";
import { buildTimelineFrame } from "../src/core/timeline.js";
import { Measurements, type RawEvent, type SourceProvider } from "../src/domain.js";

const SESSION = "fd5099aa8b944bbaf8ebf05c3dee5d6";

function uiEvent(ns: bigint, type: string): RawEvent {
  return {
    measurement: Measurements.UiEvent,
    timestampNs: ns,
    tags: { session: SESSION, type, view: "Main", view_id: "view-1" },
    fields: {},
  };
}

function snapshotTaken(ns: bigint): RawEvent {
  return {
    measurement: Measurements.UiSnapshotTaken,
    timestampNs: ns,
    tags: { session: SESSION, view: "Main", view_id: "view-1" },
    fields: { key: "snapshots/2026/10/21/Main-20261021-095350.yaml", hash: "abc", nodes: 95 },
  };
}

function provider(id: SourceProvider["id"], events: RawEvent[]): SourceProvider {
  return {
    id,
    describe: async () => ({ id, available: true, state: "ok", facts: {} }),
    fetchEvents: async () => ({ events, malformedCount: 0 }),
  };
}

describe("sessionCatalog merge", () => {
  it("unions a partial file-backed session with the complete Influx session", async () => {
    // Files: the leftover pending tail (2 clicks, no session/snapshot points).
    const files = provider("lp-files", [
      uiEvent(3_000_000_000n, "click"),
      uiEvent(4_000_000_000n, "click"),
    ]);
    // Influx: the acknowledged early batches — session start, view span, snapshot ledger.
    const influx = provider("influx", [
      uiEvent(1_000_000_000n, "view_open"),
      snapshotTaken(2_000_000_000n),
      uiEvent(5_000_000_000n, "view_close"),
    ]);

    const catalog = await buildSessionCatalog([files, influx]);
    expect(catalog.sessions).toHaveLength(1);

    const session = catalog.sessions[0]!;
    expect(session.id).toBe(SESSION);
    expect(session.origin).toBe("lp-files"); // files-first origin, but not first-wins data
    expect(session.eventCount).toBe(4);
    expect(session.snapshotCount).toBe(1);
    expect(session.snapshots[0]!.hash).toBe("abc");
    // Projection saw time-sorted events: span paired with its close (dwell ✓).
    expect(session.views).toHaveLength(1);
    expect(session.views[0]!.openNs).toBe(1_000_000_000n);
    expect(session.views[0]!.closeNs).toBe(5_000_000_000n);
  });

  it("collapses at-least-once duplicates when the same point lives in both providers", async () => {
    const shared = [uiEvent(1_000_000_000n, "click"), uiEvent(2_000_000_000n, "view_open")];
    const catalog = await buildSessionCatalog([
      provider("lp-files", shared),
      provider("influx", shared),
    ]);

    const session = catalog.sessions[0]!;
    expect(session.eventCount).toBe(2);
    expect(session.eventCountsByType).toEqual({ click: 1, view_open: 1 });
  });

  it("keeps distinct points that share a nanosecond but differ in element (full-tag identity)", async () => {
    // The identity key is the *full* wire tag set: two buttons clicked in the
    // same instant are two events, never a dedupe casualty. Exact replays
    // share every tag and still collapse.
    const clickOn = (element: string): RawEvent => ({
      ...uiEvent(1_000_000_000n, "click"),
      tags: { ...uiEvent(1_000_000_000n, "click").tags, element },
    });
    const first = clickOn("BtnAdd");
    const catalog = await buildSessionCatalog([
      provider("lp-files", [first, clickOn("BtnRemove"), first]),
      provider("influx", []),
    ]);
    expect(catalog.sessions[0]!.eventCount).toBe(2); // replay of `first` collapsed
    expect(catalog.sessions[0]!.eventCountsByType).toEqual({ click: 2 });
  });

  it("keeps distinct session ids as separate sessions", async () => {
    const other: RawEvent = {
      measurement: Measurements.UiEvent,
      timestampNs: 2_000_000_000n,
      tags: { session: "other-session-id", type: "click" },
      fields: {},
    };
    const catalog = await buildSessionCatalog([
      provider("lp-files", [uiEvent(1_000_000_000n, "click")]),
      provider("influx", [other]),
    ]);
    expect(catalog.sessions.map((s) => s.id).sort()).toEqual([SESSION, "other-session-id"].sort());
    expect(catalog.sessions.find((s) => s.id === SESSION)!.origin).toBe("lp-files");
    expect(catalog.sessions.find((s) => s.id === "other-session-id")!.origin).toBe("influx");
  });

  it("exposes the unioned event stream per session (detail read models must use it)", async () => {
    // Live regression (2026-10-21, container): the leftover pending-*.lp held
    // ONLY session start/end points; the full ui_event ledger lived in Influx.
    // The unioned projection was complete (eventCount 25, filmstrip ✓), but
    // the timeline route re-derived events from the lp-files run → 0 events →
    // empty tracks. sessionEvents must retain exactly what the projection saw.
    const files = provider("lp-files", [
      {
        measurement: Measurements.Session,
        timestampNs: 1_000_000_000n,
        tags: { session: SESSION, type: "start" },
        fields: { value: 1 },
      },
      {
        measurement: Measurements.Session,
        timestampNs: 9_000_000_000n,
        tags: { session: SESSION, type: "end" },
        fields: { value: 1 },
      },
    ]);
    const influx = provider("influx", [
      uiEvent(2_000_000_000n, "view_open"),
      uiEvent(3_000_000_000n, "click"),
      uiEvent(4_000_000_000n, "toggle"),
      uiEvent(8_000_000_000n, "view_close"),
    ]);
    const catalog = await buildSessionCatalog([files, influx]);

    const session = catalog.sessions.find((s) => s.id === SESSION)!;
    expect(session.eventCount).toBe(4); // the projection saw the merged stream

    const sessionEvents = catalog.sessionEvents.get(SESSION);
    // The union keeps every raw point for the session (2 `session` + 4
    // `ui_event`); the projection counts interactions only, the timeline
    // builder filters by measurement itself.
    expect(sessionEvents).toHaveLength(6);
    expect(sessionEvents![0]!.timestampNs).toBe(1_000_000_000n); // time-sorted
    expect(catalog.sessionEvents.has("other-missing")).toBe(false);

    // Parity on the detail path: the timeline built over the unioned stream
    // sees every interaction — never the origin run's 2 start/end points alone.
    const frame = buildTimelineFrame(session, catalog.sessionEvents.get(SESSION) ?? []);
    expect(frame.eventCount).toBe(session.eventCount);
    expect(frame.events).toHaveLength(4);
  });
});
