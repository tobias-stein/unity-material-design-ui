/**
 * Runtime source-configuration routes (P6 acceptance): switch
 * influx ⇄ directory-only mode *without restart*, runtime root overrides
 * (env default respected), rescan invalidation and the pinned-providers
 * guard. Error shapes stay uniform `{ code, message }`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/api/app.js";
import type { ToolConfig } from "../src/config.js";

function configWith(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return {
    influx: {
      url: "http://influx.test:8086",
      org: "mdu",
      bucket: "ui",
      token: "test-token",
      timeoutMs: 250,
    },
    lpRoot: null,
    snapshotRoot: null,
    aggregateCacheMs: 0,
    webDist: null,
    port: 0,
    host: "127.0.0.1",
    ...overrides,
  };
}

/** Minimal valid session corpus (one start … click … end). */
function lpForSession(id: string, atNs: bigint): string {
  return [
    `session,session=${id},type=start value=1i ${atNs}`,
    `ui_event,session=${id},type=view_open,view=Main,view_id=11111111222233334444555566667777 value=1i ${atNs + 1_000_000n}`,
    `ui_event,element=Ok,element_type=mdu.ui.Button,session=${id},type=click,view=Main,view_id=11111111222233334444555566667777 value=1i ${atNs + 2_000_000n}`,
    `session,session=${id},type=end value=1i ${atNs + 3_000_000n}`,
    "",
  ].join("\n");
}

let workspace: string;

beforeEach(async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true); // quiet logs
  workspace = await mkdtemp(path.join(tmpdir(), "mdu-src-cfg-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

describe("GET /api/sources/config", () => {
  it("reports env defaults, effective roots and no token", async () => {
    const app = await buildApp({
      config: configWith({ lpRoot: "/lp/from/env", snapshotRoot: "/snaps/from/env" }),
    });
    const response = await app.inject({ method: "GET", url: "/api/sources/config" });
    expect(response.statusCode).toBe(200);
    const config = response.json();
    expect(config.influx).toEqual({
      enabled: true,
      url: "http://influx.test:8086",
      org: "mdu",
      bucket: "ui",
    });
    expect(config.lpRoot).toEqual({ env: "/lp/from/env", override: undefined, root: "/lp/from/env" });
    expect(config.snapshotRoot).toEqual({ env: "/snaps/from/env", override: undefined, root: "/snaps/from/env" });
    expect(config.universe).toEqual({ mode: "all", files: [], events: 0, sessions: [], malformedLines: 0 });
    // Token secrecy: the token may never be echoed by any endpoint.
    expect(response.body).not.toContain("test-token");
    await app.close();
  });
});

describe("PATCH /api/sources/config (no restart)", () => {
  it("switches influx⇄directory-only mode on the same app instance", async () => {
    await mkdir(path.join(workspace, "lp"), { recursive: true });
    await writeFile(
      path.join(workspace, "lp", "uni-session-a.lp"),
      lpForSession("sA111111111111111111111111111111", 1_700_000_000_000_000_000n),
    );
    const app = await buildApp({ config: configWith({ lpRoot: path.join(workspace, "lp") }) });

    let sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions.sessions.map((s: { id: string }) => s.id)).toEqual(["sA111111111111111111111111111111"]);

    // Turn influx off — directory-only mode, no restart, sessions unchanged.
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/sources/config",
      payload: { influxEnabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().applied).toEqual(["influxEnabled"]);
    expect(patch.json().config.influx.enabled).toBe(false);

    const degraded = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    // No influx provider at all: the run list shrinks, files keep serving.
    expect(degraded.sources.map((s: { id: string }) => s.id)).toEqual(["lp-files"]);
    expect(degraded.sessions.map((s: { id: string }) => s.id)).toEqual(["sA111111111111111111111111111111"]);

    // And back on — InfluxDB down stays an honest degraded source.
    await app.inject({ method: "PATCH", url: "/api/sources/config", payload: { influxEnabled: true } });
    const back = (await app.inject({ method: "GET", url: "/api/sources/config" })).json();
    expect(back.influx.enabled).toBe(true);
    await app.close();
  });

  it("applies a runtime lpRoot override and returns to the env default on null", async () => {
    await Promise.all([
      mkdir(path.join(workspace, "lp-env"), { recursive: true }),
      mkdir(path.join(workspace, "lp-override"), { recursive: true }),
    ]);
    await writeFile(
      path.join(workspace, "lp-env", "env-session.lp"),
      lpForSession("envsession11111111111111111111111", 1_700_000_000_000_000_000n),
    );
    await writeFile(
      path.join(workspace, "lp-override", "override-session.lp"),
      lpForSession("override11111111111111111111111111", 1_710_000_000_000_000_000n),
    );

    const app = await buildApp({ config: configWith({ lpRoot: path.join(workspace, "lp-env") }) });

    // Override: effective root swaps immediately (no TTL wait — caches subtle).
    let patch = await app.inject({
      method: "PATCH",
      url: "/api/sources/config",
      payload: { lpRoot: path.join(workspace, "lp-override") },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().config.lpRoot).toEqual({
      env: path.join(workspace, "lp-env"),
      override: path.join(workspace, "lp-override"),
      root: path.join(workspace, "lp-override"),
    });
    let sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions.sessions.map((s: { id: string }) => s.id)).toEqual(["override11111111111111111111111111"]);

    // null → the LP_ROOT env default applies again.
    patch = await app.inject({ method: "PATCH", url: "/api/sources/config", payload: { lpRoot: null } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().config.lpRoot.override).toBeUndefined();
    sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions.sessions.map((s: { id: string }) => s.id)).toEqual(["envsession11111111111111111111111"]);
    await app.close();
  });

  it("rejects unknown fields, non-dirs and stray types with INVALID_CONFIG", async () => {
    const badDir = path.join(workspace, "does-not-exist");
    const app = await buildApp({ config: configWith() });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ bogus: true }, "INVALID_CONFIG"],
      [{ lpRoot: badDir }, "INVALID_CONFIG"],
      [{ lpRoot: __filename }, "INVALID_CONFIG"], // exists, but not a directory
      [{ snapshotRoot: "relative-not-allowed", lpRoot: __dirname }, "INVALID_CONFIG"], // readdir decides below
      [{ lpRoot: "" }, "INVALID_CONFIG"],
      [{ influxEnabled: "yes" }, "INVALID_CONFIG"],
    ];
    for (const [payload, code] of cases) {
      const response = await app.inject({ method: "PATCH", url: "/api/sources/config", payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().code).toBe(code);
    }
    // Nothing must have leaked into state: config unchanged everywhere.
    const config = (await app.inject({ method: "GET", url: "/api/sources/config" })).json();
    expect(config.influx.enabled).toBe(true);
    expect(config.lpRoot.root).toBeNull();
    await app.close();
  });

  it("swaps the snapshot store so /api/sources reports the new root", async () => {
    await mkdir(path.join(workspace, "snaps"), { recursive: true });
    const app = await buildApp({ config: configWith() });
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/sources/config",
      payload: { snapshotRoot: path.join(workspace, "snaps") },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().config.snapshotRoot.root).toBe(path.join(workspace, "snaps"));
    const sources = (await app.inject({ method: "GET", url: "/api/sources" })).json();
    expect(sources.sources.snapshots).toMatchObject({
      state: "ok",
      root: path.join(workspace, "snaps"),
    });
    // And null returns to the honest unconfigured state (env was null).
    await app.inject({ method: "PATCH", url: "/api/sources/config", payload: { snapshotRoot: null } });
    const reset = (await app.inject({ method: "GET", url: "/api/sources" })).json();
    expect(reset.sources.snapshots).toMatchObject({ state: "unconfigured", root: null });
    await app.close();
  });

  it("refuses switching when providers were injected programmatically (409)", async () => {
    const injected = {
      id: "influx" as const,
      describe: async () => ({
        id: "influx" as const,
        available: true,
        state: "ok" as const,
        facts: { url: "stub" },
      }),
      fetchEvents: async () => ({ events: [], malformedCount: 0 }),
    };
    const app = await buildApp({
      config: configWith(),
      providers: () => [injected],
    });
    const sources = (await app.inject({ method: "GET", url: "/api/sources/config" })).json();
    expect(sources.pinned).toBe(true);
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/sources/config",
      payload: { influxEnabled: false },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().code).toBe("PROVIDERS_PINNED");
    // Snapshot-root changes stay possible (store is orthogonal to providers).
    await mkdir(path.join(workspace, "snaps2"), { recursive: true });
    const rootPatch = await app.inject({
      method: "PATCH",
      url: "/api/sources/config",
      payload: { snapshotRoot: path.join(workspace, "snaps2") },
    });
    expect(rootPatch.statusCode).toBe(200);
    await app.close();
  });
});

describe("POST /api/sources/rescan", () => {
  it("makes newly appeared .lp files visible despite a hot catalog cache", async () => {
    await mkdir(path.join(workspace, "lp"), { recursive: true });
    await writeFile(
      path.join(workspace, "lp", "first.lp"),
      lpForSession("rescanA1111111111111111111111111", 1_700_000_000_000_000_000n),
    );
    const app = await buildApp({
      config: configWith({ lpRoot: path.join(workspace, "lp") }),
      catalogCacheMs: 60_000, // long TTL: only an explicit rescan may pick up the new file
    });

    // Warm the catalog (first load = 1 session), then drop a second file in.
    let sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions.count).toBe(1);
    await writeFile(
      path.join(workspace, "lp", "second.lp"),
      lpForSession("rescanB1111111111111111111111111", 1_710_000_000_000_000_000n),
    );
    const cached = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(cached.count).toBe(1); // hot cache is honest, not stale-lying: TTL governs

    let rescan = await app.inject({ method: "POST", url: "/api/sources/rescan" });
    expect(rescan.statusCode).toBe(200);
    sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions.count).toBe(2);

    // With an imported universe, rescan is refused rather than lying.
    await app.inject({
      method: "PUT",
      url: "/api/sources/imported",
      payload: { files: [{ name: "imported.lp", content: lpForSession("imp11111111111111111111111111111", 1_720_000_000_000_000_000n) }] },
    });
    rescan = await app.inject({ method: "POST", url: "/api/sources/rescan" });
    expect(rescan.statusCode).toBe(409);
    expect(rescan.json().code).toBe("UNIVERSE_READ_ONLY");
    await app.close();
  });
});
