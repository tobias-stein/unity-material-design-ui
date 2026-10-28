# Unity MaterialDesign UI

A Unity UI framework with Material 3 (Material Design 3) components, plus a
runtime **UI telemetry pipeline** and two local tools that visualize what it
records. Assets/Runtime hosts the framework and telemetry code; `Extra/` hosts
the tooling.

## Highlights

- **Material 3 components** (`Assets/Runtime/Components`, `Views`, `Themes`):
  MaterialDesign UI kit — themable Material 3 tokens, light/dark palettes.
- **UI telemetry** (`Assets/Runtime/Telemetry`): interaction/view events and
  full UI-snapshot captures, shipped over InfluxDB v2 (org `mdu`, bucket
  `ui`) or file archives, with an outbox delivery, a kill switch
  (`TelemetryConfig`), and `ui_snapshot_taken` ledger points whose
  `hash` field joins each recorded snapshot to its bytes on disk.
- **Snapshot viewer** (`Extra/snapshot-viewer/`): standalone HTML renderer
  for a single snapshot capture. Consumes the shared
  `@mdu/snapshot-render` package — see its
  [README](Extra/snapshot-viewer/README.md).
- **UI telemetry viewer** (`Extra/telemetry-viewer/`): local web tool
  (read-only toward sources) — session search, zoomable per-session
  timelines with pixel-faithful replays, cross-session canonical-key
  heatmaps with structure-version modes A/B/C. See its
  [README](Extra/telemetry-viewer/README.md).
- **Telemetry architecture guide** ([docs/telemetry](docs/telemetry/index.html)):
  interactive system map, twelve-step data flow, timeline lab, failure
  matrix, config reference, and ADR rationale. No build step; see the
  [guide README](docs/telemetry/README.md) to serve it locally.

## Telemetry tooling quickstart

```sh
docker compose -f Extra/Infrastructure/docker-compose.yml up -d --build
# → telemetry viewer: http://localhost:8087
# → InfluxDB:         http://localhost:8086 (org mdu, bucket ui)
```

Play a demo scene in the Unity editor (telemetry on), then open the viewer:
sessions appear with owner/platform/screen metadata straight from the
ledger. The `Extra/telemetry-viewer/README.md` documents sources, view
modes, env vars and the perf gate (`node scripts/perf-check.mjs`).

The telemetry stack is strictly read-only toward InfluxDB and snapshot
files; the local dev Influx token lives only in compose/Unity dev defaults —
never commit production tokens.

## Development

- Unity project: open in Unity 6 (editor scripts + `Demo` scenes).
- Tools workspace: `cd Extra/telemetry-viewer && corepack pnpm test`
  (server + shared package suites) and `corepack pnpm build`.

## License

MIT — see [LICENSE](LICENSE).
