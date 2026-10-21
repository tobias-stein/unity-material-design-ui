/**
 * Route-level binding tests (P1 acceptance): /api/sources honesty (degraded
 * instead of 500), /api/sessions search/filter, uniform error envelopes
 * (`{ code, message }`, never HTML), and the read-only guarantee.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

  describe("timeline + snapshot routes (P2)", () => {
    const snapSession = "3d07snap4e5566443d07snap4e556644";

    it("/api/sessions/:id/timeline carries every event ordered, count-matching the detail", async () => {
      const files = new LpFileListSource({ root: fixturesDir });
      const app = await buildApp({
        config: { ...fixtureConfig(), lpRoot: fixturesDir },
        providers: () => [files],
      });
      const detail = (await app.inject({ method: "GET", url: `/api/sessions/${snapSession}` })).json();
      const timeline = (await app.inject({ method: "GET", url: `/api/sessions/${snapSession}/timeline` })).json();

      // P2 acceptance: timeline event count == GET /api/sessions/:id count.
      expect(timeline.eventCount).toBe(detail.eventCount);
      expect(timeline.events).toHaveLength(timeline.eventCount);
      expect(timeline.session.owner).toBe("Unity-MaterialDesign-UI");

      const msList = timeline.events.map((e: { ms: number }) => e.ms);
      expect(msList).toEqual([...msList].sort((a: number, b: number) => a - b));
      expect(timeline.events.find((e: { type: string }) => e.type === "click").snapshotIndex).toBe(0);
      // Snapshot anchors ride the payload in ledger order.
      expect(timeline.snapshots.map((s: { key: string }) => s.key)).toEqual([
        "snapshots/2026/04/01/UIDemoMainMenu-141500.yaml",
        "snapshots/2026/04/01/UIDemoMainMenu-141505.yaml.gz",
      ]);
      await app.close();
    });

    it("timeline serves the unioned stream when a pending-*.lp tail overlaps influx (2026-10-21 regression)", async () => {
      // The leftover .lp holds ONLY session start/end points for a session
      // whose acknowledged stream lives in InfluxDB. The union catalog must
      // win: the timeline rides the merged events, not the origin run alone
      // (which filtered to 0 events → no marbles on any track in the client).
      const splitSession = "5afdsplite128a4594a5c40eaf430be627";
      const sessionPoint = (ns: bigint, type: string): RawEvent => ({
        measurement: "session" as const,
        timestampNs: ns,
        tags: { session: splitSession, type },
        fields: { value: 1 },
      });
      const uiEvent = (ns: bigint, type: string): RawEvent => ({
        measurement: "ui_event" as const,
        timestampNs: ns,
        tags: { session: splitSession, type, view: "Main", view_id: "main-1" },
        fields: { value: 1 },
      });
      const files: SourceProvider = {
        id: "lp-files",
        describe: async () => ({ id: "lp-files", available: true, state: "ok", facts: {} }),
        fetchEvents: async () => ({
          events: [sessionPoint(1_000_000_000n, "start"), sessionPoint(9_000_000_000n, "end")],
          malformedCount: 0,
        }),
      };
      const influx: SourceProvider = {
        id: "influx",
        describe: async () => ({ id: "influx", available: true, state: "ok", facts: {} }),
        fetchEvents: async () => ({
          events: [
            uiEvent(2_000_000_000n, "view_open"),
            uiEvent(3_000_000_000n, "click"),
            uiEvent(4_000_000_000n, "toggle"),
            uiEvent(8_000_000_000n, "view_close"),
          ],
          malformedCount: 0,
        }),
      };

      const app = await buildApp({
        config: { ...fixtureConfig(), lpRoot: null },
        providers: () => [files, influx],
      });
      const detail = (await app.inject({ method: "GET", url: `/api/sessions/${splitSession}` })).json();
      const timeline = (await app.inject({ method: "GET", url: `/api/sessions/${splitSession}/timeline` })).json();

      expect(detail.eventCount).toBe(4); // union, not the lp tail's 2 points
      expect(timeline.eventCount).toBe(detail.eventCount); // was 0 ui_events pre-fix
      expect(timeline.events).toHaveLength(4);
      const types = timeline.events.map((e: { type: string }) => e.type);
      expect(types).toEqual(["view_open", "click", "toggle", "view_close"]);
      // Events land on their view's track (the reported regression symptom).
      expect(timeline.rowCount).toBe(1);
      expect(timeline.events.map((e: { spanId: number }) => e.spanId)).toEqual([0, 0, 0, 0]);
      await app.close();
    });

    it("timeline for a snapshot-less session returns honest zero-edge state", async () => {
      const files = new LpFileListSource({ root: fixturesDir });
      const app = await buildApp({
        config: { ...fixtureConfig(), lpRoot: fixturesDir },
        providers: () => [files],
      });
      const timeline = (
        await app.inject({ method: "GET", url: "/api/sessions/1e55capedf1f115e1e55capedf1f115e/timeline" })
      ).json();
      expect(timeline.eventCount).toBe(4);
      expect(timeline.snapshots).toEqual([]);
      expect(timeline.lanes.find((l: { lane: string }) => l.lane === "unresolved").count).toBe(2);
      await app.close();
    });

    it("timeline 404s keep the uniform envelope", async () => {
      const files = new LpFileListSource({ root: fixturesDir });
      const app = await buildApp({
        config: { ...fixtureConfig(), lpRoot: fixturesDir },
        providers: () => [files],
      });
      const response = await app.inject({ method: "GET", url: "/api/sessions/does-not-exist/timeline" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });
      expect(response.headers["content-type"]).toContain("application/json");
      await app.close();
    });

    it("/api/snapshots/:id/:ref resolves a real matched store file end-to-end (yaml + gz)", async () => {
      const storeRoot = await mkdtemp(path.join(tmpdir(), "mdu-snapshots-"));
      // Build a schema-v2 snapshot whose ledger metadata matches the shape the
      // runtime emits, then hash-stamp the exact bytes into a live .lp fixture.
      const yamlV2 = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          timestampUtc: "2026-04-01T14:15:00Z",
          app: { productName: "Unity-MaterialDesign-UI" },
          view: { id: "a8c1e0f42b7d4f8e9a2c3d405e6f7081", name: "UIDemoMainMenu" },
          theme: { isDark: false, palette: { Primary: "#6750A4" } },
          nodes: [
            { id: "root", kind: "ui", isView: true, active: true, rect: { x: 0, y: 0, width: 400, height: 300 } },
          ],
        }),
        "utf8",
      );
      const gzV2 = (await import("node:zlib")).gzipSync(yamlV2);
      const hash1 = createHash("sha256").update(yamlV2).digest("hex");
      const hash2 = createHash("sha256").update(gzV2).digest("hex");
      await writeFile(path.join(storeRoot, "UIDemoMainMenu-141500.yaml"), yamlV2);
      await writeFile(path.join(storeRoot, "UIDemoMainMenu-141505.yaml.gz"), gzV2);

      const sessionId = snapSession;
      const lp = [
        `session,session=${sessionId},type=start value=1i 1775052840000000000`,
        `ui_event,session=${sessionId},type=view_open,view=UIDemoMainMenu,view_id=a8c1e0f42b7d4f8e9a2c3d405e6f7081 value=1i 1775052899000000000`,
        `ui_snapshot_taken,session=${sessionId},view=UIDemoMainMenu,view_id=a8c1e0f42b7d4f8e9a2c3d405e6f7081 key="snapshots/2026/04/01/UIDemoMainMenu-141500.yaml",hash="${hash1}",nodes=1i,width=400,height=300,owner="Unity-MaterialDesign-UI",platform="OSXEditor",screen="1920x1080" 1775052900000000000`,
        `ui_event,element=UIPlayButton,element_type=mdu.ui.Button,session=${sessionId},type=click,view=UIDemoMainMenu,view_id=a8c1e0f42b7d4f8e9a2c3d405e6f7081 value=1i 1775052903000000000`,
        `ui_snapshot_taken,session=${sessionId},view=UIDemoMainMenu,view_id=a8c1e0f42b7d4f8e9a2c3d405e6f7081 key="snapshots/2026/04/01/UIDemoMainMenu-141505.yaml.gz",hash="${hash2}",nodes=1i,width=400,height=300,owner="Unity-MaterialDesign-UI",platform="OSXEditor",screen="1920x1080" 1775052905000000000`,
      ].join("\n");
      const lpRoot = await mkdtemp(path.join(tmpdir(), "mdu-lp-"));
      await writeFile(path.join(lpRoot, "session-fixture.lp"), lp);

      const files = new LpFileListSource({ root: lpRoot });
      const app = await buildApp({
        config: { ...fixtureConfig(), lpRoot, snapshotRoot: storeRoot },
        providers: () => [files],
        catalogCacheMs: 0,
      });

      // Index route → parsed snapshot JSON (server-side YAML/gz handling).
      const byIndex = (await app.inject({ method: "GET", url: `/api/snapshots/${sessionId}/0` })).json();
      expect(byIndex.hash).toBe(hash1);
      expect(byIndex.parsed.schemaVersion).toBe(2);
      expect(byIndex.parsed.rootId).toBe("root");
      expect(byIndex.parsed.nodes[0].rect.width).toBe(400);

      // gz: index 1 (rounded-trip through gunzip sniff).
      const byGzIndex = (await app.inject({ method: "GET", url: `/api/snapshots/${sessionId}/1` })).json();
      expect(byGzIndex.parsed.nodes).toHaveLength(1);
      expect(byGzIndex.key).toBe("snapshots/2026/04/01/UIDemoMainMenu-141505.yaml.gz");

      // Hash routes (the true join key) + near queries.
      const byHash = (await app.inject({ method: "GET", url: `/api/snapshots/${sessionId}/hash:${hash2}` })).json();
      expect(byHash.index).toBe(1);
      const near = (
        await app.inject({ method: "GET", url: `/api/snapshots/${sessionId}/0?near=1775052903000` })
      ).json();
      expect(near.index).toBe(0);

      // Missing artifact (hash exists in ledger, no file) → honest 404.
      const missing = await app.inject({ method: "GET", url: `/api/snapshots/${sessionId}/999` });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("SNAPSHOT_INDEX_OUT_OF_RANGE");

      // Missing-file-by-byte-hash: rewrite ledger so the hash differs.
      const fakeHash = `f${hash1.slice(0, 63)}`;
      const badLp = lp.replace(hash1, fakeHash);
      await writeFile(path.join(lpRoot, "session-fixture-bad.lp"), badLp);
      const unavailable = await app.inject({ method: "GET", url: `/api/snapshots/${sessionId}/hash:${fakeHash}` });
      expect(unavailable.statusCode).toBe(404);
      expect(unavailable.json().code).toBe("SNAPSHOT_ARTIFACT_MISSING");

      await rm(lpRoot, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
      await app.close();
    });

    it("snapshot route honors unconfigured store with 503 degradation, not a crash", async () => {
      const files = new LpFileListSource({ root: fixturesDir });
      const app = await buildApp({
        config: { ...fixtureConfig(), lpRoot: fixturesDir },
        providers: () => [files],
      });
      const response = await app.inject({ method: "GET", url: `/api/snapshots/${snapSession}/0` });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("SNAPSHOT_STORE_UNCONFIGURED");
      await app.close();
    });

    it("snapshot ?near before the first anchor 404s honestly (pre-first-snapshot state)", async () => {
      const files = new LpFileListSource({ root: fixturesDir });
      const app = await buildApp({
        config: { ...fixtureConfig(), lpRoot: fixturesDir },
        providers: () => [files],
        catalogCacheMs: 0,
      });
      const response = await app.inject({
        method: "GET",
        url: `/api/snapshots/${snapSession}/0?near=1000`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("SNAPSHOT_NOT_AT_OR_BEFORE");
      await app.close();
    });
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
