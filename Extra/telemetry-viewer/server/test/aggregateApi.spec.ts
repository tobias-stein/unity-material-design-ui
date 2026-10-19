/**
 * Route-level tests for the aggregate surface (plan §8 + P3): selection
 * rules (sessions XOR range), uniform error envelopes for unknown
 * sessions/modes, the end-to-end heatmap payload (store-backed templates),
 * and the CSV export endpoint's content type + exact header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/api/app.js";
import type { ToolConfig } from "../src/config.js";
import { LpFileListSource } from "../src/sources/lpFiles.js";
import { AGGREGATE_CSV_HEADER } from "../src/core/heatmap.js";
import { SESSION_A, SESSION_B, buildWorld } from "./aggregateWorld.js";

const world = buildWorld();

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

describe("aggregate api routes", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true); // quiet logs
  });
  afterEach(() => vi.restoreAllMocks());

  async function withApp(): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; cleanup: () => Promise<void> }> {
    const lpRoot = await mkdtemp(path.join(tmpdir(), "mdu-aggregate-lp-"));
    const storeRoot = await mkdtemp(path.join(tmpdir(), "mdu-aggregate-store-"));
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

  it("combines both main-menu sessions despite different runtime element ids", async () => {
    const { app, cleanup } = await withApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/aggregate?sessions=${SESSION_A},${SESSION_B}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.mode).toBeUndefined(); // response body carries the selection
      expect(body.selection.mode).toBe("a");
      expect(body.selection.sessions).toHaveLength(2);

      // The same logical element joins across sessions by canonical key.
      const menu = body.views.find((view) => view.viewKey === "mdu.ui.MainMenu");
      expect(menu.divergent).toBe(false);
      const play = menu.counts.find((row: { key: string }) => row.key.includes("› Play ›"));
      expect(play.count).toBe(5); // 2 + 3 across the two sessions
      expect(play.templateNodeId).toBeTruthy();
      expect(play.dimensions).toEqual({ width: 120, height: 48 });

      expect(body.totals).toMatchObject({ interactionEvents: 12, resolvedEvents: 9, unresolvedEvents: 3 });
      // Both non-resolvable button clicks share the view+type bucket;
      // the pre-snapshot toggle rides its own row.
      expect(body.unresolved).toEqual([
        expect.objectContaining({
          view: "UIDemoMainMenu(Clone)",
          elementType: "mdu.ui.Button",
          count: 2,
          reasons: expect.objectContaining({ "element-missing": 1, "snapshot-unavailable": 1 }),
        }),
        expect.objectContaining({
          view: "UIDemoMainMenu(Clone)",
          elementType: "mdu.ui.Switch",
          count: 1,
          reasons: expect.objectContaining({ "no-snapshot": 1 }),
        }),
      ]);
    } finally {
      await cleanup();
    }
  });

  it("UTC range selection works and defaults the mode to a", async () => {
    const { app, cleanup } = await withApp();
    try {
      // All four fixture sessions start within the same hour.
      const body = (
        await app.inject({ method: "GET", url: "/api/aggregate?from=1970-01-01&to=2999-12-31" })
      ).json();
      expect(body.selection.mode).toBe("a");
      expect(body.selection.fromMs).toBeTypeOf("number");
      expect(body.totals.sessions).toBe(4);
      const dialog = body.views.find((view: { viewKey: string }) => view.viewKey === "mdu.ui.Dialog");
      expect(dialog.divergent).toBe(true);
      expect(dialog.hiddenKeyCount).toBe(1);
      expect(dialog.counts).toHaveLength(1); // mode A counts the intersection only
    } finally {
      await cleanup();
    }
  });

  it("error shapes: missing/ambiguous selection, unknown sessions, modes b/c, bad ranges", async () => {
    const { app, cleanup } = await withApp();
    try {
      const none = await app.inject({ method: "GET", url: "/api/aggregate" });
      expect(none.statusCode).toBe(400);
      expect(none.json().code).toBe("AGGREGATE_SELECTION_MISSING");

      const both = await app.inject({
        method: "GET",
        url: `/api/aggregate?sessions=${SESSION_A}&from=2026-01-01&to=2026-01-02`,
      });
      expect(both.json().code).toBe("AGGREGATE_SELECTION_INVALID");

      const unknown = await app.inject({ method: "GET", url: "/api/aggregate?sessions=nope,sess-alpha0000000000000000000000000" });
      expect(unknown.json().code).toBe("AGGREGATE_UNKNOWN_SESSIONS");
      expect(unknown.json().message).toContain("nope");

      const modeB = await app.inject({ method: "GET", url: `/api/aggregate?sessions=${SESSION_A}&mode=b` });
      expect(modeB.statusCode).toBe(400);
      expect(modeB.json()).toMatchObject({
        code: "AGGREGATE_MODE_NOT_AVAILABLE",
        message: expect.stringContaining("P4"),
      });

      const swapped = await app.inject({ method: "GET", url: "/api/aggregate?from=2026-02-01&to=2026-01-01" });
      expect(swapped.json().code).toBe("INVALID_RANGE");

      // CSV endpoint honors the same validation (no HTML, no stack traces).
      const csvMissing = await app.inject({ method: "GET", url: "/api/aggregate/export.csv" });
      expect(csvMissing.statusCode).toBe(400);
      expect(csvMissing.headers["content-type"]).toContain("application/json");
    } finally {
      await cleanup();
    }
  });

  it("CSV export streams text/csv with an RFC-4180 disposition and exact header", async () => {
    const { app, cleanup } = await withApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/aggregate/export.csv?sessions=${SESSION_A},${SESSION_B}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.headers["content-disposition"]).toContain("attachment");
      const text = response.body;
      expect(text.split(/\r\n/)[0]).toBe(AGGREGATE_CSV_HEADER);
      expect(text).toContain(`"Close, all"`);
    } finally {
      await cleanup();
    }
  });

  it("aggregate over a corpus without any snapshot store degrades with warnings, HTTP 200", async () => {
    const lpRoot = await mkdtemp(path.join(tmpdir(), "mdu-aggregate-lp-"));
    await writeFile(path.join(lpRoot, "world.lp"), world.lp);
    const app = await buildApp({
      config: fixtureConfig(lpRoot, null as unknown as string),
      providers: () => [new LpFileListSource({ root: lpRoot })],
      catalogCacheMs: 0,
    });
    try {
      const response = await app.inject({ method: "GET", url: `/api/aggregate?sessions=${SESSION_A},${SESSION_B}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.totals.resolvedEvents).toBe(0);
      expect(body.warnings.length).toBeGreaterThan(0);
      expect(body.views.every((view: { template: unknown }) => view.template === null)).toBe(true);
    } finally {
      await rm(lpRoot, { recursive: true, force: true });
      await app.close();
    }
  });
});
