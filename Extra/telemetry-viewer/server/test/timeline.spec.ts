/**
 * Timeline assembly tests (P2 acceptance): every event appears in correct
 * order, dwell/closure markers pair up, unresolved events are never dropped,
 * the event count equals the session read model's count, and a synthetic
 * 5k-event session stays fast (chunked-correlation invariant).
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseLpDocuments } from "../src/sources/lp.js";
import { projectSessions } from "../src/core/sessionProjection.js";
import { buildTimelineFrame, nsToExactMs, syntheticSessionLpData } from "../src/core/timeline.js";
import type { RawEvent } from "../src/domain.js";

const fixturesDir = path.join(import.meta.dirname, "fixtures");

async function loadFixtureLp(name: string): Promise<RawEvent[]> {
  const content = await readFile(path.join(fixturesDir, name), "utf8");
  return parseLpDocuments([{ file: name, content }]).events;
}

describe("timeline frame", () => {
  it("orders every ui_event and counts them exactly like the session detail", async () => {
    const events = [
      ...(await loadFixtureLp("edge-events.lp")),
      ...(await loadFixtureLp("edge-unresolved.lp")),
      ...(await loadFixtureLp("edge-snapshots.lp")),
      ...(await loadFixtureLp("edge-escaping.lp")),
    ];
    const sessions = projectSessions(events);
    let totalEvents = 0;
    for (const session of sessions) {
      const ownEvents = events.filter((event) => event.tags.session === session.id);
      const frame = buildTimelineFrame(session, ownEvents);
      expect(frame.eventCount).toBe(session.eventCount);
      expect(frame.events).toHaveLength(frame.eventCount);
      for (let i = 0; i < frame.events.length; i++) {
        expect(frame.events[i]!.index).toBe(i);
      }
      // Strict ordering: ms floats are non-decreasing and ns strings unique-ordered.
      for (let i = 1; i < frame.events.length; i++) {
        const prev = frame.events[i - 1]!;
        const cur = frame.events[i]!;
        expect(cur.ms).toBeGreaterThanOrEqual(prev.ms);
        expect(cur.ns >= prev.ns).toBe(true);
      }
      totalEvents += frame.eventCount;
    }
    expect(totalEvents).toBe(events.filter((event) => event.measurement === "ui_event").length);
  });

  it("pairs dwell/closure markers and renders span data (edge-events)", async () => {
    const events = await loadFixtureLp("edge-events.lp");
    const session = projectSessions(events).find((s) => s.id === "0a11be11caf00d320a11be11caf00d32")!;
    const frame = buildTimelineFrame(session, events.filter((e) => e.tags.session === session.id));

    // view_close on the main menu carries dwell=123.456 (field), keeping the
    // closure marker together with the measured dwell.
    const menuClose = frame.events.find((event) => event.type === "view_close" && event.viewId !== null && event.dwellSeconds !== null);
    expect(menuClose).toBeDefined();
    expect(menuClose!.dwellSeconds).toBeCloseTo(123.456, 5);
    // Both views close before end-of-data → no still-open spans; the settings
    // span records its own dwell (0.5 s) exactly as the runtime reported it.
    const openSpans = frame.viewSpans.filter((span) => span.stillOpen);
    expect(openSpans).toHaveLength(0);
    expect(frame.viewSpans).toHaveLength(2);
    expect(frame.viewSpans.map((span) => span.dwellSeconds)).toEqual([123.456, 0.5]);

    // No snapshots exist in this fixture: all 4 interactions are unresolved
    // (sessions with zero anchors), lifecycle events live in the views lane.
    expect(frame.eventCount).toBe(8);
    expect(frame.lanes.find((lane) => lane.lane === "unresolved")!.count).toBe(4);
    expect(frame.unresolvedCount).toBe(4);
  });

  it("correlates interactions with the latest prior snapshot of the same view (§6.1 latest ≤ t)", async () => {
    const events = await loadFixtureLp("edge-snapshots.lp");
    const session = projectSessions(events).find((s) => s.id === "3d07snap4e5566443d07snap4e556644")!;
    const frame = buildTimelineFrame(session, events.filter((e) => e.tags.session === session.id));

    expect(frame.snapshots).toHaveLength(2);
    expect(frame.snapshots[0]!.ns).toBe("1775052900000000000");
    expect(frame.snapshots[1]!.hash).toBe("97c3a1d4f6a2b8c0e5d7f9a1b3c5e7d90000998877665544332211ffeeddccbb");

    // click @ 14:15:03 → snapshot 1 (14:15:00) is the last prior anchor.
    const click = frame.events.find((event) => event.type === "click")!;
    expect(click.snapshotIndex).toBe(0);
    expect(click.unresolved).toBe(false);

    // view_open @ 14:14:59 precedes every snapshot → rides in the views lane,
    // while an interaction before the first snapshot would be unresolved.
    const open = frame.events.find((event) => event.type === "view_open")!;
    expect(open.lane).toBe("views");
    expect(open.dwellSeconds).toBeNull(); // no dwell measurement on open events
    const close = frame.events.find((event) => event.type === "view_close")!;
    expect(close.dwellSeconds).toBe(7);
    expect(frame.viewSpans[0]!.dwellSeconds).toBe(7);
  });

  it("never drops unresolved anon/path events (edge-unresolved)", async () => {
    const events = await loadFixtureLp("edge-unresolved.lp");
    const session = projectSessions(events).find((s) => s.id === "2f99unres112233445566778899aa2f99")!;
    const frame = buildTimelineFrame(session, events.filter((e) => e.tags.session === session.id));

    // interactions target a view that captured one snapshot *later* — with
    // no anchor at-or-before their timestamps, they are unresolved but kept.
    const clicks = frame.events.filter((event) => event.type === "click");
    expect(clicks.length).toBe(2);
    for (const click of clicks) {
      expect(click.unresolved).toBe(true);
      expect(click.snapshotIndex).toBe(null);
      expect(click.element).toBeTruthy();
    }
    const anonClick = clicks.find((event) => event.element?.startsWith("anon:"))!;
    expect(anonClick.elementType).toBe("mdu.ui.Button");
  });

  it("keeps every event when a session has no snapshot anchors at all", async () => {
    const events = await loadFixtureLp("edge-escaping.lp");
    const session = projectSessions(events)[0]!;
    const frame = buildTimelineFrame(session, events.filter((e) => e.tags.session === session.id));
    expect(frame.eventCount).toBe(session.eventCount);
    expect(frame.events.every((event) => event.unresolved === (event.type !== "view_open" && event.type !== "view_close"))).toBe(true);
  });

  it("handles a degraded session: no ui_event at all → honest empty frame", async () => {
    const events = [
      {
        measurement: "session" as const,
        timestampNs: 1792319277604033000n,
        tags: { session: "ghost", type: "start" },
        fields: {},
      },
    ];
    const session = projectSessions(events)[0]!;
    const frame = buildTimelineFrame(session, []);
    expect(frame.eventCount).toBe(0);
    expect(frame.events).toEqual([]);
    expect(frame.startMs).toBeCloseTo(1792319277604.033, 2);
  });

  it("snapshots are exposed as ordered anchors incl. storage info", async () => {
    const events = await loadFixtureLp("edge-snapshots.lp");
    const session = projectSessions(events).find((s) => s.id === "3d07snap4e5566443d07snap4e556644")!;
    const frame = buildTimelineFrame(session, events.filter((e) => e.tags.session === session.id));
    expect(frame.snapshots.map((snapshot) => snapshot.key)).toEqual([
      "snapshots/2026/04/01/UIDemoMainMenu-141500.yaml",
      "snapshots/2026/04/01/UIDemoMainMenu-141505.yaml.gz",
    ]);
    expect(frame.snapshots[0]!.viewId).toBe("a8c1e0f42b7d4f8e9a2c3d405e6f7081");
  });

  it("synthetic 5k-event session: full set ordered, sub-ms cost, duration honored", async () => {
    // The P2 performance clause: buildTimeline must stay cheap enough that
    // the client can chunk-render 5k events interactively.
    const sessionId = "6b16e5ca55eedc1d6b16e5ca55eedc1d";
    const content = syntheticSessionLpData(sessionId, 5000, 1768471200000, 60_000);
    const events = parseLpDocuments([{ file: "synthetic.lp", content }]).events;
    expect(events).toHaveLength(5004); // start + open + 5000 events + close + end
    const session = projectSessions(events)[0]!;
    expect(session.eventCount).toBe(5002);

    const started = performance.now();
    const frame = buildTimelineFrame(session, events.filter((e) => e.tags.session === sessionId));
    const elapsed = performance.now() - started;

    expect(frame.eventCount).toBe(5002);
    expect(frame.events).toHaveLength(5002);
    expect(frame.events[0]!.type).toBe("view_open");
    expect(frame.events[frame.events.length - 1]!.type).toBe("view_close");
    // step = floor((60000-10)/5000) = 11 → close at 5 + 5000·11 + 1 ms.
    expect(frame.endMs - frame.startMs).toBeCloseTo(55_007, 0);
    expect(elapsed).toBeLessThan(250);
  });

  it("nsToExactMs keeps nanosecond fractions in ms floats", () => {
    expect(nsToExactMs("0")).toBe(0);
    expect(nsToExactMs("1775052901000000000")).toBe(1775052901000);
    expect(nsToExactMs("1792319289999504600")).toBeCloseTo(1792319289999.5046, 4);
  });
});
