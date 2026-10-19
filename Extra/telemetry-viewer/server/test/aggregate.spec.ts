/**
 * Aggregate mode A tests (P3 acceptance):
 * - counts by canonical key land exactly on hand-computed totals for the
 *   fixture world, combining the same logical element across sessions with
 *   different runtime `_id`s;
 * - the mode-A intersection filters divergent viewKeys and quantifies the
 *   hidden amount (badge figures);
 * - template selection is deterministic (same query ⇒ same rendering input);
 * - unresolved events land in honest buckets with reasons;
 * - CSV export has the exact header and RFC-4180 quoting.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectSessions } from "../src/core/sessionProjection.js";
import { buildAggregate, aggregateToCsv, AGGREGATE_CSV_HEADER, csvField, type SnapshotLoader } from "../src/core/heatmap.js";
import { resolveTheme } from "../../packages/snapshot-render/src/appliedTheme.js";
import { SnapshotService, SnapshotResolutionError } from "../src/snapshots/snapshotService.js";
import { LocalFsSnapshotStore } from "../src/storage/snapshotStore.js";
import {
  ALIAS,
  KEY,
  SESSION_A,
  SESSION_B,
  SESSION_D1,
  SESSION_D2,
  buildWorld,
} from "./aggregateWorld.js";
import type { ParsedSnapshot } from "../src/snapshots/parse.js";
import type { Session } from "../src/domain.js";

const world = buildWorld();
const sessions = projectSessions(world.events);
const byId = (id: string): Session => sessions.find((s) => s.id === id)!;

/** Real byte store + hash-first resolvable loader (Runtimeparity with P2). */
async function makeLoader(): Promise<{ loader: SnapshotLoader; dispose: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "mdu-aggregate-store-"));
  for (const snapshot of world.snapshots) {
    await writeFile(path.join(root, snapshot.file), snapshot.bytes);
  }
  const service = new SnapshotService(new LocalFsSnapshotStore(root));
  const loader: SnapshotLoader = async (entry) => {
    try {
      const resolved = await service.resolve({ key: entry.key, hash: entry.hash });
      return { parsed: resolved.parsed, errorCode: null };
    } catch (error) {
      if (error instanceof SnapshotResolutionError) return { parsed: null, errorCode: error.code };
      throw error;
    }
  };
  return { loader, dispose: () => rm(root, { recursive: true, force: true }) };
}

function allSessions(): Session[] {
  return sessions.filter((s) => [SESSION_A, SESSION_B, SESSION_D1, SESSION_D2].includes(s.id));
}

function eventsFor(ids: readonly string[]): Map<string, typeof world.events> {
  const map = new Map<string, typeof world.events>();
  for (const id of ids) map.set(id, world.events.filter((e) => e.tags.session === id));
  return map;
}

describe("aggregate mode A (heatmap core)", () => {
  it("counts identical logical elements across sessions with different runtime ids", async () => {
    const { loader, dispose } = await makeLoader();
    try {
      const result = await buildAggregate({
        sessions: allSessions(),
        eventsBySession: eventsFor([SESSION_A, SESSION_B, SESSION_D1, SESSION_D2]),
        loadSnapshot: loader,
      });

      // Hand-computed totals for the fixture world:
      // Play 2+3, Switch 1+2, Close 1, OK 3+4 → 16 resolved interactions;
      // Cancel ×2 outside the intersection → hidden; ghost click, pre-snapshot
      // toggle and post-fake-snapshot click → 3 unresolved.
      expect(result.totals).toMatchObject({
        sessions: 4,
        interactionEvents: 21,
        resolvedEvents: 16,
        hiddenEvents: 2,
        unresolvedEvents: 3,
      });

      const menu = result.views.find((view) => view.viewKey === "mdu.ui.MainMenu")!;
      expect(menu.counts.find((row) => row.key === KEY.play)).toMatchObject({ count: 5, confidence: "exact" });
      expect(menu.counts.find((row) => row.key === KEY.switch)).toMatchObject({
        count: 3,
        confidence: "approximate",
        elementType: "mdu.ui.Switch",
        // fixture: unnamed sibling → fallback segment carries its index
        leafLabel: "ui:mdu.ui.Switch[1]",
      });
      expect(menu.counts.find((row) => row.key === KEY.close)).toMatchObject({ count: 1, confidence: "exact" });
      expect(menu.divergent).toBe(false);
      expect(menu.versionCount).toBe(1);

      const dialog = result.views.find((view) => view.viewKey === "mdu.ui.Dialog")!;
      expect(dialog.counts.map((row) => row.key)).toEqual([KEY.ok]); // Cancel is hidden in mode A
      expect(dialog.counts[0]).toMatchObject({ count: 7 });
      expect(dialog.divergent).toBe(true);
      expect(dialog.versionCount).toBe(2);
      expect(dialog.hiddenKeyCount).toBe(1);
      expect(dialog.hiddenEventCount).toBe(2);

      // Badge figures: 1 divergent viewKey, 1 distinct hidden key.
      expect(result.totals.divergentViewKeys).toBe(1);
      expect(result.totals.hiddenKeys).toBe(1);

      // Dimensions ride the template node rect (120x48 for the Play button).
      expect(dialog.counts[0].dimensions).toEqual({ width: 48, height: 40 });
      expect(menu.counts.find((row) => row.key === KEY.play)!.dimensions).toEqual({ width: 120, height: 48 });
    } finally {
      await dispose();
    }
  });

  it("template snapshots are resolved, identically structured and cover the intersection", async () => {
    const { loader, dispose } = await makeLoader();
    try {
      const result = await buildAggregate({
        sessions: allSessions(),
        eventsBySession: eventsFor([SESSION_A, SESSION_B, SESSION_D1, SESSION_D2]),
        loadSnapshot: loader,
      });

      const menu = result.views.find((view) => view.viewKey === "mdu.ui.MainMenu")!;
      expect(menu.template).not.toBeNull();
      expect(menu.template!.viewId).toBe("vid-main-1"); // latest captured instance
      expect(menu.template!.parsed.theme?.isDark).toBe(true); // dark-seeded payload passes through

      const dialog = result.views.find((view) => view.viewKey === "mdu.ui.Dialog")!;
      expect(dialog.template!.viewId).toBe("vid-dlg-2"); // v2 covers the intersection (OK is there)
      // The Cancel button exists on the template but is NOT a counted key.
      const dialogKeys = new Set(dialog.template!.parsed.nodes.map((node) => node.name));
      expect(dialogKeys.has("Cancel")).toBe(true);

      // templateNodeId: the key row points into the template's node ids.
      expect(dialog.counts[0].templateNodeId).toBe(ALIAS.okD2);
      expect(menu.counts.find((row) => row.key === KEY.play)!.templateNodeId).toBe(ALIAS.playA);
    } finally {
      await dispose();
    }
  });

  it("same query twice ⇒ identical template choice and counts (stability)", async () => {
    const { loader, dispose } = await makeLoader();
    try {
      const params = {
        sessions: allSessions(),
        eventsBySession: eventsFor([SESSION_A, SESSION_B, SESSION_D1, SESSION_D2]),
        loadSnapshot: loader,
      };
      const first = await buildAggregate(params);
      const second = await buildAggregate(params);
      expect(second.views.map((view) => view.viewKey)).toEqual(first.views.map((view) => view.viewKey));
      for (let i = 0; i < first.views.length; i++) {
        expect(second.views[i]!.template?.hash).toBe(first.views[i]!.template?.hash);
        expect(second.views[i]!.counts).toEqual(first.views[i]!.counts);
      }
    } finally {
      await dispose();
    }
  });

  it("unresolved events are grouped by view + element_type with reasons, never dropped", async () => {
    const { loader, dispose } = await makeLoader();
    try {
      const result = await buildAggregate({
        sessions: allSessions(),
        eventsBySession: eventsFor([SESSION_A, SESSION_B, SESSION_D1, SESSION_D2]),
        loadSnapshot: loader,
      });
      expect(result.totals.unresolvedEvents).toBe(3);
      const rows = new Map(result.unresolved.map((row) => [`${row.view}/${row.elementType}`, row]));

      // element-missing: ghost click resolved onto a real snapshot but no node
      const missing = rows.get("UIDemoMainMenu(Clone)/mdu.ui.Button")!;
      expect(missing.count).toBe(2); // ghost + snapshot-unavailable both share the type bucket
      expect(missing.reasons["element-missing"]).toBe(1);
      expect(missing.reasons["snapshot-unavailable"]).toBe(1);

      // no-snapshot: beta's toggle before its first anchor
      const noSnap = [...result.unresolved].find((row) => row.reasons["no-snapshot"] === 1)!;
      expect(noSnap.elementType).toBe("mdu.ui.Switch");
    } finally {
      await dispose();
    }
  });

  it("a store without matching bytes degrades to snapshot-unavailable, not a crash", async () => {
    // No files written: every ledger artifact resolves to nothing.
    const service = new SnapshotService(new LocalFsSnapshotStore("/nonexistent-root-xyz"));
    const loader: SnapshotLoader = async () => ({ parsed: null, errorCode: "SNAPSHOT_ARTIFACT_MISSING" });
    void service;
    const result = await buildAggregate({
      sessions: allSessions(),
      eventsBySession: eventsFor([SESSION_A, SESSION_B, SESSION_D1, SESSION_D2]),
      loadSnapshot: loader,
    });
    expect(result.totals.resolvedEvents).toBe(0);
    expect(result.totals.unresolvedEvents).toBe(21);
    expect(result.views.every((view) => view.template === null)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("aggregate CSV export", () => {  it("header + rows are exactly canonicalKey,view,viewId,element,count,dimensions", async () => {
    const { loader, dispose } = await makeLoader();
    try {
      const result = await buildAggregate({
        sessions: allSessions(),
        eventsBySession: eventsFor([SESSION_A, SESSION_B, SESSION_D1, SESSION_D2]),
        loadSnapshot: loader,
      });
      const csv = aggregateToCsv(result);
      const lines = csv.trimEnd().split(/\r\n/);
      expect(lines[0]).toBe(AGGREGATE_CSV_HEADER);

      // Keys sorted by count within each view (Dialog first, then MainMenu).
      expect(lines.some((line) => line.includes(`${KEY.play},mdu.ui.MainMenu,vid-main-1,Play,5,120x48`))).toBe(true);
      expect(lines.some((line) => line.includes(`${KEY.switch},mdu.ui.MainMenu,vid-main-1,ui:mdu.ui.Switch[1],3,48x28`))).toBe(true);
      expect(lines.some((line) => line.includes(`${KEY.ok},mdu.ui.Dialog,vid-dlg-2,OK,7,48x40`))).toBe(true);

      // RFC-4180: the comma-bearing path/name survives as a quoted field.
      expect(lines.some((line) => line.startsWith(`"mdu.ui.MainMenu › Close, all › mdu.ui.Button"`))).toBe(true);
      const closeRow = lines.find((line) => line.startsWith(`"mdu.ui.MainMenu › Close, all › mdu.ui.Button"`))!;
      expect(closeRow).toContain(`,"Close, all",1,96x40`);

      // Hidden keys never appear in the CSV.
      expect(csv.includes(KEY.cancel)).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("csvField quotes commas, quotes and CR/LF per RFC-4180", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("theme: default-light regardless of captured theme", () => {
  // Text-assert of the §3.8 rule for the aggregate surface: a dark-seeded
  // captured palette must yield the hardcoded light tokens, never the
  // captured values (the view only ever calls buildReplicaStage with
  // "default-light").
  it("resolveTheme(default-light) ignores a dark captured palette", () => {
    const dark = { isDark: true, palette: { Primary: "#000000", Background: "#0A0A0A", Surface: "#111111", OnSurface: "#00FF00" } };
    const applied = resolveTheme("default-light", dark);
    expect(applied.isDark).toBe(false);
    expect(applied.palette.Primary).toBe("#6750A4"); // hardcoded M3 light token
    expect(applied.palette.Background).toBe("#FEF7FF");
    expect(applied.palette.Surface).toBe("#FEF7FF");
    expect(applied.palette.OnSurface).toBe("#1D1B20");
  });

  it("resolveTheme(default-light) also works when the snapshot carries no theme at all", () => {
    const applied = resolveTheme("default-light", null);
    expect(applied.isDark).toBe(false);
    expect(applied.palette.Secondary).toBe("#625B71");
  });
});
