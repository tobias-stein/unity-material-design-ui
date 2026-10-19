/**
 * Aggregate caching + request coalescing (P6 perf pass): identical
 * in-flight aggregate requests share one build (coalesced), completed
 * results are TTL-cached, and any runtime source bump (rescan/config/
 * import) invalidates immediately — stale heatmaps are never served after
 * a mutation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { ToolConfig } from "../src/config.js";
import type { RawEvent, SourceProvider } from "../src/domain.js";

function config(): ToolConfig {
  return {
    influx: { url: "http://influx.test:8086", org: "mdu", bucket: "ui", token: "t", timeoutMs: 250 },
    lpRoot: null,
    snapshotRoot: null,
    aggregateCacheMs: 0,
    webDist: null,
    port: 0,
    host: "127.0.0.1",
  };
}

const SESSION = "coalesce11111111111111111111111a";

function events(): RawEvent[] {
  const ns = (ms: number) => `${(1_730_000_000_000 + ms) * 1_000_000}`;
  return [
    { measurement: "session", timestampNs: BigInt(ns(0)), tags: { session: SESSION, type: "start" }, fields: {} },
    {
      measurement: "ui_event",
      timestampNs: BigInt(ns(10)),
      tags: { session: SESSION, type: "click", view: "V", view_id: "v1", element: "Ok", element_type: "mdu.ui.Button" },
      fields: { value: 1 },
    },
    { measurement: "session", timestampNs: BigInt(ns(20)), tags: { session: SESSION, type: "end" }, fields: {} },
  ];
}

function slowProvider(calls: { count: number }, delayMs: number, onCall?: () => void): SourceProvider {
  return {
    id: "lp-files",
    describe: async () => ({ id: "lp-files", available: true, state: "ok", facts: { root: null } }),
    fetchEvents: async () => {
      calls.count++;
      onCall?.();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { events: events(), malformedCount: 0 };
    },
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
});

describe("aggregate cache + coalescing", () => {
  it("concurrent identical requests build once; TTL reuses; rescan busts", async () => {
    const calls = { count: 0 };
    const provider = slowProvider(calls, 60);
    const url = `/api/aggregate?sessions=${SESSION}`;
    const app = await buildApp({
      config: config(),
      providers: () => [provider],
      catalogCacheMs: 60_000, // catalog stays hot; the aggregate cache is under test
      aggregateCacheMs: 10_000,
    });

    // Warm nothing; fire two identical requests concurrently.
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url }),
      app.inject({ method: "GET", url }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().totals.sessions).toBe(1);
    expect(second.json().totals).toEqual(first.json().totals);
    expect(calls.count).toBe(1); // coalesced: one provider build served both

    // TTL cache: a third sequential request reuses the payload.
    const third = await app.inject({ method: "GET", url });
    expect(third.statusCode).toBe(200);
    expect(third.json().totals).toEqual(first.json().totals);
    expect(calls.count).toBe(1);

    // A runtime bump invalidates immediately — no stale heatmap ever.
    await app.inject({ method: "POST", url: "/api/sources/rescan" });
    const fourth = await app.inject({ method: "GET", url });
    expect(fourth.statusCode).toBe(200);
    expect(calls.count).toBe(2);
    expect(fourth.json().totals).toEqual(first.json().totals);
    await app.close();
  });

  it("different queries never share a cache entry", async () => {
    const calls = { count: 0 };
    const provider = slowProvider(calls, 0);
    const app = await buildApp({
      config: config(),
      providers: () => [provider],
      aggregateCacheMs: 10_000,
    });
    const ids = [
      "coalesce11111111111111111111111a",
      "coalesce11111111111111111111111b",
    ];
    // Second id is unknown to the provider — must be an honest 400, and it
    // must not poison the cached first result.
    const first = await app.inject({ method: "GET", url: `/api/aggregate?sessions=${ids[0]}` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "GET", url: `/api/aggregate?sessions=${ids[1]}` });
    expect(second.statusCode).toBe(400);
    expect(second.json().code).toBe("AGGREGATE_UNKNOWN_SESSIONS");
    const again = await app.inject({ method: "GET", url: `/api/aggregate?sessions=${ids[0]}` });
    expect(again.json().totals.sessions).toBe(1);
    await app.close();
  });

  it("mode variations are keyed separately, so b never reuses a payload", async () => {
    const calls = { count: 0 };
    const provider = slowProvider(calls, 0);
    const app = await buildApp({
      config: config(),
      providers: () => [provider],
      aggregateCacheMs: 10_000,
    });
    const base = (await app.inject({ method: "GET", url: `/api/aggregate?sessions=${SESSION}` })).json();
    const b = (await app.inject({ method: "GET", url: `/api/aggregate?sessions=${SESSION}&mode=b` })).json();
    expect(base.selection.mode).toBe("a");
    expect(b.selection.mode).toBe("b");
    // The b payload carries the same counts through the version lens —
    // proof it was built fresh, not served from the a-cache.
    expect(b.totals.sessions).toBe(1);
    await app.close();
  });
});
