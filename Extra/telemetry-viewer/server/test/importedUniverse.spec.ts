/**
 * Imported `.lp` files universe (P6 acceptance): the explicit multi-file
 * pick defines a temporary session universe — the picked files alone are
 * surfaced (directory scan + InfluxDB bypassed, never merged); clearing the
 * import restores the full sources without a process restart. Nothing is
 * persisted anywhere (in-memory parse only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/api/app.js";
import type { ToolConfig } from "../src/config.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

function config(): ToolConfig {
  return {
    influx: {
      url: "http://influx.test:8086",
      org: "mdu",
      bucket: "ui",
      token: "test-token",
      timeoutMs: 250,
    },
    lpRoot: FIXTURES,
    snapshotRoot: null,
    aggregateCacheMs: 0,
    webDist: null,
    port: 0,
    host: "127.0.0.1",
  };
}

function lpForSession(id: string, atNs: bigint): string {
  return [
    `session,session=${id},type=start value=1i ${atNs}`,
    `ui_event,session=${id},type=view_open,view=Imported,view_id=aaaaaaaa111122223333444455556666 value=1i ${atNs + 1_000_000n}`,
    `session,session=${id},type=end value=1i ${atNs + 3_000_000n}`,
    "",
  ].join("\n");
}

let workspace: string;

beforeEach(async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  workspace = await mkdtemp(path.join(tmpdir(), "mdu-universe-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

describe("PUT /api/sources/imported", () => {
  it("three explicit files alone define the temporary session universe", async () => {
    const app = await buildApp({ config: config() });

    // Baseline: the fixture directory serves its own sessions.
    const baseline = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(baseline.count).toBeGreaterThan(0);

    const ids = ["u1111111111111111111111111111a", "u1111111111111111111111111111b", "u1111111111111111111111111111c"];
    const importAt = 1_720_000_000_000_000_000n;
    const put = await app.inject({
      method: "PUT",
      url: "/api/sources/imported",
      payload: {
        files: ids.map((id, index) => ({
          name: `pick-${index + 1}.lp`,
          content: lpForSession(id, importAt + BigInt(index) * 1_000_000_000n),
        })),
      },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.universe).toBe("imported");
    expect(body.files).toHaveLength(3);
    expect(body.sessions).toEqual(ids);
    expect(body.config.universe.mode).toBe("imported");

    // The universe — only the picked files, fixture sessions gone.
    const universe = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(universe.sessions.map((s: { id: string }) => s.id).sort()).toEqual([...ids].sort());
    const sources = (await app.inject({ method: "GET", url: "/api/sources" })).json();
    expect(sources.sources["imported-files"].state).toBe("ok");
    expect(sources.sources["imported-files"].facts.files).toBe(3);
    expect(sources.sources.influx).toBeUndefined(); // bypassed, not merged
    expect(sources.sources["lp-files"]).toBeUndefined();

    // Timeline for an imported session works end to end.
    const timeline = await app.inject({
      method: "GET",
      url: `/api/sessions/${ids[0]}/timeline`,
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().session.origin).toBe("imported-files");
    await app.close();
  });

  it("rejects non-.lp files, pathy names, empty bodies and imports without content", async () => {
    const app = await buildApp({ config: config() });
    const good = { name: "ok.lp", content: lpForSession("u1111111111111111111111111111a", 1_720_000_000_000_000_000n) };
    const cases: Array<[unknown, string]> = [
      [{ files: [] }, "IMPORT_EMPTY"],
      [{ }, "IMPORT_EMPTY"],
      [{ files: [{ name: "notes.txt", content: "hi" }] }, "IMPORT_INVALID_FILE"],
      [{ files: [{ name: "../evil.lp", content: "x" }] }, "IMPORT_INVALID_FILE"],
      [{ files: [{ name: "no-content.lp" }] }, "IMPORT_INVALID_FILE"],
      [{ files: [good, { name: "empty.lp", content: "" }] }, "IMPORT_INVALID_FILE"], // name ok, content empty string
    ];
    for (const [payload, code] of cases) {
      const response = await app.inject({ method: "PUT", url: "/api/sources/imported", payload });
      expect(response.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(response.json().code).toBe(code);
    }
    // The failed imports never switched the universe.
    const after = (await app.inject({ method: "GET", url: "/api/sources/config" })).json();
    expect(after.universe.mode).toBe("all");
    await app.close();
  });

  it("enforces the file-count cap with IMPORT_TOO_MANY", async () => {
    const app = await buildApp({ config: config() });
    const files = Array.from({ length: 201 }, (_, index) => ({
      name: `file-${index}.lp`,
      content: `session,session=x${index},type=start value=1i 1720000000000000000\n`,
    }));
    const response = await app.inject({ method: "PUT", url: "/api/sources/imported", payload: { files } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("IMPORT_TOO_MANY");
    await app.close();
  });

  it("routes through the pinned error when providers are injected (409)", async () => {
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
    const app = await buildApp({ config: config(), providers: () => [injected] });
    const put = await app.inject({
      method: "PUT",
      url: "/api/sources/imported",
      payload: { files: [{ name: "x.lp", content: lpForSession("u1111111111111111111111111111a", 1_720_000_000_000_000_000n) }] },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().code).toBe("PROVIDERS_PINNED");
    await app.close();
  });
});

describe("DELETE /api/sources/imported", () => {
  it("restores the full sources without a restart", async () => {
    await mkdir(path.join(workspace, "lp"), { recursive: true });
    await writeFile(
      path.join(workspace, "lp", "disk-session.lp"),
      lpForSession("d1111111111111111111111111111aa", 1_715_000_000_000_000_000n),
    );
    const app = await buildApp({
      config: { ...config(), lpRoot: path.join(workspace, "lp") },
    });

    // Import shrinks the universe to picked files only …
    await app.inject({
      method: "PUT",
      url: "/api/sources/imported",
      payload: { files: [{ name: "picked.lp", content: lpForSession("u1111111111111111111111111111z", 1_720_000_000_000_000_000n) }] },
    });
    let sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions.count).toBe(1);

    // … and clearing hands the sources back (directory + influx pins return).
    const deleted = await app.inject({ method: "DELETE", url: "/api/sources/imported" });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().universe).toBe("all");
    expect(deleted.json().cleared).toBe(true);
    sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions.sessions.map((s: { id: string }) => s.id)).toEqual(["d1111111111111111111111111111aa"]);


    // Clearing an already-empty universe is idempotent, still 200.
    const again = await app.inject({ method: "DELETE", url: "/api/sources/imported" });
    expect(again.statusCode).toBe(200);
    expect(again.json().cleared).toBe(false);
    await app.close();
  });
});
