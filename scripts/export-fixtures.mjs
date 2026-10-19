#!/usr/bin/env node
/**
 * Fixture exporter / verifier for the UI telemetry viewer (plan §10, §14 P0).
 *
 * Produces the committed corpus under
 *   Extra/telemetry-viewer/server/test/fixtures/
 * as line-protocol (.lp) files that byte-match what the Unity runtime emits:
 *
 *   - replay-<sessionId>.lp  canonical replay of the live demo data from
 *                            InfluxDB (measurements ui_event, session — and
 *                            ui_snapshot_taken once the ledger is live),
 *                            sorted, deduped, one file per session.
 *   - edge-events.lp         toggles (on=true/false), dwell, view lifecycle,
 *                            session start/end.
 *   - edge-escaping.lp       tag values containing spaces / commas / equals /
 *                            backslashes exactly as the runtime serializer
 *                            escapes them (\s, \, , \=, \\).
 *   - edge-snapshots.lp      ui_snapshot_taken ledger points (key/hash/nodes/
 *                            width/height/owner/platform/screen) interleaved
 *                            with the events they correlate to, incl. a .gz key.
 *   - edge-unresolved.lp     interactions whose element ids exist in no
 *                            snapshot (incl. "anon:path" fallback ids) — the
 *                            case the viewer must never drop.
 *
 * Reproducibility contract: same repository + unchanged InfluxDB contents
 * (edge fixtures are constants) ⇒ byte-identical fixtures. Enforced via:
 *
 *   node scripts/export-fixtures.mjs --check
 *
 * which regenerates everything in memory (never overwrites) and fails on any
 * drift. Every generated fixture is validated before it is written: each line
 * must round-trip through this module's strict line-protocol parser unchanged
 * (including the runtime's \\s/\\,/\\=/\\\\ tag escaping), and each
 * ui_snapshot_taken line must carry the exact P0 shape contract — bounded
 * tags session/view/view_id, no type tag, storage key under snapshots/<yyyy>/
 * <mm>/<dd>/, 64-hex hash, and the required fields — which is what the tool's
 * parser (P1) will be pinned to.
 *
 * Usage:
 *   node scripts/export-fixtures.mjs            (re)generate fixtures (needs InfluxDB)
 *   node scripts/export-fixtures.mjs --check    verify committed fixtures, no writes
 *   node scripts/export-fixtures.mjs --no-live  edge fixtures only, no InfluxDB needed
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const fixturesDir = join(
  repoRoot,
  "Extra",
  "telemetry-viewer",
  "server",
  "test",
  "fixtures",
);

const INFLUX_URL = process.env.INFLUX_URL ?? "http://localhost:8086";
const INFLUX_ORG = process.env.INFLUX_ORG ?? "mdu";
const INFLUX_BUCKET = process.env.INFLUX_BUCKET ?? "ui";
const INFLUX_TOKEN =
  process.env.INFLUX_TOKEN ?? "mdu-local-dev-token-0123456789abcdef";

// ─── line protocol ───────────────────────────────────────────────────────
// Tag escaping exactly as Assets/Runtime/Telemetry/Events/
// LineProtocolSerializer.cs does it: \\s \\, \\= \\\\. Order matters: a
// literal backslash must be doubled first, every escape keeps 2 characters.
export function escapeTag(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/,/g, "\\,")
    .replace(/=/g, "\\=");
}

export function fieldInt(n) {
  return `${n}i`;
}

export function fieldBool(b) {
  return b ? "true" : "false";
}

/** Canonical double formatting: shortest exact form, never "3600.0" padding. */
export function fieldDouble(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`non-finite double field value: ${raw}`);
  }
  return String(n);
}

/** String field: always double-quoted; \\ and \" escaped. */
export function fieldString(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

/** Builds one line. Tag keys sorted for determinism; empty values omitted. */
export function line(measurement, tags, fields, tsNs) {
  const tagEntries = Object.entries(tags)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${escapeTag(v)}`);
  const fieldEntries = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  const tagText = tagEntries.length ? "," + tagEntries.join(",") : "";
  return `${measurement}${tagText} ${fieldEntries.join(",")} ${tsNs}`;
}

/** RFC3339 (with optional nanoseconds) → exact nanoseconds since epoch. */
export function rfc3339ToNs(text) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );
  if (!m) {
    throw new Error(`unsupported RFC3339 timestamp: ${text}`);
  }
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (zone !== "Z" && zone !== "z") {
    // e.g. "+02:00": local time is 2h ahead of UTC → subtract the offset.
    const offMinutes =
      +zone.slice(1, 3) * 60 + +zone.slice(4, 6);
    ms -= (zone[0] === "-" ? -1 : 1) * offMinutes * 60000;
  }
  const subNano = frac ? BigInt((frac + "000000000").slice(0, 9)) : 0n;
  return BigInt(ms) * 1_000_000n + subNano;
}

/** Fixed UTC instant → nanoseconds (for the synthesized edge fixtures). */
function ns(isoUtc) {
  return rfc3339ToNs(isoUtc.endsWith("Z") ? isoUtc : `${isoUtc}Z`);
}

// ─── annotated CSV (InfluxDB /api/v2/query) ──────────────────────────────

/** Minimal CSV line reader honoring "" quotes (InfluxDB quotes only when needed). */
function parseCsvRow(row) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (quoted) {
      if (c === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

const KNOWN_TAG_COLUMNS = [
  "session",
  "type",
  "view",
  "view_id",
  "element",
  "element_type",
];

/**
 * InfluxDB annotated CSV → points { measurement, time, tags, fields }.
 * Influx emits one row per field of a point; rows are folded back together
 * (same measurement + timestamp + tag set). Blank lines separate result
 * tables and reset the current header block.
 */
export function recordsFromAnnotatedCsv(csv) {
  let header = null;
  const pointsByKey = new Map();
  for (const row of csv.split(/\r?\n/)) {
    if (row === "") {
      header = null;
      continue;
    }
    if (row.startsWith("#")) {
      continue; // #group / #datatype / #default rows carry no values
    }
    const cells = parseCsvRow(row);
    if (header === null) {
      header = cells;
      continue;
    }
    const rowMap = {};
    header.forEach((name, i) => (rowMap[name] = cells[i] ?? ""));
    if (!rowMap._measurement || !rowMap._time || !rowMap._field) {
      continue;
    }
    const tags = {};
    for (const t of KNOWN_TAG_COLUMNS) {
      if (rowMap[t] !== undefined && rowMap[t] !== "") {
        tags[t] = rowMap[t];
      }
    }
    const tagKey = Object.keys(tags)
      .sort()
      .map((k) => `${k}\u0000${tags[k]}`)
      .join("\u0001");
    const key = `${rowMap._measurement}\u0001${rowMap._time}\u0001${tagKey}`;
    let point = pointsByKey.get(key);
    if (!point) {
      point = {
        measurement: rowMap._measurement,
        time: rowMap._time,
        tags,
        fields: {},
      };
      pointsByKey.set(key, point);
    }
    point.fields[rowMap._field] = rowMap._value;
  }
  return [...pointsByKey.values()];
}

const INT_FIELDS = new Set(["value", "nodes"]);
const BOOL_FIELDS = new Set(["on"]);
const DOUBLE_FIELDS = new Set(["dwell", "width", "height"]);

function pointToLine(point) {
  const fields = {};
  for (const [name, raw] of Object.entries(point.fields)) {
    if (INT_FIELDS.has(name)) {
      fields[name] = fieldInt(Number(raw));
    } else if (BOOL_FIELDS.has(name)) {
      fields[name] = fieldBool(raw === "true");
    } else if (DOUBLE_FIELDS.has(name)) {
      fields[name] = fieldDouble(raw);
    } else {
      fields[name] = fieldString(raw); // key, hash, owner, platform, screen
    }
  }
  return line(
    point.measurement,
    point.tags,
    fields,
    rfc3339ToNs(point.time).toString(),
  );
}

// ─── live InfluxDB replay ────────────────────────────────────────────────

const FLUX_QUERY = `from(bucket: "${INFLUX_BUCKET}")
  |> range(start: 0)
  |> filter(fn: (r) =>
    r._measurement == "ui_event" or
    r._measurement == "session" or
    r._measurement == "ui_snapshot_taken")
  |> keep(columns: [
    "_measurement", "_field", "_time", "_value",
    "session", "type", "view", "view_id", "element", "element_type"])`;

async function influxReachable() {
  try {
    const resp = await fetch(`${INFLUX_URL}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function queryLivePoints() {
  const resp = await fetch(
    `${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${INFLUX_TOKEN}`,
        "Content-Type": "application/vnd.flux",
        Accept: "application/csv",
      },
      body: FLUX_QUERY,
    },
  );
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`InfluxDB query failed: ${resp.status}: ${detail}`);
  }
  return recordsFromAnnotatedCsv(await resp.text());
}

/** Live points → canonical, sorted, deduped fixture files (one per session). */
export function replayFixtures(points) {
  const linesPerSession = new Map();
  for (const point of points) {
    if (!point.tags.session) {
      throw new Error(`point without session tag: ${JSON.stringify(point)}`);
    }
    if (!linesPerSession.has(point.tags.session)) {
      linesPerSession.set(point.tags.session, []);
    }
    linesPerSession.get(point.tags.session).push(pointToLine(point));
  }
  const files = new Map();
  for (const [session, linesRaw] of linesPerSession) {
    // Timestamps sort within the line text (they are the line's tail);
    // sorting the lines gives a deterministic, reproducible file. Identical
    // duplicates (at-least-once redelivery) collapse to one line.
    const unique = [...new Set(linesRaw)].sort();
    files.set(`replay-${session}.lp`, `${unique.join("\n")}\n`);
  }
  return files;
}

// ─── synthesized edge-case fixtures ──────────────────────────────────────

// Session ids are fixed 32-char hex constants — deterministic content first.
const SESS_EVENTS = "0a11be11caf00d320a11be11caf00d32";
const SESS_ESCAPE = "1e55capedf1f115e1e55capedf1f115e";
const SESS_UNRES = "2f99unres112233445566778899aa2f99";
const SESS_SNAPS = "3d07snap4e5566443d07snap4e556644";

/** Deterministic content cartridge for the "real" replayed event data. */
const MENU_VIEW_ID = "a8c1e0f42b7d4f8e9a2c3d405e6f7081";
const SETT_VIEW_ID = "b1d2a3c4e5f60718283a4b5c6d7e8f90";
const LIVE_HASH_1 = "b64f7f24a6832f5bd3cebd6d15f1c9d6e00112233445566778899aabbccddeef";
const LIVE_HASH_2 = "97c3a1d4f6a2b8c0e5d7f9a1b3c5e7d90000998877665544332211ffeeddccbb";

function edgeEvents() {
  const view = {
    session: SESS_EVENTS,
    view: "UIDemoMainMenu",
    view_id: MENU_VIEW_ID,
  };
  const btn = { element: "UIButton_Play", element_type: "mdu.ui.Button" };
  const toggle = { element: "UIToggle_Sound", element_type: "mdu.ui.Toggle" };
  const lines = [
    line("session", { session: SESS_EVENTS, type: "start" }, { value: fieldInt(1) }, ns("2026-01-15T10:00:00Z")),
    line("ui_event", { ...view, type: "view_open" }, { value: fieldInt(1) }, ns("2026-01-15T10:00:01Z")),
    line("ui_event", { ...view, type: "click", ...btn }, { value: fieldInt(1) }, ns("2026-01-15T10:00:05Z")),
    line("ui_event", { ...view, type: "toggle", ...toggle }, { value: fieldInt(1), on: fieldBool(true) }, ns("2026-01-15T10:00:08Z")),
    line("ui_event", { ...view, type: "toggle", ...toggle }, { value: fieldInt(1), on: fieldBool(false) }, ns("2026-01-15T10:00:11Z")),
    line("ui_event", { ...view, type: "close", ...toggle }, { value: fieldInt(1) }, ns("2026-01-15T10:00:20Z")),
    line("ui_event", { ...view, type: "view_close" }, { value: fieldInt(1), dwell: fieldDouble(123.456) }, ns("2026-01-15T10:02:04Z")),
    line("ui_event", { session: SESS_EVENTS, type: "view_open", view: "UIDemoSettings", view_id: SETT_VIEW_ID }, { value: fieldInt(1) }, ns("2026-01-15T10:02:05Z")),
    line("ui_event", { session: SESS_EVENTS, type: "view_close", view: "UIDemoSettings", view_id: SETT_VIEW_ID }, { value: fieldInt(1), dwell: fieldDouble(0.5) }, ns("2026-01-15T10:02:10Z")),
    line("session", { session: SESS_EVENTS, type: "end" }, { value: fieldInt(1) }, ns("2026-01-15T10:02:11Z")),
  ];
  return `${lines.join("\n")}\n`;
}

function edgeEscaping() {
  const viewName = `My View,Weird=Name \\ "Quoted"`;
  const viewId = "c8\\=x\\,y z000000000000000000000000000";
  const element = "btn \\ Add\\,Load=1\\";
  const lines = [
    line("ui_event", { session: SESS_ESCAPE, type: "view_open", view: viewName, view_id: viewId }, { value: fieldInt(1) }, ns("2026-02-01T08:00:00Z")),
    line("ui_event", { session: SESS_ESCAPE, type: "click", view: viewName, view_id: viewId, element, element_type: "mdu.ui.Fancy Button" }, { value: fieldInt(1) }, ns("2026-02-01T08:00:02Z")),
    line("ui_event", { session: SESS_ESCAPE, type: "toggle", view: viewName, view_id: viewId, element: "Toggle,c=1,a={2},b={3}", element_type: "mdu.ui.Toggle" }, { value: fieldInt(1), on: fieldBool(true) }, ns("2026-02-01T08:00:04Z")),
    line("ui_event", { session: SESS_ESCAPE, type: "view_close", view: viewName, view_id: viewId }, { value: fieldInt(1), dwell: fieldDouble(4) }, ns("2026-02-01T08:00:04Z")),
  ];
  return `${lines.join("\n")}\n`;
}

function edgeUnresolved() {
  const noSnapViewId = "d0e5f000000000000000000000000000";
  const lines = [
    // elements with "anon:path" fallback ids — never any matching snapshot node
    line("ui_event", { session: SESS_UNRES, type: "view_open", view: "UIDemoMainMenu", view_id: MENU_VIEW_ID }, { value: fieldInt(1) }, ns("2026-03-01T12:00:00Z")),
    line("ui_event", { session: SESS_UNRES, type: "click", view: "UIDemoMainMenu", view_id: MENU_VIEW_ID, element: "anon:Canvas/Root/Actions/HBox[2]", element_type: "mdu.ui.Button" }, { value: fieldInt(1) }, ns("2026-03-01T12:00:03Z")),
    line("ui_event", { session: SESS_UNRES, type: "toggle", view: "UIDemoMainMenu", view_id: MENU_VIEW_ID, element: "anon:Toggle List=RareName", element_type: "mdu.ui.Toggle" }, { value: fieldInt(1), on: fieldBool(false) }, ns("2026-03-01T12:00:05Z")),
    // a view that never got a snapshot in this session
    line("ui_event", { session: SESS_UNRES, type: "view_open", view: "UIDemoDialogNeverSnapped", view_id: noSnapViewId }, { value: fieldInt(1) }, ns("2026-03-01T12:00:07Z")),
    line("ui_event", { session: SESS_UNRES, type: "click", view: "UIDemoDialogNeverSnapped", view_id: noSnapViewId, element: "UIConfirm_Button", element_type: "mdu.ui.Button" }, { value: fieldInt(1) }, ns("2026-03-01T12:00:10Z")),
    line("ui_event", { session: SESS_UNRES, type: "close", view: "UIDemoDialogNeverSnapped", view_id: noSnapViewId, element: "UIClose_Button", element_type: "mdu.ui.Button" }, { value: fieldInt(1) }, ns("2026-03-01T12:00:12Z")),
    line("ui_event", { session: SESS_UNRES, type: "view_close", view: "UIDemoDialogNeverSnapped", view_id: noSnapViewId }, { value: fieldInt(1), dwell: fieldDouble(5) }, ns("2026-03-01T12:00:12Z")),
  ];
  return `${lines.join("\n")}\n`;
}

function edgeSnapshots() {
  const view = {
    session: SESS_SNAPS,
    view: "UIDemoMainMenu",
    view_id: MENU_VIEW_ID,
  };
  const ctx = { session: SESS_SNAPS, view: view.view, view_id: view.view_id };
  const ledger1 = {
    key: fieldString("snapshots/2026/04/01/UIDemoMainMenu-141500.yaml"),
    hash: fieldString(LIVE_HASH_1),
    nodes: fieldInt(42),
    width: fieldDouble(1920),
    height: fieldDouble(1080),
    owner: fieldString("Unity-MaterialDesign-UI"),
    platform: fieldString("OSXEditor"),
    screen: fieldString("1920x1080"),
  };
  const ledger2 = {
    ...ledger1,
    key: fieldString("snapshots/2026/04/01/UIDemoMainMenu-141505.yaml.gz"),
    hash: fieldString(LIVE_HASH_2),
  };
  // times chosen monotonically; the ledger point of snapshot 2 follows the
  // click it captures (file write returned after the interaction).
  const tStart = ns("2026-04-01T14:14:00Z");
  const tOpen = ns("2026-04-01T14:14:59Z");
  const tSnap1 = ns("2026-04-01T14:15:00Z");
  const tClick = ns("2026-04-01T14:15:03Z");
  const tSnap2 = ns("2026-04-01T14:15:05Z");
  const tClose = ns("2026-04-01T14:15:06Z");
  const lines = [
    line("session", { session: SESS_SNAPS, type: "start" }, { value: fieldInt(1) }, tStart),
    line("ui_event", { ...view, type: "view_open" }, { value: fieldInt(1) }, tOpen),
    line("ui_snapshot_taken", ctx, ledger1, tSnap1),
    line("ui_event", { ...view, type: "click", element: "UIPlay Button", element_type: "mdu.ui.Button" }, { value: fieldInt(1) }, tClick),
    line("ui_snapshot_taken", ctx, ledger2, tSnap2),
    line("ui_event", { ...view, type: "view_close" }, { value: fieldInt(1), dwell: fieldDouble(7) }, tClose),
  ];
  return `${lines.join("\n")}\n`;
}

// ─── validation (the shape contract the tool parser will be pinned to) ───

/**
 * Strict line-protocol reader: knows the runtime's escaping and errors loudly
 * on anything it can't round-trip. Used to prove every fixture is parseable
 * and canonical before it is committed.
 */
export function parseLine(lineText) {
  // measurement (may contain \, or \s escapes)
  let i = 0;
  let measurement = "";
  while (i < lineText.length) {
    const c = lineText[i];
    if (c === "\\") {
      const next = lineText[i + 1];
      if (next === "," || next === " ") {
        measurement += next; // escape decoding: \, → ',', '\ ' → ' '
      } else if (next === "\\") {
        measurement += "\\";
      } else {
        throw new Error(`unexpected escape in measurement: ${lineText}`);
      }
      i += 2;
      continue;
    }
    if (c === "," || c === " ") {
      break;
    }
    measurement += c;
    i++;
  }

  const tags = {};
  let fieldStart = false;
  while (i < lineText.length && lineText[i] === ",") {
    i++;
    let key = "";
    let valueStart = false;
    let value = "";
    let done = false;
    while (i < lineText.length && !done) {
      const c = lineText[i];
      if (c === "\\") {
        const next = lineText[i + 1];
        if (next === "s" || next === " " || next === "," || next === "=" || next === "\\") {
          if (valueStart) {
            value += next === "s" ? " " : next;
          } else {
            key += next === "s" ? " " : next;
          }
        } else {
          throw new Error(`unexpected escape in tag: ${lineText}`);
        }
        i += 2;
        continue;
      }
      if (!valueStart && c === "=") {
        valueStart = true;
        i++;
        continue;
      }
      if (c === "," || c === " ") {
        done = true;
        break;
      }
      if (valueStart) {
        value += c;
      } else {
        key += c;
      }
      i++;
    }
    if (!valueStart) {
      throw new Error(`tag without value: ${lineText}`);
    }
    tags[key] = value;
    if (lineText[i] === " ") {
      fieldStart = true;
      i++;
      break;
    }
  }
  if (!fieldStart) {
    throw new Error(`no field section: ${lineText}`);
  }

  const fields = {};
  while (i < lineText.length && lineText[i] !== " ") {
    let key = "";
    while (i < lineText.length && lineText[i] !== "=") {
      key += lineText[i];
      i++;
    }
    if (i >= lineText.length) {
      throw new Error(`field without value: ${lineText}`);
    }
    i++; // '='
    let value = "";
    if (lineText[i] === '"') {
      i++;
      let closed = false;
      while (i < lineText.length) {
        const c = lineText[i];
        if (c === "\\") {
          const next = lineText[i + 1];
          if (next === '"' || next === "\\") {
            value += next;
            i += 2;
            continue;
          }
          throw new Error(`unexpected escape in string field: ${lineText}`);
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) {
        throw new Error(`unterminated string field: ${lineText}`);
      }
    } else {
      while (i < lineText.length && lineText[i] !== "," && lineText[i] !== " ") {
        value += lineText[i];
        i++;
      }
    }
    if (lineText[i] === ",") {
      i++;
    }
    fields[key] = value;
  }
  if (lineText[i] !== " ") {
    throw new Error(`missing timestamp separator: ${lineText}`);
  }
  i++; // space is the tag→field→timestamp separator

  // final whitespace-separated token = timestamp
  const ts = lineText.slice(i);
  if (!/^\d+$/.test(ts)) {
    throw new Error(`malformed or missing timestamp: ${lineText}`);
  }
  return { measurement, tags, fields, ts };
}

/**
 * Asserts one generated fixture satisfies the P0 shape contract:
 * everything round-trips, ledger lines carry only bounded tags plus the
 * documented fields with a well-formed key/hash.
 */
export function validateFixture(name, text) {
  for (const lineText of text.trimEnd().split("\n")) {
    parseLine(lineText); // throws on anything unparseable
    const { measurement, tags, fields } = parseLine(lineText);
    if (measurement === "ui_snapshot_taken") {
      for (const t of ["session", "view", "view_id"]) {
        if (!tags[t]) {
          throw new Error(`${name}: ledger line missing tag '${t}': ${lineText}`);
        }
      }
      if (tags.type || tags.element || tags.element_type) {
        throw new Error(
          `${name}: ledger line must be tag-bounded to session/view/view_id: ${lineText}`,
        );
      }
      for (const f of [
        "key",
        "hash",
        "nodes",
        "width",
        "height",
        "owner",
        "platform",
      ]) {
        if (!(f in fields)) {
          throw new Error(`${name}: ledger line missing field '${f}': ${lineText}`);
        }
      }
      if (!/^snapshots\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/.test(fields.key)) {
        throw new Error(`${name}: malformed storage key: ${lineText}`);
      }
      if (!/^[0-9a-f]{64}$/.test(fields.hash)) {
        throw new Error(`${name}: hash is not 64 lowercase hex chars: ${lineText}`);
      }
      if (!fields.screen || !/^\d+x\d+$/.test(fields.screen)) {
        throw new Error(`${name}: screen must be "WxH": ${lineText}`);
      }
      if (!/^\d+i?$/.test(fields.nodes) || Number(fields.nodes.replace(/i$/, "")) < 0) {
        throw new Error(`${name}: nodes must be a non-negative int: ${lineText}`);
      }
    }
    if (measurement === "ui_event" || measurement === "session") {
      if (!tags.session || !tags.type) {
        throw new Error(`${name}: ui_event without session/type tag: ${lineText}`);
      }
      if ("element" in tags !== "element_type" in tags) {
        throw new Error(`${name}: element/element_type must pair: ${lineText}`);
      }
    }
  }
}

// ─── orchestration ───────────────────────────────────────────────────────

export function edgeFixtures() {
  return new Map([
    ["edge-events.lp", edgeEvents()],
    ["edge-escaping.lp", edgeEscaping()],
    ["edge-unresolved.lp", edgeUnresolved()],
    ["edge-snapshots.lp", edgeSnapshots()],
  ]);
}

async function main() {
  const shouldCheck = process.argv.includes("--check");
  const skipLive = process.argv.includes("--no-live");

  const files = edgeFixtures();
  if (skipLive) {
    console.log("(--no-live) skipping live InfluxDB replay");
  } else {
    if (!(await influxReachable())) {
      console.error(
        `InfluxDB at ${INFLUX_URL} unreachable. Start it with:` +
          ` docker compose -f Extra/Infrastructure/docker-compose.yml up -d` +
          ` (or pass --no-live for edge fixtures only).`,
      );
      process.exit(1);
    }
    const points = await queryLivePoints();
    for (const [name, text] of replayFixtures(points)) {
      files.set(name, text);
    }
  }

  for (const [name, text] of files) {
    validateFixture(name, text);
  }

  if (shouldCheck) {
    let drift = false;
    for (const [name, text] of files) {
      const path = join(fixturesDir, name);
      let current = null;
      try {
        current = readFileSync(path).toString();
      } catch {
        console.error(`MISSING fixture: ${path}`);
        drift = true;
        continue;
      }
      if (current !== text) {
        console.error(`STALE fixture (rerun scripts/export-fixtures.sh): ${path}`);
        drift = true;
      }
    }
    if (drift) {
      process.exit(1);
    }
    console.log(
      `fixtures reproducible (${files.size} files, ` +
        `corpus ${createHash("sha256")
          .update(JSON.stringify([...files.entries()]))
          .digest("hex")
          .slice(0, 16)})`,
    );
    return;
  }

  mkdirSync(fixturesDir, { recursive: true });
  for (const [name, text] of files) {
    writeFileSync(join(fixturesDir, name), text);
    console.log(`wrote ${name} (${text.trimEnd().split("\n").length} lines)`);
  }
  console.log(`fixtures written to ${fixturesDir}`);
}

// Only run the pipeline when executed directly (importable for unit tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
