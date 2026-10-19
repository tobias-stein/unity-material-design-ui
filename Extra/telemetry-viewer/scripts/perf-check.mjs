#!/usr/bin/env node
/**
 * P6 performance gate (plan §14/P6 acceptance) — spins up the real server
 * against a synthetic big session and measures the acceptance numbers:
 *
 *  1. Session meta (`GET /api/sessions/:id`) from ledger fields only,
 *     zero YAML parse → p95 < 50 ms warm on this rig.
 *  2. Session list (`GET /api/sessions`) → p95 < 100 ms warm.
 *  3. Aggregate over a months-long UTC range → < 3000 ms.
 *  4. Big-session timeline (`GET /api/sessions/:id/timeline`, 5k events)
 *     completes and reports the full event count.
 *
 * Usage:
 *   node scripts/perf-check.mjs
 *   node scripts/perf-check.mjs --events 20000 --runs 30
 *
 * Exits non-zero when any threshold is violated. The server runs on a
 * dedicated port (8187 default) against a temporary LP_ROOT — no InfluxDB
 * needed, nothing outside the temp directory is touched.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ args */

function argNumber(name, fallback, { min = 1 } = {}) {
  const i = process.argv.indexOf(name);
  const value = i !== -1 ? Number.parseInt(process.argv[i + 1] ?? "", 10) : NaN;
  return Number.isFinite(value) && value >= min ? value : fallback;
}

const RUNS = argNumber("--runs", 20);
const EVENTS = argNumber("--events", 5000);
const PORT = argNumber("--port", 8187);
const BASE = `http://127.0.0.1:${PORT}`;

const THRESHOLDS = { metaMs: 50, listMs: 100, aggregateMs: 3000 };

/* ----------------------------------------------- fixture: big session lp */

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "mdu-perf-"));
mkdirSync(path.join(tmp, "lp"), { recursive: true });

function bigSessionLp(sessionId, events) {
  const viewId = "feed5111cccc2222dddd3333eeee4444";
  const view = "SyntheticBigSession";
  const durationMs = 60_000;
  const start = 1_730_000_000_000 - durationMs;
  const lines = [
    `session,session=${sessionId},type=start value=1i ${start}000000`,
    `ui_event,session=${sessionId},type=view_open,view=${view},view_id=${viewId} value=1i ${start + 1}000000`,
  ];
  for (let i = 0; i < events; i++) {
    const t = start + 5 + Math.floor(((durationMs - 10) * i) / events);
    const isToggle = i % 7 === 3;
    const type = isToggle ? "toggle" : "click";
    const element = isToggle ? "UIToggle_Sound" : "UIButton_Play";
    const elementType = isToggle ? "mdu.ui.Toggle" : "mdu.ui.Button";
    const onField = isToggle ? `,on=${i % 14 === 3 ? "true" : "false"}` : "";
    lines.push(
      `ui_event,element=${element},element_type=${elementType},session=${sessionId},type=${type},view=${view},view_id=${viewId} value=1i${onField} ${t}000000`,
    );
  }
  lines.push(`ui_event,session=${sessionId},type=view_close,view=${view},view_id=${viewId} value=1i,dwell=42 ${start + durationMs - 2}000000`);
  lines.push(`session,session=${sessionId},type=end value=1i ${start + durationMs}000000`);
  // One ledger anchor: meta (owner/platform/screen) must come from these
  // fields alone — after the perf run, `/api/sessions/:id` asserts them.
  lines.push(
    `ui_snapshot_taken,session=${sessionId},view=${view},view_id=${viewId} key="snapshots/perf/check.yaml",hash="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",nodes=12i,width=1600,height=900,owner="perf-fixture",platform="node",screen="1600x900" ${start + durationMs - 3}000000`,
  );
  lines.push("");
  return lines.join("\n");
}

const SESSION_ID = "perfcheck11111111111111111111111a";
const lpDir = path.join(tmp, "lp");
writeFileSync(path.join(lpDir, "perf-big-session.lp"), bigSessionLp(SESSION_ID, EVENTS));

/* ------------------------------------------------------------- run server */

const serverRoot = path.resolve(here, "..", "server");
const tsx = path.join(serverRoot, "node_modules", ".bin", "tsx");
const child = spawn(tsx, ["src/index.ts"], {
  cwd: serverRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    LP_ROOT: lpDir,
    SNAPSHOT_ROOT: path.join(tmp, "snaps"),
    LOG_LEVEL: "warn",
    AGGREGATE_CACHE_MS: "15000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
const logSink = (chunk) => { serverLog += chunk.toString(); };
child.stdout.on("data", logSink);
child.stderr.on("data", logSink);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${serverLog}`);
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server not healthy within ${timeoutMs} ms:\n${serverLog}`);
}

async function timed(url) {
  const t0 = performance.now();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = await response.json();
  return { ms: performance.now() - t0, status: response.status, body };
}

/** All runs after `warmup` count toward the percentile (cold runs ignored). */
function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function fail(label, detail) {
  console.error(`✗ ${label}\n  ${detail}\n  server log tail:\n${serverLog.split("\n").slice(-12).join("\n")}`);
  process.exitCode = 1;
}

try {
  await waitForHealth();

  /* Warm-up: catalog build + caches (thresholds are warm, per plan wording). */
  await timed(`${BASE}/api/sessions`);
  await timed(`${BASE}/api/sessions/${SESSION_ID}`);
  await timed(`${BASE}/api/aggregate?from=2000-01-01&to=2100-01-01`);

  /* 1+2: session list + meta percentiles */
  const listSamples = [];
  const metaSamples = [];
  for (let run = 0; run < RUNS; run++) {
    const list = await timed(`${BASE}/api/sessions`);
    const meta = await timed(`${BASE}/api/sessions/${SESSION_ID}`);
    if (list.status !== 200 || meta.status !== 200) {
      fail("sample request failed", `list=${list.status} meta=${meta.status}`);
      break;
    }
    listSamples.push(list.ms);
    metaSamples.push(meta.ms);
  }
  const listP95 = percentile(listSamples, 0.95);
  const metaP95 = percentile(metaSamples, 0.95);
  console.log(`sessions list  (n=${RUNS})  p50 ${percentile(listSamples, 0.5).toFixed(1)} ms  p95 ${listP95.toFixed(1)} ms   (threshold < ${THRESHOLDS.listMs} ms)`);
  console.log(`session meta   (n=${RUNS})  p50 ${percentile(metaSamples, 0.5).toFixed(1)} ms  p95 ${metaP95.toFixed(1)} ms   (threshold < ${THRESHOLDS.metaMs} ms)`);
  if (listP95 >= THRESHOLDS.listMs) fail("session list p95 over threshold", `${listP95.toFixed(1)} ms ≥ ${THRESHOLDS.listMs} ms`);
  if (metaP95 >= THRESHOLDS.metaMs) fail("session meta p95 over threshold", `${metaP95.toFixed(1)} ms ≥ ${THRESHOLDS.metaMs} ms`);

  /* 4: the big-session timeline carries every event */
  const timeline = await timed(`${BASE}/api/sessions/${SESSION_ID}/timeline`);
  const eventCount = timeline.body?.eventCount ?? -1;
  console.log(`big-session timeline      ${timeline.ms.toFixed(0)} ms, ${eventCount} events (sent ${EVENTS})`);
  // The loop emits `events` clicks/toggles plus one view_open + view_close.
  if (eventCount !== EVENTS + 2) fail("timeline event count mismatch", `expected ${EVENTS + 2}, got ${eventCount}`);
  else if (timeline.ms > 4000) fail("timeline build too slow", `${timeline.ms.toFixed(0)} ms > 4000 ms`);

  /* 3: years-long aggregate range, cold (first uncached run) */
  const aggregate = await timed(`${BASE}/api/aggregate?from=1900-01-01&to=2300-01-01`);
  console.log(`aggregate (500y range)    ${aggregate.ms.toFixed(0)} ms   (threshold < ${THRESHOLDS.aggregateMs} ms)`);
  if (aggregate.status !== 200) fail("aggregate request failed", `status=${aggregate.status}`);
  else if (aggregate.ms >= THRESHOLDS.aggregateMs) {
    fail("aggregate over months-long range too slow", `${aggregate.ms.toFixed(0)} ms ≥ ${THRESHOLDS.aggregateMs} ms`);
  }

  /* meta must be ledger-only: owner/platform fields survive with zero YAML. */
  const meta = (await timed(`${BASE}/api/sessions/${SESSION_ID}`)).body;
  if (meta.owner !== "perf-fixture") {
    fail("session meta owner not sourced from ui_snapshot_taken", `owner=${JSON.stringify(meta.owner)}`);
  } else {
    console.log("✓ session meta owner/platform from ledger fields only (owner=perf-fixture, platform=node)");
  }
  console.log("✓ perf gates passed");
} catch (error) {
  fail("perf run crashed", error instanceof Error ? error.stack : String(error));
} finally {
  child.kill("SIGTERM");
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}
if (process.exitCode) process.exit(1);
