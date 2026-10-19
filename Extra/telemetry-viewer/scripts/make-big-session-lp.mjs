#!/usr/bin/env node
/**
 * Dev helper for the P2 performance checklist (plan §14): writes a
 * deterministic synthetic `*.lp` session — default 5k `ui_event` points —
 * optionally interleaved with `ui_snapshot_taken` ledger points, so the
 * timeline canvas can be stressed for fps/latency without a Unity play-through.
 *
 * Reuses the server's `syntheticSessionLpData` generator (Node strips the types
 * natively); anchor points are added here so the click/toggle lanes correlate
 * (`latest ≤ t`) and the density bars light up on satisfied lanes.
 *
 * Usage:
 *   node scripts/make-big-session-lp.mjs                    # writes to $LP_ROOT
 *   node scripts/make-big-session-lp.mjs --out /tmp/lp      # explicit dir
 *   node scripts/make-big-session-lp.mjs --events 20000     # heavier
 *   node scripts/make-big-session-lp.mjs --anchors 0        # all events unresolved
 *
 * After writing, restart nothing — the lp-file source auto-scans; reload the
 * viewer and search for the printed session id.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { syntheticSessionLpData } from "../server/src/core/timeline.ts";

/* ------------------------------------------------------------------ args */

function argNumber(name, fallback, { min = 1 } = {}) {
  const i = process.argv.indexOf(name);
  const value = i !== -1 ? Number.parseInt(process.argv[i + 1] ?? "", 10) : NaN;
  return Number.isFinite(value) && value >= min ? value : fallback;
}
function argValue(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const events = argNumber("--events", 5000);
const anchorCount = argNumber("--anchors", 10, { min: 0 });
const durationMs = argNumber("--duration-ms", 60_000);
const outDir = argValue("--out", process.env.LP_ROOT ?? null);

if (!outDir) {
  console.error("No output directory: set LP_ROOT or pass --out <dir>.");
  process.exit(1);
}

/* --------------------------------------------------------------- generate */

const salt = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
const sessionId = `a7feed5k${salt}ea5e5ea7feed5k${salt}`.slice(0, 32); // stable-ish series id
const viewId = "feed5111cccc2222dddd3333eeee4444";
const view = "SyntheticBigSession";
const startEpochMs = Date.now() - durationMs;

const body = syntheticSessionLpData(sessionId, events, startEpochMs, durationMs, {
  viewId,
  view,
  togglesEvery: 7,
});

// Ledger points between the view_open and the first click — spread evenly so
// each filmstrip block has room. Keys/hashes are inert (artifact lookups fail
// honestly with SNAPSHOT_ARTIFACT_MISSING by design; no store files written).
const anchorLines = [];
const firstClickMs = startEpochMs + 5;
const span = Math.max(durationMs - 10, 1);
for (let i = 0; i < anchorCount; i++) {
  const t = firstClickMs + Math.floor((span / (anchorCount + 1)) * (i + 1)) - 4;
  anchorLines.push(
    [
      `ui_snapshot_taken,session=${sessionId},view=${view},view_id=${viewId}`,
      [
        `key="snapshots/synthetic/page-${String(i).padStart(3, "0")}.yaml"`,
        `hash="deadbeef${i}deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead"`,
        `nodes=${12 + (i % 8)}i,width=800,height=600`,
        `owner="synthetic",platform="devtool",screen="1600x900"`,
      ].join(","),
      `${(BigInt(t) * 1_000_000n).toString()}`,
    ].join(" "),
  );
}

const lp = body
  .split("\n")
  .slice(0, 2 + events) // start + view_open + events
  .join("\n")
  .concat(`\n${anchorLines.join("\n")}\n`)
  .concat(body.split("\n").slice(2 + events).join("\n"))
  .replace(/\n{2,}/g, "\n");

/* ------------------------------------------------------------------ write */

mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `synthetic-5k-${sessionId.slice(0, 12)}.lp`);
writeFileSync(file, lp);
console.log(`${file}`);
console.log(`session: ${sessionId}   events: ${events}   anchors: ${anchorCount}   duration: ~${Math.round(durationMs / 1000)}s`);
process.exit(0);
