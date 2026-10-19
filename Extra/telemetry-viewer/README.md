# UI Telemetry Viewer

Local web tool to visualize the UI telemetry the Unity app already produces:

- **Session timeline** — zoomable NLE-style timeline of one session's events,
  with pixel-faithful snapshot replays at the playhead.
- **Aggregate heatmaps** — which UI elements get used most, overlaid on
  replica renders across many sessions.

This directory currently contains the **P0 deliverables** (see
`~/.opencode/plan/ui-telemetry-viewer.md`, §11/P0); the tool itself lands in P1+.
`docker compose -f Extra/Infrastructure/docker-compose.yml up -d` already brings
up a placeholder service on **http://localhost:8087**.

## Runtime basis (what P0 added)

Every successful snapshot export now also records one **ledger point** in the
same event pipeline as interaction events:

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

## Fixtures

`server/test/fixtures/` holds the committed, reproducible corpus the tool's
(P1+) server tests run against:

- `replay-<sessionId>.lp` — canonical replay of the live demo data from
  InfluxDB (one file per session, sorted, deduped).
- `edge-events.lp` — toggles, dwell, view lifecycle, session start/end.
- `edge-escaping.lp` — tag values containing spaces/commas/equals/backslashes
  exactly as the runtime serializer escapes them.
- `edge-snapshots.lp` — `ui_snapshot_taken` points (incl. a `.gz` key) with
  the events they correlate to.
- `edge-unresolved.lp` — interactions whose elements exist in no snapshot
  (incl. `anon:` fallback ids); the viewer must never drop these.

```bash
./scripts/export-fixtures.sh            # regenerate (requires compose InfluxDB running)
./scripts/export-fixtures.sh --check    # verify reproducibility, no writes (CI-friendly)
./scripts/export-fixtures.sh --no-live  # edge fixtures only, no InfluxDB needed
```

Rerunning the script with unchanged InfluxDB contents produces byte-identical
files (`--check` fails otherwise).

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
3. **Kill switch** — set `snapshotLedger = false`, rerun: no `ui_snapshot_taken`
   lines, and the `ui_event`/`session` lines are byte-identical to the run in
   step 1 (diff the files).
4. **Failed export ⇒ no point** — code path guarantee in
   `UISnapshotExporter.exportToFileAsync`: the write failure path returns null
   and never reaches the ledger-emitting continuation (covered by construction:
   emission is strictly on the success continuation of the file write).

