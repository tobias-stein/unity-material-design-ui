# Telemetry architecture guide

An interactive, static guide to the UI telemetry pipeline in this repository:
runtime signals, capture and encoding, delivery and storage, the viewer server,
the browser renderer, and the decisions behind them.

The page has no build step and no dependencies. It is plain HTML, CSS, vanilla
JavaScript, and SVG. Everything runs locally in the browser.

## Open it

Serve the repository root so repository source links resolve locally:

```sh
python3 -m http.server 8765
# open http://localhost:8765/docs/telemetry/
```

If you only need the page and are happy for source links to open GitHub, serve
just the docs folder:

```sh
python3 -m http.server 8765 --directory docs/telemetry
# open http://localhost:8765/
```

Open `index.html` directly only if you do not need the local server. Serving is
recommended.

## What is in the guide

- **System map** — a hand-positioned graph across five planes: runtime, capture,
  transport, viewer server, and browser. Select a node to inspect its
  responsibilities, inputs, outputs, and exact source locations; components
  outside its direct neighbourhood fade into the background.
- **Scenario filters** — dim the graph to the components involved in a capture,
  view lifetime, delivery, viewer read, or failure path.
- **Twelve-step flow** — step through one capture from a UI event to a rendered
  replay, with the active components highlighted.
- **Timeline lab** — capture, view lifetime, delivery, and viewer read-path
  timelines with variants, playback, scrubbing, and item contracts. Durations
  are illustrative; values backed by configuration are labelled.
- **Reference** — measurements and formats, read-only HTTP routes, viewer
  environment, the failure matrix, `TelemetryConfig` defaults, source map, ADRs,
  and practical recipes.

Use the search box, scenario pills, map trace/focus controls, and timeline tabs
to move between overview and detail. Scenario, search, and flow-step changes
clear the current component selection so the filter is visible; pick a node
again to isolate its direct neighbourhood. All controls are keyboard
accessible; the map supports wheel zoom, drag pan, and `Enter`/`Space` on a
focused node.

## Deep links

The page keeps its state in the URL hash, so links can open a precise view:

```text
#node=exporter
#node=exporter&scenario=offline
#timeline=delivery&variant=offline
#node=outbox&scenario=offline&timeline=capture&variant=transition&step=3
```

Supported parameters are `node`, `scenario`, `timeline`, `variant`, and `step`.
Unknown values fall back to the overview.

## Hosting and source links

The page's own assets (`doc.css`, `favicon.svg`, and the data scripts) are
relative and work wherever `docs/telemetry/` is served intact.

Repository links — Files, ADRs, and Repo README — are relative while the guide
is served from the repository root. On load, the page probes one known root
file. If the root is unavailable, such as when only `docs/telemetry/` is
published, it rewrites those links to GitHub: directories under `tree/metrics`
and files under `blob/metrics`. Update `REPO_TREE` and `REPO_BLOB` in `doc.js`
if the branch changes.

## Read-only contract

The guide is documentation, and the viewer it documents is read-only toward
InfluxDB and snapshot files. The guide has no backend, fetches no sources, and
performs no telemetry writes. The viewer server's only mutating routes affect
its own source configuration and import state; they never write to InfluxDB.

See the [viewer README](../../Extra/telemetry-viewer/README.md) for the runtime
tool and its environment.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell, prose, section anchors, deep-dive summaries |
| `doc.css` | Themes, layout, map, timeline, responsive and print styles |
| `doc.js` | Rendering and interaction: map, inspector, search, scenarios, flow, timelines, tables, deep links |
| `favicon.svg` | Small brand mark for the browser tab |
| `data.js` | Meta, planes, mechanics, scenarios, and the twelve-step flow |
| `data.nodes.runtime.js` | Runtime, capture, and transport nodes |
| `data.nodes.viewer.js` | Viewer-server and browser nodes |
| `data.edges.js` | Directed graph edges and scenario membership |
| `data.timelines.js` | Timeline tabs and variants |
| `data.reference.js` | Measurements, formats, routes, config, failures, files, ADRs, recipes |
| `check-links.mjs` | Contract check for data, links, routes, config fields, and page assets |

Each data file extends `window.TELEMETRY_DOC`. The load order in `index.html`
matters: `data.js`, node files, edges, timelines, reference, then `doc.js`.

## Maintaining the guide

When the telemetry code changes, update the data rather than the renderer:

- **Component change** — edit `data.nodes.runtime.js` or
  `data.nodes.viewer.js`, then check edges, scenario membership, and file/symbol
  references.
- **New relationship** — add an edge in `data.edges.js` with a stable `from` and
  `to` node ID.
- **New scenario or flow step** — update `data.js` and the scenario membership
  in `data.edges.js`.
- **Timeline change** — update `data.timelines.js`; use `dur: 0` for instant
  events and label config-backed spans explicitly.
- **Config default or route change** — update `data.reference.js` together with
  `Assets/Runtime/Telemetry/TelemetryConfig.cs` or
  `Extra/telemetry-viewer/server/src/api/app.ts`.
- **New ADR** — add it to `data.reference.js` and link the source in
  `ADRs/README.md`.

### Validate

From the repository root:

```sh
node docs/telemetry/check-links.mjs
for file in docs/telemetry/*.js; do node --check "$file"; done
```

The checker verifies node IDs, edge endpoints, timeline component IDs, referenced
files and symbols, API routes, configuration fields, and the page's asset
references. Run it after any data edit. It fails loudly rather than letting the
guide drift from the repository.
