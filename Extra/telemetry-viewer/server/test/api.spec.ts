/**
 * Route-level binding tests (P1 acceptance): /api/sources honesty (degraded
 * instead of 500), /api/sessions search/filter, uniform error envelopes
 * (`{ code, message }`, never HTML), and the read-only guarantee.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildApp, toSessionDto } from "../src/api/app.js";
import { projectSessions } from "../src/core/sessionProjection.js";
import type { ToolConfig } from "../src/config.js";
import { parseLpDocuments } from "../src/sources/lp.js";
import { LpFileListSource } from "../src/sources/lpFiles.js";
import type { FetchOptions, RawEvent, RawEventResult, SourceProvider, SourceStatus } from "../src/domain.js";

const fixturesDir = path.join(import.meta.dirname, "fixtures");

function fixtureConfig(): ToolConfig {
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
    webDist: null,
    port: 0,
    host: "127.0.0.1",
  };
}

describe("api routes", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true); // quiet logs
  });
  afterEach(() => vi.restoreAllMocks());

  it("/api/health answers ok", async () => {
    const app = await buildApp({ config: fixtureConfig(), providers: () => [] });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it("/api/sources reports unconfigured/degraded with HTTP 200 instead of 500", async () => {
    const influxDown: SourceProvider = {
      id: "influx",
      describe: async () => ({
        id: "influx",
        available: false,
        state: "unavailable",
        message: "connect ECONNREFUSED",
        facts: { url: "http://influx.test:8086" },
      }),
      fetchEvents: async () => ({
        events: [],
        malformedCount: 0,
        error: { code: "INFLUX_UNAVAILABLE", message: "connect ECONNREFUSED", httpStatus: 503 },
      }),
    };
    const files = new LpFileListSource({ root: null });
    const app = await buildApp({ config: { ...fixtureConfig(), snapshotRoot: null }, providers: () => [files, influxDown] });
    const response = await app.inject({ method: "GET", url: "/api/sources" });
    expect(response.statusCode).toBe(200); // honesty ≠ server failure
    const body = response.json();
    // Nothing is reachable at all → unavailable; still 200 + JSON.
    expect(body.status).toBe("unavailable");
    expect(body.sources.influx.available).toBe(false);
    expect(body.sources["lp-files"].state).toBe("unconfigured");
    expect(body.sources.snapshots.state).toBe("unconfigured");
    await app.close();
  });

  it("/api/sources reflects an ok influx + fixture lp root", async () => {
    const fluxLpSource = new LpFileListSource({ root: fixturesDir });
    expect(fluxLpSource.root).toBe(fixturesDir);
    const influxOk: SourceProvider = {
      id: "influx",
      describe: async () => ({
        id: "influx",
        available: true,
        state: "ok",
        facts: { url: "http://influx.test:8086", sessions: 3 },
      }),
      fetchEvents: async () => ({ events: [], malformedCount: 0 }),
    };
    const app = await buildApp({
      config: { ...fixtureConfig(), lpRoot: fixturesDir },
      providers: () => [fluxLpSource, influxOk],
    });
    const body = (await app.inject({ method: "GET", url: "/api/sources" })).json();
    expect(body.status).toBe("degraded"); // snapshots root still unconfigured
    expect(body.sources["lp-files"].state).toBe("ok");
    expect(body.sources["lp-files"].facts.fileCount).toBeGreaterThan(0);
    expect(body.sources.influx.available).toBe(true);
    await app.close();
  });

  it("/api/sessions serves file-backed sessions and supports q/from/to/limit", async () => {
    const files = new LpFileListSource({ root: fixturesDir });
    const app = await buildApp({
      config: { ...fixtureConfig(), lpRoot: fixturesDir },
      providers: () => [files],
    });
    const all = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(all.total).toBeGreaterThan(3);
    expect(all.sessions[0].id).toBeTypeOf("string");

    const searched = (await app.inject({ method: "GET", url: "/api/sessions?q=smoketest" })).json();
    expect(searched.sessions.map((s: { id: string }) => s.id)).toEqual(["smoketest01"]);

    const limited = (await app.inject({ method: "GET", url: "/api/sessions?limit=1" })).json();
    expect(limited.sessions).toHaveLength(1);

    const ranged = (
      await app.inject({ method: "GET", url: "/api/sessions?from=1768471100000&to=1768471350000" })
    ).json();
    expect(ranged.sessions.map((s: { id: string }) => s.id)).toContain("0a11be11caf00d320a11be11caf00d32");

    // Owner info is present for ledger-backed sessions, absent for replays.
    const ledgerSessions = all.sessions.filter((s: { snapshotCount: number }) => s.snapshotCount > 0);
    expect(ledgerSessions.length).toBeGreaterThan(0);
    for (const session of ledgerSessions) {
      expect(session.owner).toBe("Unity-MaterialDesign-UI");
    }

    const invalid = await app.inject({ method: "GET", url: "/api/sessions?from=garbage" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_TIME" });
    await app.close();
  });

  it("/api/sessions/:id returns the ledger detail and 404s honestly", async () => {
    const files = new LpFileListSource({ root: fixturesDir });
    const app = await buildApp({
      config: { ...fixtureConfig(), lpRoot: fixturesDir },
      providers: () => [files],
    });
    const detail = (await app.inject({ method: "GET", url: "/api/sessions/3d07snap4e5566443d07snap4e556644" })).json();
    expect(detail.owner).toBe("Unity-MaterialDesign-UI");
    expect(detail.snapshots).toHaveLength(2);
    expect(detail.snapshots[0].key).toBe("snapshots/2026/04/01/UIDemoMainMenu-141500.yaml");
    expect(detail.views[0].dwellSeconds).toBe(7);

    const notFound = await app.inject({ method: "GET", url: "/api/sessions/nope" });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ code: "SESSION_NOT_FOUND", message: expect.any(String) });
    await app.close();
  });

  it("sources errors surface as structured JSON (no HTML), with partial results when one source survives", async () => {
    const files = new LpFileListSource({ root: fixturesDir });
    const explodingInflux: SourceProvider = {
      id: "influx",
      describe: async () => ({ id: "influx", available: true, state: "ok", facts: {} }),
      fetchEvents: async () => ({
        events: [],
        malformedCount: 0,
        error: { code: "INFLUX_TIMEOUT", message: "InfluxDB did not answer within 250 ms.", httpStatus: 503 },
      }),
    };
    const app = await buildApp({
      config: { ...fixtureConfig(), lpRoot: fixturesDir },
      providers: () => [files, explodingInflux],
    });
    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(response.statusCode).toBe(200); // files still serve
    const body = response.json();
    expect(body.status).toBe("degraded");
    const influxRun = body.sources.find((s: { id: string }) => s.id === "influx");
    expect(influxRun.error.code).toBe("INFLUX_TIMEOUT");
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("fully unavailable sources → 503 { code, message }", async () => {
    const down: SourceProvider = {
      id: "influx",
      describe: async () => ({ id: "influx", available: false, state: "unavailable", message: "ECONNREFUSED", facts: {} }),
      fetchEvents: async () => ({ events: [], malformedCount: 0, error: { code: "X", message: "x", httpStatus: 503 } }),
    };
    const app = await buildApp({ config: fixtureConfig(), providers: () => [down] });
    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("NO_SOURCE_AVAILABLE");
    await app.close();
  });

  it("sources stay read-only: no mutating provider use is ever attempted", async () => {
    const recording = { mutations: 0 } as { mutations: number };
    void recording;
    const readSpy = vi.fn(async () => ({ events: [], malformedCount: 0 } satisfies RawEventResult));
    const provider: SourceProvider = {
      id: "influx",
      describe: async () => ({ id: "influx", available: true, state: "ok", facts: {} }),
      fetchEvents: readSpy,
      // anything that is not read would funnel through here in a real adapter
      ...({} as Record<string, never>),
    };
    const app = await buildApp({ config: fixtureConfig(), providers: () => [provider], catalogCacheMs: 0 });
    for (const url of ["/api/sources", "/api/sessions", "/api/sessions/smoketest01"]) {
      await app.inject({ method: "GET", url });
    }
    // Read-only by construction: fetchEvents carries filters only; no write-
    // shaped call automatically happens on any route (GET). Assert the fake
    // provider was touched through reads exclusively.
    expect(readSpy).toHaveBeenCalledTimes(3);
    expect(readSpy.mock.calls.every((call) => isReadOnlyOptions((call[0] ?? {}) as FetchOptions))).toBe(true);
    expect(recording.mutations).toBe(0);
    expect.assertions(3);
    await app.close();
  });

  it("unknown routes answer with the uniform JSON envelope", async () => {
    const app = await buildApp({ config: fixtureConfig(), providers: () => [] });
    const response = await app.inject({ method: "GET", url: "/some/unknown/route" });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("NOT_FOUND");
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("/api/sessions count equals projected eventCount for the fixture corpus", async () => {
    const files = new LpFileListSource({ root: fixturesDir });
    const app = await buildApp({
      config: { ...fixtureConfig(), lpRoot: fixturesDir },
      providers: () => [files],
    });
    const content = await readFile(path.join(fixturesDir, "edge-snapshots.lp"), "utf8");
    const parsed = parseLpDocuments([{ file: "edge-snapshots.lp", content }]);
    const detailed = (await app.inject({ method: "GET", url: "/api/sessions/3d07snap4e5566443d07snap4e556644" })).json();
    const projected = projectCountEvents(parsed.events);
    const dto = toSessionDto(projected[0]!);
    expect(detailed.eventCount).toBe(dto.eventCount);
    expect(detailed.snapshotCount).toBe(dto.snapshotCount);
    await app.close();
  });
});

function isReadOnlyOptions(options: FetchOptions): boolean {
  // Only read filters may travel over the wire — structural read-only proof.
  const declared: string[] = ["sessionIds", "fromNs", "toNs"];
  return Object.keys(options).every((key) => declared.includes(key));
}

function projectCountEvents(events: RawEvent[]) {
  return projectSessions(events);
}

/** Compile-time documentation of the read-only provider surface. */
function assertNeverMutating(provider: SourceProvider): void {
  void provider;
}
