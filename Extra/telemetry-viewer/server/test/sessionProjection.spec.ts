import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectSessions } from "../src/core/sessionProjection.js";
import { parseLpDocuments } from "../src/sources/lp.js";
import type { RawEvent } from "../src/domain.js";

export async function fixtureEvents(file: string): Promise<RawEvent[]> {
  const content = await readFile(path.join(import.meta.dirname, "fixtures", file), "utf8");
  return parseLpDocuments([{ file, content }]).events;
}

describe("sessionProjection", () => {
  it("projects the edge-snapshots fixture: ledger owner info, snapshot entries, dwell", async () => {
    const sessions = projectSessions(await fixtureEvents("edge-snapshots.lp"));
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.id).toBe("3d07snap4e5566443d07snap4e556644");
    expect(session.owner).toBe("Unity-MaterialDesign-UI");
    expect(session.platform).toBe("OSXEditor");
    expect(session.screen).toBe("1920x1080");
    expect(session.snapshotCount).toBe(2);
    expect(session.snapshots.map((s) => s.key)).toEqual([
      "snapshots/2026/04/01/UIDemoMainMenu-141500.yaml",
      "snapshots/2026/04/01/UIDemoMainMenu-141505.yaml.gz",
    ]);
    expect(session.snapshots[1]!.hash).toBe("97c3a1d4f6a2b8c0e5d7f9a1b3c5e7d90000998877665544332211ffeeddccbb");
    expect(session.eventCount).toBe(3); // view_open + click + view_close
    expect(session.views).toHaveLength(1);
    expect(session.views[0]).toMatchObject({
      view: "UIDemoMainMenu",
      viewId: "a8c1e0f42b7d4f8e9a2c3d405e6f7081",
      dwellSeconds: 7,
      closeNs: session.views[0]!.closeNs,
    });
    expect(session.startNs).not.toBeNull();
    // No `session,type=end` point in this fixture: end stays unset honestly.
    expect(session.endNs).toBeNull();
    expect(session.durationNs).toBeGreaterThan(0n);
  });

  it("projects the edge-events fixture with two views and event type counts", async () => {
    const sessions = projectSessions(await fixtureEvents("edge-events.lp"));
    const session = sessions.find((s) => s.id === "0a11be11caf00d320a11be11caf00d32")!;
    expect(session.eventCountsByType).toEqual({
      click: 1,
      close: 1,
      toggle: 2,
      view_close: 2,
      view_open: 2,
    });
    expect(session.views.map((v) => v.view)).toEqual(["UIDemoMainMenu", "UIDemoSettings"]);
    expect(session.views[0]!.dwellSeconds).toBeCloseTo(123.456, 3);
    expect(session.views[1]!.dwellSeconds).toBeCloseTo(0.5, 3);
    expect(session.openViewCount).toBe(0);
    expect(session.durationNs).toBe(131_000_000_000n); // start 00 → end 31s
  });

  it("projects an events-only session (no session start/end) without fabricating bounds", async () => {
    const sessions = projectSessions(await fixtureEvents("replay-smoketest01.lp"));
    const session = sessions[0]!;
    expect(session.startNs).toBeNull();
    expect(session.endNs).toBeNull();
    expect(session.firstEventNs).toBe(1_760_000_000_000_000_000n);
    expect(session.eventCount).toBe(1);
    expect(session.owner).toBeNull(); // no ledger points → no owner info
  });

  it("counts unresolved/anon events and keeps them (never dropped)", async () => {
    const sessions = projectSessions(await fixtureEvents("edge-unresolved.lp"));
    const session = sessions.find((s) => s.id === "2f99unres112233445566778899aa2f99")!;
    expect(session.eventCount).toBe(7);
    expect(session.eventCountsByType.click).toBe(2);
    expect(session.eventCountsByType.toggle).toBe(1);
    expect(session.views.some((v) => v.viewId === "d0e5f000000000000000000000000000")).toBe(true);
  });

  it("never loads snapshot YAML (P1 ledger-only session meta)", async () => {
    const loadSnapshot = vi.fn(async () => {
      throw new Error("projection must not parse snapshot YAML");
    });
    projectSessions(await fixtureEvents("edge-snapshots.lp"), { loadSnapshot });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("tolerates out-of-order input and keeps deterministic output", async () => {
    const events = await fixtureEvents("edge-snapshots.lp");
    const reversed = [...events].reverse();
    const sessions = projectSessions(reversed);
    expect(sessions.map((s) => s.id)).toEqual(["3d07snap4e5566443d07snap4e556644"]);
    const session = sessions[0]!;
    expect(session.firstEventNs).toBeLessThan(session.lastEventNs!);
    expect(session.snapshots.map((s) => s.timestampNs)).toEqual([...session.snapshots.map((s) => s.timestampNs)].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("returns [] for empty input", () => {
    expect(projectSessions([])).toEqual([]);
  });

  it("ignores events without a session tag", () => {
    const sessions = projectSessions([
      {
        measurement: "ui_event",
        timestampNs: 1n,
        tags: { session: "", type: "click" },
        fields: {},
      },
    ]);
    expect(sessions).toEqual([]);
  });
});
