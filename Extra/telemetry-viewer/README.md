# UI Telemetry Viewer

Local web tool to visualize the UI telemetry the Unity app already produces:

- **Session list / timeline** — search across sessions; every session opens
  (`#/session/:id`) into a zoomable NLE-style timeline with pixel-faithful
  snapshot replays (P2).
- **Aggregate heatmaps** — which UI elements get used most, overlaid on
  replica renders across many sessions (P3+).

Everything is **strictly read-only** toward InfluxDB and snapshot files.

## Run (compose, ≤ 5 commands)

```bash
docker compose -f Extra/Infrastructure/docker-compose.yml up -d --build
# → viewer:  http://localhost:8087
# → influx:  http://localhost:8086 (org mdu, bucket ui; play a demo session
#   in Unity to produce data)
```

Local (non-docker) development, equivalent flow:

```bash
cd Extra/telemetry-viewer
corepack pnpm install
corepack pnpm --filter @mdu/telemetry-viewer-web build   # static client
corepack pnpm --filter @mdu/telemetry-viewer-server dev   # Fastify :8087
```

## What ships in P1

- **`GET /api/sources`** — honest, always-JSON health of every source:
  `influx` reachability + distinct-session count, `lp-files` root auto-scan
  info, and `snapshots` storage status. Missing `SNAPSHOT_ROOT`/`LP_ROOT`
  reports `state: unconfigured` with overall `status: degraded` and HTTP 200 —
  degradation is data, not a server error.
- **`GET /api/sessions`** (`q`, `from`, `to`, `limit`) and
  **`GET /api/sessions/:id`** — the session read model. Everything here is
  projected from ledger points only (`session`, `ui_event`,
  `ui_snapshot_taken`): start/end bounds, event counts per type, view
  open/close spans with dwell, and owner/platform/screen straight from the
  `ui_snapshot_taken` fields. **No snapshot YAML is ever parsed at this
  level** (unit-tested with a spy).
- **Web client** (Vite + TS SPA, dark tool chrome): sessions table with
  search/date filter, source pills, and explicit empty/broken states
  (influx down → retry block; no sessions; no match; no snapshots dir).
- **Parity**: the `.lp` file source and the InfluxDB source produce
  byte-identical domain objects (tested against the committed P0 fixtures and
  a captured annotated-CSV corpus). For a session backed by files, files win
  and Influx results for the same id are ignored — never double-counted.

### Error shape

Every error is `{"code": string, "message": string, "detail"?}`, 4xx/5xx —
never HTML. Examples: `INFLUX_UNAVAILABLE` (Influx down → 503),
`INFLUX_UNAUTHORIZED`, `SESSION_NOT_FOUND` (404), `INVALID_TIME` (400).
Snapshot errors: `SNAPSHOT_STORE_UNCONFIGURED`/`SNAPSHOT_STORE_UNREACHABLE`
(503), `SNAPSHOT_ARTIFACT_MISSING` / `SNAPSHOT_NOT_IN_LEDGER` /
`SNAPSHOT_INDEX_OUT_OF_RANGE` (404), `SNAPSHOT_YAML_INVALID` /
`SNAPSHOT_EMPTY` / `SNAPSHOT_PARSE_FAILED` (409, hash included in
`detail`), and `INVALID_SNAPSHOT_REF` (400).

## What ships in P2 (single-session timeline)

Every session row now opens into `#/session/<id>` — a NLE-style timeline
beside a live UI replica:

- **Canvas timeline** (`web/src/views/timeline.ts`): adaptive ruler
  (nice 1/2/5 decades), wheel = zoom around the cursor, shift+wheel /
  two-finger = pan, drag pan, pinch = zoom around the two-pointer midpoint,
  double-click = fit. Window bounds: full session ≥ span ≥ 1 ms (ms
  resolution cap). Redraw is dirty-flag driven (idle rAF costs ~0 draw); the
  footer shows a live fps + draw-time readout.
- **Lanes** (server constants `LANE_ORDER`): `view open/close` with dwell
  span bars, `click`, `toggle` (on/off colored), `close`, `backdrop_click`,
  and **unresolved** — every interaction a snapshot could not hold rides the
  timeline on the unresolved lane (§6.1: never dropped). Dense stretches
  collapse into per-pixel density bars, sparse stretches draw marbles; a
  5k-event session stays interactive without per-event DOM.
- **Filmstrip**: one simplified blocky mini-map per snapshot capture
  (computed by `@mdu/snapshot-render`'s `computeMiniMap`), fetched lazily
  with bounded concurrency; a click on the strip snaps the playhead; ⚠ marks
  captures with the geometry warning.
- **Playhead**: drag in the ruler, click anywhere to place, `←/→` step
  events, `PgUp/PgDn` snap to snapshot anchors, `Home/End`, `+/−` zoom.
  The replica panel renders the *nearest capture at or before the playhead*
  through the shared renderer (`@mdu/snapshot-render`,
  `bytes → js-yaml → pre-shaped JSON → DOM`). Wheel over the replica is
  inert (the timeline is the only zoom surface); theme toggle (default-light
  / raw, persisted per session in `sessionStorage`) re-derives render colors
  from palette **roles** — captured theme colors are never copied implicitly
  (§3.8). The exporter's geometry warning ("capture likely ran before layout
  was applied") surfaces as warning chips above the replica, same as the
  standalone viewer.
- **Server routes**: `GET /api/sessions/:id/timeline` (the whole frame in
  one DTO; `eventCount` equals `<Session>`'s exactly — tested invariance)
  and `GET /api/snapshots/:sessionId/:ref` where `ref` is the numeric
  ledger index, a `hash:<sha256>` literal, or `?near=<epochMs>[&viewId=…]`
  for "the capture played at that wall-clock moment". Snapshot YAML is
  parsed **server-side only** (js-yaml on gunzipped bytes, bounded LRU) —
  no YAML, tmp paths, or tokens ever reach the web bundle.
- **Dev helper**: `node scripts/make-big-session-lp.mjs --out <LP_ROOT>`
  writes a deterministic synthetic `.lp` (default 5k `ui_event`, optional
  `ui_snapshot_taken` ledger anchors, `--anchors 0` for the
  unresolved-lane stress) for fps verification without a Unity run.

## Env vars (server)

| Var | Default | Meaning |
| --- | --- | --- |
| `INFLUX_URL` | `http://localhost:8086` | InfluxDB v2 base URL (compose: `http://influxdb:8086`) |
| `INFLUX_ORG` / `INFLUX_BUCKET` | `mdu` / `ui` | Target org/bucket (read-only) |
| `INFLUX_TOKEN` | local dev token | Bearer token for `/api/v2/query`. Baked compose/dev default only — override in any non-dev setup. Never shipped to the web bundle. |
| `INFLUX_TIMEOUT_MS` | `10000` | Query/health timeout |
| `LP_ROOT` | — | Directory auto-scanned for `*.lp` session files (file source; mount read-only in compose) |
| `SNAPSHOT_ROOT` | — | Snapshot storage root; surfaced in `/api/sources` and resolved by `/api/snapshots/:sessionId/:ref` since P2 (store probe → honest 503/404; mount read-only in compose) |
| `PORT` / `HOST` | `8087` / `0.0.0.0` | Server bind |
| `WEB_DIST` | `<repo>/web/dist` | Where the built client lives (served statically with SPA fallback) |

Queries the server runs: `GET /health` and `POST /api/v2/query` (Flux) —
nothing else; the tool performs **no writes**.

## Precision note

InfluxDB 2.7 OSS returns query CSV with microsecond-precision timestamps and
no annotation rows (tables separated by blank lines). The parser handles both
OSS and Annotated-CSV output; for exact nanosecond truth the `.lp` fixtures
are canonical (that is also why files win the merge).

## Tests & fixtures

`server/test/fixtures/` holds the committed, reproducible corpus the server
tests run against (`./scripts/export-fixtures.sh` regenerates):

- `replay-<sessionId>.lp` — canonical replays of the live demo data.
- `csv-smoketest01.csv`, `csv-multi-table-smoketest.csv` — exact annotated
  CSV wire captures (single-table and OSS multi-table shapes) of the same
  sessions, locking **source parity** (`lp ↔ influx`) to the real formats.
- `edge-*.lp` — toggles, dwell, Unity line-protocol escapes, ledger points,
  unresolved `anon:` events that must never be dropped.

```bash
cd Extra/telemetry-viewer
corepack pnpm --filter @mdu/telemetry-viewer-server test     # 62 tests
corepack pnpm test                                          # whole workspace
```

P2 adds `timeline.spec.ts` (correlation "latest ≤ t", unresolved-never-dropped,
event-count invariance, dwell spans, synthetic 5k frame) and
`snapshots.spec.ts` (gz sniffing, geometry-warning parity with the standalone
viewer, id normalization, `SnapshotService` store probing + LRU).

## P0 ledger basis (runtime side)

Every successful snapshot export records one **ledger point** in the same
event pipeline as interaction events:

```
ui_snapshot_taken,session=<sid>,view=<View>,view_id=<guid> key=<storageKey>,hash=<sha256>,nodes=<n>,width=<w>,height=<h>,owner=<product>,platform=<p>,screen=<WxH> <ns>
```

- `key` — device-agnostic **storage key** (`snapshots/<yyyy>/<mm>/<dd>/<fileName>`,
  forward slashes; the leaf equals the on-disk file name). Files themselves
  stay flat in the legacy layout.
- `hash` — lowercase SHA-256 of the exact written bytes (the join key; `key`
  is only a lookup hint). Files and points are produced after the write
  returns, so a recorded point always has its bytes on disk.
- Tags are the bounded set `session/view/view_id` only (same series space as
  `ui_event`); everything identifying lives in fields to keep series
  cardinality linear.
- Config: `TelemetryConfig.snapshotLedger` (default on; requires
  `eventsEnabled`). Delivery rides the normal sinks — `pending-*.lp` when
  InfluxDB is down, `session-<id>.lp` in file-archive mode.

## Manual verification runbook (per P0 acceptance)

Run these in the Unity editor; the config toggles live on `TelemetryConfig`
(recorded in `Resources/Settings/TelemetrySettings` or set via
`Telemetry.configure(cfg => …)` in the demo bootstrap):

1. **Ledger emission** — play the demo scene, interact, press F9 a few times,
   quit. In `persistentDataPath/Telemetry/events` every written snapshot has
   exactly one `ui_snapshot_taken` line, emitted *after* the file write, with
   `hash` matching: `shasum -a 256 `*"the snapshot file"*` == hash` field.
   Influx mode: line lands in the next `pending-*.lp` (deleted once InfluxDB
   acks); pull InfluxDB down mid-run (`docker compose stop influxdb`) to see
   the outbox keep it.
2. **File-archive mode** — set `influxEnabled = false`, rerun: the
   `ui_snapshot_taken` line lands in `session-<session-id>.lp`.
3. **Kill switch** — set `snapshotLedger = false`, rerun: no
   `ui_snapshot_taken` lines, and the `ui_event`/`session` lines are
   byte-identical to the run in step 1 (diff the files).
4. **Failed export ⇒ no point** — code path guarantee in
   `UISnapshotExporter.exportToFileAsync`: the write failure path returns
   null and never reaches the ledger-emitting continuation.

## Roadmap

Phased delivery per `~/.opencode/plan/ui-telemetry-viewer.md` — P0 (ledger +
fixtures), P1 (tool skeleton, Influx source, session list) and P2
(single-session timeline + snapshot replays) are done; next up P3 (aggregate
mode A heatmaps), P4 (version modes B/C), P5 (switch the standalone
`Extra/snapshot-viewer` over to the already-shared `@mdu/snapshot-render`
package).
