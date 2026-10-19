/**
 * P4 — version modes B + C (plan §7 acceptance):
 *
 * - a fixture with 2→4 structure versions of a view (one added element, one
 *   moved element) puts them in distinct fingerprint clusters, and mode A's
 *   hidden badge equals the true divergence;
 * - mode B renders one group per version with own template + own counts on
 *   the *event attribution* the interaction resolved through; non-divergent
 *   views live in exactly one group (totals sum check);
 * - mode C folds other versions into the picked ground truth by the
 *   longest-common-ancestry walk (moved element + leaf wildcard asserted
 *   against a table of expected merges); unmatched keys surface with their
 *   counts and never vanish (Σmerged + Σunmatched = all events invariant);
 * - exiting C returns to B with a stable group listing; picks and repeated
 *   queries are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectSessions } from "../src/core/sessionProjection.js";
import {
  buildAggregate,
  aggregateToCsv,
  AGGREGATE_CSV_HEADER,
  type SnapshotLoader,
} from "../src/core/heatmap.js";
import {
  matchCanonicalKey,
  AggregateGroupError,
  type KeyMeta,
} from "../src/core/versioning.js";
import { parseSnapshotText } from "../src/snapshots/parse.js";
import { LpFileListSource } from "../src/sources/lpFiles.js";
import { buildApp } from "../src/api/app.js";
import type { ToolConfig } from "../src/config.js";
import {
  ALIAS,
  KEY,
  SESSION_A,
  SESSION_B,
  SESSION_D1,
  SESSION_D2,
  SESSION_D3,
  SESSION_D4,
  buildWorld,
} from "./aggregateWorld.js";
import type { Session } from "../src/domain.js";

const world = buildWorld();
const sessions = projectSessions(world.events);
const byId = (id: string): Session => sessions.find((s) => s.id === id)!;

/** Sessions of the fixture world. */
function sessionSet(ids: readonly string[]): Session[] {
  return ids.map(byId);
}

function eventsFor(ids: readonly string[]): Map<string, typeof world.events> {
  const map = new Map<string, typeof world.events>();
  for (const id of ids) map.set(id, world.events.filter((e) => e.tags.session === id));
  return map;
}

/** Content-hash loader straight off the fixture world's snapshot bytes. */
const loader: SnapshotLoader = async (entry) => {
  const snapshot = entry.hash === null ? undefined : world.snapshots.find((s) => s.sha256 === entry.hash);
  return snapshot === undefined
    ? { parsed: null, errorCode: "SNAPSHOT_ARTIFACT_MISSING" }
    : { parsed: parseSnapshotText(snapshot.bytes.toString("utf8")), errorCode: null };
};

const ALL = [SESSION_A, SESSION_B, SESSION_D1, SESSION_D2, SESSION_D3, SESSION_D4] as const;
const DIALOG = [SESSION_D1, SESSION_D2, SESSION_D3, SESSION_D4] as const;

const META = (key: string, elementType: string | null = "mdu.ui.Button"): KeyMeta => ({
  key,
  elementType,
  leafLabel: key.split(" › ").at(-2) ?? key,
  confidence: "exact",
});
/** Meta list helper (plain `map(META)` would leak the index into elementType). */
const METAS = (keys: readonly string[], elementType: string | null = "mdu.ui.Button"): KeyMeta[] =>
  keys.map((key) => META(key, elementType));

/* ------------------------------------------------------- matcher (§7 C) */

describe("canonical key matcher: longest-common-ancestry walk", () => {
  it.each([
    ["Dialog › OK › mdu.ui.Button", ["Dialog › OK › mdu.ui.Button"], "Dialog › OK › mdu.ui.Button", 1, 0],
    [
      "Dialog › Container › OK › mdu.ui.Button",
      ["Dialog › OK › mdu.ui.Button"],
      "Dialog › OK › mdu.ui.Button",
      1,
      0,
    ],
    [
      "Dialog › OK › mdu.ui.Button",
      ["Dialog › Container › OK › mdu.ui.Button"],
      "Dialog › Container › OK › mdu.ui.Button",
      1,
      0,
    ],
    [
      "Dialog › ui:LayoutGroup[1] › OK › mdu.ui.Button",
      ["Dialog › ui:LayoutGroup[9] › OK › mdu.ui.Button"],
      "Dialog › ui:LayoutGroup[9] › OK › mdu.ui.Button",
      2,
      1,
    ],
  ])(
    "%s matched onto %j → depth %i, wildcards %i",
    (sourceKey, candidates, target, matched, wildcards) => {
      const result = matchCanonicalKey(sourceKey, "mdu.ui.Button", METAS(candidates));
      expect(result).not.toBeNull();
      expect(result!.targetKey).toBe(target);
      expect(result!.matched).toBe(matched);
      expect(result!.wildcards).toBe(wildcards);
    },
  );

  it("moved element: the leaf chain matches even when the ancestry differs", () => {
    const result = matchCanonicalKey(
      KEY.okMoved,
      "mdu.ui.Button",
      [META(KEY.ok)],
    );
    expect(result!.matched).toBe(1);
    expect(result!.sourceSegments).toBe(2);
    expect(result!.targetSegments).toBe(1);
  });

  it("the leaf index-only segment wildcards when elementType matches (v3 unnamed ↔ v4 named)", () => {
    const result = matchCanonicalKey(
      KEY.switch3,
      "mdu.ui.Switch",
      [{ ...META(KEY.sound), elementType: "mdu.ui.Switch" }],
    );
    expect(result).not.toBeNull();
    expect(result!.targetKey).toBe(KEY.sound);
    expect(result!.wildcards).toBe(1);
  });

  it("a different elementType is never a match — even over equal names", () => {
    expect(
      matchCanonicalKey("Dialog › OK › mdu.ui.Button", "mdu.ui.Button", [META("Dialog › OK › mdu.ui.Switch", "mdu.ui.Switch")]),
    ).toBeNull();
  });

  it("a shared elementType alone is not an identity (Cancel ≠ OK)", () => {
    expect(matchCanonicalKey("Dialog › Cancel › mdu.ui.Button", "mdu.ui.Button", [META(KEY.ok)])).toBeNull();
  });

  it("keys without a terminator match only terminator-less candidates", () => {
    expect(matchCanonicalKey("Dialog › unnamed", null, [META("Dialog › unnamed", null)])).not.toBeNull();
    expect(matchCanonicalKey("Dialog › unnamed", null, [META(KEY.ok, "mdu.ui.Button")])).toBeNull();
  });

  it("greedy + deterministic: deeper ancestry wins; equal depth → lexicographic smallest", () => {
    const deep = matchCanonicalKey("mdu.ui.Dialog › Body › OK › mdu.ui.Button", "mdu.ui.Button", METAS([
      KEY.ok,
      "mdu.ui.Dialog › Body › OK › mdu.ui.Button",
    ]));
    expect(deep!.targetKey).toBe("mdu.ui.Dialog › Body › OK › mdu.ui.Button");
    expect(deep!.matched).toBe(2);

    const tie = matchCanonicalKey("mdu.ui.Dialog › Bottom › OK › mdu.ui.Button", "mdu.ui.Button", METAS([
      "mdu.ui.Dialog › Top › OK › mdu.ui.Button",
      KEY.ok,
    ]));
    expect(tie!.matched).toBe(1);
    expect(tie!.targetKey).toBe(KEY.ok); // lexicographically smaller, deterministic
  });

  it("nothing in common → null (the honest unmatched outcome)", () => {
    expect(
      matchCanonicalKey("mdu.ui.Dialog › Footer › mdu.ui.Button", "mdu.ui.Button", METAS([
        "mdu.ui.Pane › Header › mdu.ui.Button",
      ])),
    ).toBeNull();
  });
});

/* ------------------------------------------------- version modes core (§7) */

describe("aggregate version modes (fixture world)", () => {
  it("structure versions land in distinct fingerprint clusters (moved + added elements)", async () => {
    const result = await buildAggregate({
      sessions: sessionSet(DIALOG),
      eventsBySession: eventsFor(DIALOG),
      loadSnapshot: loader,
      mode: "b",
    });
    const dialog = result.views.find((v) => v.viewKey === "mdu.ui.Dialog")!;
    expect(dialog.divergent).toBe(true);
    expect(dialog.versionCount).toBe(4);
    expect(new Set(dialog.versions!.map((g) => g.fingerprint)).size).toBe(4);
    // First occurrence order is chronological (v1 … v4).
    expect(dialog.versions!.map((g) => g.index)).toEqual([0, 1, 2, 3]);
  });

  it("mode A quantifies the true divergence: 1 divergent viewKey — 6 hidden keys — 16 hidden events", async () => {
    const result = await buildAggregate({
      sessions: sessionSet(ALL),
      eventsBySession: eventsFor(ALL),
      loadSnapshot: loader,
    });
    expect(result.totals).toMatchObject({
      interactionEvents: 28,
      resolvedEvents: 9,
      hiddenEvents: 16,
      unresolvedEvents: 3,
      divergentViewKeys: 1,
      hiddenKeys: 6,
    });
    const dialog = result.views.find((v) => v.viewKey === "mdu.ui.Dialog")!;
    expect(dialog.hiddenEventCount).toBe(16);
    expect(dialog.hiddenKeyCount).toBe(6);
  });

  it("mode B: one group per version with own template, own counts and ⊕/⊖ diffs", async () => {
    const result = await buildAggregate({
      sessions: sessionSet(DIALOG),
      eventsBySession: eventsFor(DIALOG),
      loadSnapshot: loader,
      mode: "b",
    });
    const dialog = result.views.find((v) => v.viewKey === "mdu.ui.Dialog")!;
    const groups = dialog.versions!;
    expect(groups).toHaveLength(4);

    const [v0, v1, v2, v3] = groups;
    // v1 — the untouched baseline: only OK under the root.
    expect(v0!.keys).toEqual([KEY.ok, KEY.dlgRoot]);
    expect(v0!.eventCount).toBe(3); // OK ×3 (SESSION_D1)
    expect(v0!.counts.find((row) => row.key === KEY.ok)!.count).toBe(3);
    expect(v0!.addedKeys).toEqual([]);
    expect(v0!.removedKeys).toEqual([]);
    expect(v0!.template!.viewId).toBe("vid-dlg-1");

    // v2 — one element added (Cancel).
    expect(v1!.keys).toEqual([KEY.cancel, KEY.ok, KEY.dlgRoot]);
    expect(v1!.counts.find((row) => row.key === KEY.cancel)!.count).toBe(2);
    expect(v1!.addedKeys).toEqual([KEY.cancel]);
    expect(v1!.removedKeys).toEqual([]);
    expect(v1!.template!.viewId).toBe("vid-dlg-2");

    // v3 — OK *moved* under Container + unnamed switch added.
    expect(v2!.keys).toEqual([KEY.container, KEY.okMoved, KEY.dlgRoot, KEY.switch3]);
    expect(v2!.counts.find((row) => row.key === KEY.okMoved)!.count).toBe(2);
    expect(v2!.counts.find((row) => row.key === KEY.switch3)!.count).toBe(1);
    expect(v2!.addedKeys).toEqual([KEY.container, KEY.okMoved, KEY.switch3]);
    expect(v2!.removedKeys).toEqual([KEY.ok]);
    expect(v2!.template!.viewId).toBe("vid-dlg-3");

    // v4 — the switch is renamed; OK is back at the root.
    expect(v3!.keys).toEqual([KEY.ok, KEY.sound, KEY.dlgRoot]);
    expect(v3!.counts.find((row) => row.key === KEY.sound)!.count).toBe(1);
    expect(v3!.addedKeys).toEqual([KEY.sound]);
    expect(v3!.removedKeys).toEqual([]);

    // No duplication: Σ group events = all Dialog interactions (16).
    const groupEventSum = groups.reduce((sum, g) => sum + g.eventCount, 0);
    expect(groupEventSum).toBe(16);
    // Σ per-group per-key counts agree with the event attribution.
    const rowCountSum = groups.reduce(
      (sum, g) => sum + g.counts.reduce((inner, row) => inner + row.count, 0),
      0,
    );
    expect(rowCountSum).toBe(16);

    // Hidden/intersection semantics do not leak into mode B.
    expect(result.totals.hiddenEvents).toBe(0);
    expect(result.totals.resolvedEvents).toBe(16);
  });

  it("mode B: non-divergent views stay in exactly one group (no duplication)", async () => {
    const result = await buildAggregate({
      sessions: sessionSet(ALL),
      eventsBySession: eventsFor(ALL),
      loadSnapshot: loader,
      mode: "b",
    });
    const menu = result.views.find((v) => v.viewKey === "mdu.ui.MainMenu")!;
    expect(menu.divergent).toBe(false);
    expect(menu.versions).toBeNull();
    expect(menu.counts.find((row) => row.key === KEY.play)!.count).toBe(5);
    expect(menu.template!.viewId).toBe("vid-main-1");

    expect(result.totals).toMatchObject({
      interactionEvents: 28,
      resolvedEvents: 25, // menu 9 + dialog 16 — every keyed event counted
      hiddenEvents: 0,
      unresolvedEvents: 3,
    });
  });

  it("mode C: picking a ground truth merges overlapping paths (expected-merges table)", async () => {
    const result = await buildAggregate({
      sessions: sessionSet(DIALOG),
      eventsBySession: eventsFor(DIALOG),
      loadSnapshot: loader,
      mode: "c",
      groundTruth: { viewKey: "mdu.ui.Dialog", versionIndex: 3 }, // v4: OK + Sound
    });
    const dialog = result.views.find((v) => v.viewKey === "mdu.ui.Dialog")!;
    expect(dialog.merge).not.toBeNull();
    const merge = dialog.merge!;
    expect(merge.groupId).toBe("mdu.ui.Dialog#3");
    expect(merge.groundTruthIndex).toBe(3);

    // Merged rows (the §7 C table for this world):
    const rows = new Map(merge.rows.map((row) => [row.key, row]));
    const okRow = rows.get(KEY.ok)!;
    expect(okRow.count).toBe(12); // own 3 + v1 OK 3 + v2 OK 4 + v3 *moved* OK 2
    expect(okRow.ownCount).toBe(3);
    const okFolds = new Map(okRow.folded.map((fold) => [fold.key, fold]));
    expect(okFolds.get(KEY.okMoved)).toMatchObject({ versionIndex: 2, count: 2, matched: 1, wildcards: 0 });
    // The plain OK key folds twice — once per owning version (v1, v2).
    expect(okRow.folded.filter((fold) => fold.key === KEY.ok).map((fold) => fold.versionIndex)).toEqual([1, 0]);
    expect(okRow.folded.filter((fold) => fold.key === KEY.ok).map((fold) => fold.count).sort((a, b) => b - a)).toEqual([4, 3]);
    expect(okRow.folded.filter((fold) => fold.key === KEY.ok).every((fold) => fold.matched === 1 && fold.wildcards === 0)).toBe(true);

    const soundRow = rows.get(KEY.sound)!;
    expect(soundRow.count).toBe(2); // own 1 + v3 unnamed switch folded (leaf wildcard)
    expect(soundRow.folded).toEqual([{ key: KEY.switch3, versionIndex: 2, count: 1, matched: 1, wildcards: 1 }]);

    // The event-less view-root key still renders (structure row, count 0).
    expect(rows.get(KEY.dlgRoot)!.count).toBe(0);

    // Unmatched: Cancel exists in v2 only — nothing to fold onto.
    expect(merge.unmatched).toEqual([
      { key: KEY.cancel, versionIndex: 1, count: 2, leafLabel: "Cancel", elementType: "mdu.ui.Button" },
    ]);

    // Invariant: merged + unmatched = all 16 Dialog events.
    const mergedSum = merge.rows.reduce((sum, row) => sum + row.count, 0);
    const unmatchedSum = merge.unmatched.reduce((sum, row) => sum + row.count, 0);
    expect(mergedSum + unmatchedSum).toBe(16);
    expect(merge.foldedEvents).toBe(10);
    expect(merge.unmatchedEvents).toBe(2);

    // Geometry comes from the *picked* version only.
    expect(dialog.template!.viewId).toBe("vid-dlg-4");
    expect(okRow.templateNodeId).toBe(ALIAS.okD4);
    expect(okRow.dimensions).toEqual({ width: 48, height: 40 });
  });

  it("mode C: greens of the earliest version — everything folds or is honest about being unmatched", async () => {
    const result = await buildAggregate({
      sessions: sessionSet(DIALOG),
      eventsBySession: eventsFor(DIALOG),
      loadSnapshot: loader,
      mode: "c",
      groundTruth: { viewKey: "mdu.ui.Dialog", versionIndex: 0 }, // v1: OK only
    });
    const merge = result.views[0]!.merge!;
    expect(merge.groundTruthIndex).toBe(0);

    const rows = new Map(merge.rows.map((row) => [row.key, row]));
    expect(rows.get(KEY.ok)!.count).toBe(12); // own 3 + 3 + 4 + 2 (moved fold)
    // No ground-truth switch key: switch events unfold honestly.
    const unmatchedSum = merge.unmatched.reduce((sum, row) => sum + row.count, 0);
    expect(unmatchedSum).toBe(4); // Cancel 2 + Sound(v4) 1 + unnamed switch(v3) 1
    const mergedSum = merge.rows.reduce((sum, row) => sum + row.count, 0);
    expect(mergedSum + unmatchedSum).toBe(16);
  });

  it("mode C errors: unknown ordinal / single-version viewKey", async () => {
    await expect(
      buildAggregate({
        sessions: sessionSet(DIALOG),
        eventsBySession: eventsFor(DIALOG),
        loadSnapshot: loader,
        mode: "c",
        groundTruth: { viewKey: "mdu.ui.Dialog", versionIndex: 9 },
      }),
    ).rejects.toMatchObject({ code: "AGGREGATE_GROUP_UNKNOWN" });

    await expect(
      buildAggregate({
        sessions: sessionSet([SESSION_A, SESSION_B]),
        eventsBySession: eventsFor([SESSION_A, SESSION_B]),
        loadSnapshot: loader,
        mode: "c",
        groundTruth: { viewKey: "mdu.ui.MainMenu", versionIndex: 0 },
      }),
    ).rejects.toMatchObject({ code: "AGGREGATE_GROUP_NOT_DIVERGENT" });
  });

  it("exiting C keeps the split listing stable (deterministic group ids)", async () => {
    const params = {
      sessions: sessionSet(DIALOG),
      eventsBySession: eventsFor(DIALOG),
      loadSnapshot: loader,
      mode: "b" as const,
    };
    const first = await buildAggregate({ ...params });
    const second = await buildAggregate({ ...params });
    const firstGroups = first.views[0]!.versions!.map((g) => g.groupId);
    const secondGroups = second.views[0]!.versions!.map((g) => g.groupId);
    expect(secondGroups).toEqual(firstGroups);
    expect(firstGroups[0]).toBe("mdu.ui.Dialog#0");

    // …and the same pick after an "exit" produces the identical merge payload.
    const mergedA = await buildAggregate({
      ...params,
      mode: "c",
      groundTruth: { viewKey: "mdu.ui.Dialog", versionIndex: 3 },
    });
    const mergedB = await buildAggregate({
      ...params,
      mode: "c",
      groundTruth: { viewKey: "mdu.ui.Dialog", versionIndex: 3 },
    });
    expect(mergedB.views[0]!.merge).toEqual(mergedA.views[0]!.merge);
  });
});

/* --------------------------------------------------------------- API layer */

function fixtureConfig(lpRoot: string, snapshotRoot: string): ToolConfig {
  return {
    influx: { url: "http://influx.test:8086", org: "mdu", bucket: "ui", token: "test-token", timeoutMs: 250 },
    lpRoot,
    snapshotRoot,
    webDist: null,
    port: 0,
    host: "127.0.0.1",
  };
}

describe("aggregate version modes over the REST surface", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true); // quiet logs
  });
  afterEach(() => vi.restoreAllMocks());

  async function withApp(): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; cleanup: () => Promise<void> }> {
    const lpRoot = await mkdtemp(path.join(tmpdir(), "mdu-modes-lp-"));
    const storeRoot = await mkdtemp(path.join(tmpdir(), "mdu-modes-store-"));
    await writeFile(path.join(lpRoot, "world.lp"), world.lp);
    for (const snapshot of world.snapshots) {
      await writeFile(path.join(storeRoot, snapshot.file), snapshot.bytes);
    }
    const app = await buildApp({
      config: fixtureConfig(lpRoot, storeRoot),
      providers: () => [new LpFileListSource({ root: lpRoot })],
      catalogCacheMs: 0,
    });
    return {
      app,
      cleanup: async () => {
        await rm(lpRoot, { recursive: true, force: true });
        await rm(storeRoot, { recursive: true, force: true });
        await app.close();
      },
    };
  }

  const dialogSelect = `sessions=${SESSION_D1},${SESSION_D2},${SESSION_D3},${SESSION_D4}`;

  it("mode b: per-version groups reach the client with group ids to pick from", async () => {
    const { app, cleanup } = await withApp();
    try {
      const response = await app.inject({ method: "GET", url: `/api/aggregate?${dialogSelect}&mode=b` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.selection.mode).toBe("b");
      expect(body.selection.group).toBeNull();

      const dialog = body.views.find((v: { viewKey: string }) => v.viewKey === "mdu.ui.Dialog");
      expect(dialog.versions).toHaveLength(4);
      expect(dialog.versions.map((g: { groupId: string }) => g.groupId)).toEqual([
        "mdu.ui.Dialog#0",
        "mdu.ui.Dialog#1",
        "mdu.ui.Dialog#2",
        "mdu.ui.Dialog#3",
      ]);
      // The template's parsed payload rides each group for replica rendering.
      expect(dialog.versions[0].template.viewId).toBe("vid-dlg-1");
      expect(dialog.versions[2].template.viewId).toBe("vid-dlg-3");
      expect(dialog.versions[2].counts.find((row: { key: string }) => row.key === KEY.okMoved).dimensions)
        .toEqual({ width: 48, height: 40 });
    } finally {
      await cleanup();
    }
  });

  it("mode c: the group pick flows through and validation errors stay 400 JSON", async () => {
    const { app, cleanup } = await withApp();
    try {
      const missing = await app.inject({ method: "GET", url: `/api/aggregate?${dialogSelect}&mode=c` });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("AGGREGATE_GROUP_MISSING");

      const mismatch = await app.inject({
        method: "GET",
        url: `/api/aggregate?${dialogSelect}&mode=b&group=${encodeURIComponent("mdu.ui.Dialog#1")}`,
      });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json().code).toBe("AGGREGATE_GROUP_MODE_MISMATCH");

      const invalidFormat = await app.inject({
        method: "GET",
        url: `/api/aggregate?${dialogSelect}&mode=c&group=${encodeURIComponent("mdu.ui.Dialog")}`,
      });
      expect(invalidFormat.statusCode).toBe(400);
      expect(invalidFormat.json().code).toBe("AGGREGATE_GROUP_INVALID");

      const notDivergent = await app.inject({
        method: "GET",
        url: `/api/aggregate?sessions=${SESSION_A},${SESSION_B}&mode=c&group=${encodeURIComponent("mdu.ui.MainMenu#0")}`,
      });
      expect(notDivergent.statusCode).toBe(400);
      expect(notDivergent.json().code).toBe("AGGREGATE_GROUP_NOT_DIVERGENT");

      const unknown = await app.inject({
        method: "GET",
        url: `/api/aggregate?${dialogSelect}&mode=c&group=${encodeURIComponent("mdu.ui.Dialog#9")}`,
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().code).toBe("AGGREGATE_GROUP_UNKNOWN");

      // The honest pick succeeds end-to-end, template from the picked version.
      const ok = await app.inject({
        method: "GET",
        url: `/api/aggregate?${dialogSelect}&mode=c&group=${encodeURIComponent("mdu.ui.Dialog#3")}`,
      });
      expect(ok.statusCode).toBe(200);
      const body = ok.json();
      expect(body.selection.mode).toBe("c");
      expect(body.selection.group).toBe("mdu.ui.Dialog#3");
      const dialog = body.views.find((v: { viewKey: string }) => v.viewKey === "mdu.ui.Dialog");
      expect(dialog.merge.rows.find((r: { key: string }) => r.key === KEY.ok).count).toBe(12);
      expect(dialog.template.viewId).toBe("vid-dlg-4");
    } finally {
      await cleanup();
    }
  });

  it("CSV export honors the modes: b rows carry version triples, c rows carry merges + unmatched", async () => {
    const { app, cleanup } = await withApp();
    try {
      const modeB = await app.inject({
        method: "GET",
        url: `/api/aggregate/export.csv?${dialogSelect}&mode=b`,
      });
      expect(modeB.statusCode).toBe(200);
      expect(modeB.headers["content-disposition"]).toContain("aggregate-mode-b.csv");
      const linesB = modeB.body.trimEnd().split(/\r\n/);
      expect(linesB[0]).toBe(AGGREGATE_CSV_HEADER);
      const cancelLine = linesB.find((line) => line.startsWith(KEY.cancel))!;
      expect(cancelLine).toBe(`${KEY.cancel},mdu.ui.Dialog#1,vid-dlg-2,Cancel,2,48x40`);
      const okLine = linesB.find((line) => line.startsWith(KEY.ok))!;
      expect(okLine.endsWith(`,3,48x40`)).toBe(true); // v1's own OK count (3)

      const modeA = await app.inject({
        method: "GET",
        url: `/api/aggregate/export.csv?${dialogSelect}&mode=a`,
      });
      expect(modeA.statusCode).toBe(200);
      expect(modeA.headers["content-disposition"]).toContain("aggregate-mode-a.csv");
      expect(modeA.body.trimEnd().split(/\r\n/)).toHaveLength(1); // header only: empty intersection

      const modeC = await app.inject({
        method: "GET",
        url: `/api/aggregate/export.csv?${dialogSelect}&mode=c&group=${encodeURIComponent("mdu.ui.Dialog#3")}`,
      });
      expect(modeC.statusCode).toBe(200);
      expect(modeC.headers["content-disposition"]).toContain("aggregate-mode-c.csv");
      const linesC = modeC.body.trimEnd().split(/\r\n/);
      const okLineC = linesC.find((line) => line.startsWith(KEY.ok))!;
      expect(okLineC).toBe(`${KEY.ok},mdu.ui.Dialog,vid-dlg-4,OK,12,48x40`);
      const soundLineC = linesC.find((line) => line.startsWith(KEY.sound))!;
      expect(soundLineC).toBe(`${KEY.sound},mdu.ui.Dialog,vid-dlg-4,Sound,2,48x28`);
      const unmatchedLine = linesC.find((line) => line.startsWith(KEY.cancel))!;
      expect(unmatchedLine).toBe(`${KEY.cancel},mdu.ui.Dialog#1,,Cancel,2,`);
    } finally {
      await cleanup();
    }
  });
});
