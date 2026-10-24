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
corepack pnpm build   # shared render package → server → static web client
corepack pnpm --filter @mdu/telemetry-viewer-server dev   # Fastify :8087
```

`pnpm build` also refreshes the browser bundle that the standalone
`Extra/snapshot-viewer` consumes (see its README — one declared import, no
vendored render code).

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
  (nice 1/2/5 decades), wheel = scroll tracks when the session has more rows
  than fit (zoom at the cursor otherwise), ctrl+wheel/pinch = zoom (around the
  cursor / two-pointer midpoint), shift+wheel / two-finger = pan, drag pan,
  double-click = fit. Window bounds: full session ≥ span ≥ 1 ms (ms
  resolution cap). Redraw is dirty-flag driven (idle rAF costs ~0 draw); the
  footer shows a live fps + draw-time readout.
- **Tracks = views** (audio/video-editor layout): every open/close cycle of a
  view renders as a clip on its view's row — main views and popup-layer views
  (Dialog, Snackbar) alike. The server packs spans minimally: spans of the
  same view share one stable row (their covered gaps stay visible, never
  merged), rows are reused as spans end. Popup rows get their own filmstrip
  from popup snapshots (captured at popup show() in the Unity runtime);
  legacy sessions infer popup clips from interaction events. Events with no
  view attribution ride the "no view attribution" pseudo row.
- **Filmstrip per clip**: one simplified blocky mini-map per snapshot capture
  *of that view's span* (computed by `@mdu/snapshot-render`'s
  `computeMiniMap`), fetched lazily with bounded concurrency; a click on a
  clip focuses that view and snaps the playhead to its nearest capture; ⚠
  marks captures with the geometry warning.
- **Events inside the clips**: every interaction renders as a marble inside
  the view's clip (click/toggle on-off colored/close/backdrop), dense
  stretches collapse into per-pixel density bars, sparse stretches draw
  marbles; a 5k-event session stays interactive without per-event DOM.
  Interactions of dialog/snackbar elements are attributed to the popup
  (runtime resolves the owning view), so their marbles land on the popup's
  clip. Snapshot-less events stay honest with hollow rings; "unresolved"
  (§6.1) events are **never dropped** — they ride their view's track with the
  ring treatment (no-view ones on the pseudo row).
- **Composite replica at the playhead** (2026-10-21): the replica panel renders
  the *layered composite UI state* at the playhead — every view whose span
  covers the moment shows its own capture, stacked bottom→top by canvas layer
  (`BACKGROUND < DEFAULT < MENU < POPUP`, enum order = z-order), so dialogs and
  snackbars overlay the main view like the live app. Overlay stages render
  transparent (captured scrim alphas come through) and are placed from the
  captured root anchor shape (y-flipped Unity→CSS; legacy captures without
  anchor data fall back to centered); each overlay carries a `view · layer`
  chip and the focused layer gets an outline. The §6.1 "latest ≤ t" pick applies
  per span, plus an opening-capture grace rule (the capture's ledger point
  lands a few ms after the `view_open` event — the span's first capture shows
  for it). Spans on screen whose chain holds no capture surface as warn chips.
  Follow-selection (filmstrip clicks / event moves) chooses the highlighted
  layer. The replica renders through the shared renderer
  (`@mdu/snapshot-render` — layer rules in `composite.ts`, pure + unit-tested);
  theme toggle (default-light / raw, persisted per session in `sessionStorage`)
  re-derives render colors from palette **roles** — captured theme colors are
  never copied implicitly (§3.8). The exporter's geometry warning ("capture
  likely ran before layout was applied") surfaces as warning chips above the
  replica, same as the standalone viewer.
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

## What ships in P3 (aggregate mode A — common-only)

`#/aggregate` — the cross-session heatmap of which UI elements get used most:

- **Period picker**: sessions multi-select (searchable checkboxes) OR a UTC
  `from`/`to` range — the server accepts one or the other, never both.
- **Canonical element keys** (plan §6.2 — `server/src/core/canonical.ts`):
  cross-session identity is the element **tree path**, not the unstable
  runtime `_id`:
  `canonicalKey = viewKey › <path segments…> › elementType` — `viewKey` is
  the snapshot's `view.type` with a trailing `(Clone)` stripped; each path
  segment is the node `name` when meaningful, else the plan's
  `{kind}:{type}[{siblingIndex}]` fallback. The element node itself ends the
  path so same-typed siblings stay separable. Confidence:
  `exact` (all named segments) vs `approximate` (any fallback/anonymous
  segment). Events with no resolvable snapshot node are not graded — they
  surface in the dedicated **unresolved** bucket, grouped by view +
  `element_type` only.
- **Intersection counting** (mode A, §7 a): interactions
  (`click`/`toggle`/`close`/`backdrop_click`) resolve via the exact §6.1
  playhead rule (latest anchor of the same `view_id` at or before the event)
  and then id-join onto the parsed snapshot node. Structure fingerprints
  (`server/src/core/fingerprint.ts`) cluster each viewKey's snapshots into
  versions; mode A counts only keys present in **all** versions and hides
  the rest — quantified, not lost.
- **Divergence badge**: `N divergent viewKeys — M keys hidden` plus the
  "switch to version split →" entry point; absent when nothing diverges.
  (In P3 the split itself was a notice; P4 ships modes B/C — see the next
  section.)
- **Template snapshots** (§7 A): per viewKey, the latest snapshot whose
  structure covers the whole intersection (timestamp, hash-tiebreak — a pure
  function of data content, so repeated queries render identically). The
  payload carries the parsed template; the client paints per-key heat
  overlays through the shared renderer's `[data-node-id]` mapping.
- **Heat overlays + ranked lists**: per-view tabs render the replica at
  default-light tokens (`@mdu/snapshot-render`), with stepwise-alpha
  intensity fill for every counted element, a `Top 5` mode, and click-to-
  highlight from the ranked side list. The "All views" tab ranks global
  hotspots across viewKeys. **Captured themes are ignored** (§3.8) — a
  dark-seeded snapshot renders as the hardcoded light Material-3 baseline.
- **CSV export** (`GET /api/aggregate/export.csv`, same selection rules):
  header exactly `canonicalKey,view,viewId,element,count,dimensions`,
  RFC-4180 quoting (commas/quotes/newline fields escaped; `dimensions` =
  template node rect as `WxH`).
- **Server routes**: `GET /api/aggregate` with
  `sessions=<id,id,…>` XOR `from`/`to` (+ optional `mode=a`). New error
  codes: `AGGREGATE_SELECTION_MISSING` / `_INVALID` / `_TOO_LARGE`,
  `AGGREGATE_UNKNOWN_SESSIONS`, `AGGREGATE_MODE_NOT_AVAILABLE` (P3 shipped
  only `mode=a`; P4 added b/c — see the next section). Snapshot resolution
  problems degrade per-artifact into `warnings` with unresolved
  `snapshot-unavailable` reasons — one missing file never turns the aggregate
  into a 500.


## What ships in P4 (aggregate version modes B + C)

The §7 mode machine is now live end to end: **A common-only → B version
split → C ground-truth merge (pick a version group) → exit back to B (pick
retained) → back to A re-intersects cleanly**. The counting loop itself is
mode-agnostic — every resolved event is stamped with the structure-version
index of the snapshot it actually resolved through (`perVersion`
attribution, never re-parsed or inferred), and the modes slice that table.

- **Version split (mode B)**: `mode=b`, entered from the divergence badge.
  Each **divergent** viewKey gets one group per structure fingerprint —
  chronological ordinal `<viewKey>#<i>` (`groupId`, e.g. `mdu.ui.Dialog#2`),
  its **own** template snapshot (latest of the cluster, timestamp/hash
  tie-break) and its **own** counts, including zero-count structure rows so
  every key of that UI version is visible. A `⊕ n new · ⊖ n missing` diff
  vs. the **earliest** version (count rows + explorable chip tooltips) and a
  "pick as ground truth →" action round out each group. The
  **no-duplication check** holds structurally: groups partition events by
  the version the resolving snapshot belongs to — `Σ group eventCounts` =
  all resolved events of the viewKey, nothing counted twice. Non-divergent
  viewKeys render exactly like mode A (§7 B's "in A" rule).
- **Ground-truth merge (mode C)**: `mode=c&group=<viewKey>#<i>`. The picked
  version's template is the **only geometry**; every other version's keys
  are folded onto ground-truth keys by `matchCanonicalKey`
  (`server/src/core/versioning.ts`): compares path segments **from the leaf
  upward**, contiguously (longest common ancestry — this is what keeps a
  *moved* element matchable), with these wildcard rules for fallback
  segments — index-only segments of the same `kind:type` wildcard against
  each other at **any** depth; an index-only segment at the **leaf**
  position fully wildcards when the canonical `elementType` matches; ≥ 1
  matched path segment is required (a shared elementType alone matches
  nothing). Deterministic greedy tie-break: max depth → fewer wildcards →
  lexicographically smallest key. Merged rows carry per-row **fold
  receipts** (source key, version, depth, wildcard count). The
  **unmatched keys panel** keeps every `(key, version)` pair that matched
  nothing — counted, never dropped — so the invariant
  `Σ merged counts + Σ unmatched counts = all events of the viewKey` always
  holds. "exit merge → back to split" returns to B with the pick retained;
  other divergent viewKeys stay version-split while one is merged.
- **Client**: the tab surface is shared (`renderSurface`) so replica +
  heat overlay + ranked list behave identically on a common view, a version
  group and the merged ground truth; overlays are scoped per surface
  section because several replicas share one page's `[data-node-id]` map.
  Tab labels switch honestly per mode, and the total badge shows
  `N folded` / `M unmatched` in C.
- **Totals**: new `foldedEvents` / `unmatchedEvents` (mode C). In b/c,
  `resolvedEvents` counts everything the mode surfaces (resolved + hidden —
  nothing is hidden outside b/c's accounting) and `hiddenEvents` /
  `hiddenKeys` are 0.
- **CSV per mode** (`GET /api/aggregate/export.csv`, same header): mode a
  unchanged; mode b emits each group's rows with
  `view = <viewKey>#<i>`, `viewId = <picked template's viewId>`; mode c
  emits merged rows (`view = <viewKey>`) **and** unmatched rows
  (`view = <viewKey>#<i>`, key as-is). Zero-count structure rows are not
  exported (counts-only export, like mode A).
- **New 400 error codes**: `AGGREGATE_GROUP_MISSING` (`mode=c` without
  `group=`), `AGGREGATE_GROUP_MODE_MISMATCH` (`group=` without `mode=c`),
  `AGGREGATE_GROUP_INVALID` (not `<viewKey>#<versionIndex>`),
  `AGGREGATE_GROUP_UNKNOWN` (pick doesn't exist in the selection) and
  `AGGREGATE_GROUP_NOT_DIVERGENT` (single-version viewKey). Each mode-c
  failure message names the valid ordinal range of the current selection.
- **New fixture world**: four `Dialog` structure versions (checked-in
  `server/test/aggregateWorld.ts`) — element moved under a `LayoutGroup`
  container in v3, renamed/anonymous `Switch` variants, `OK` re-parented —
  outputs 22 dedicated tests (`server/test/versionModes.spec.ts`): matcher
  table, fingerprint clusters, mode B groups/diffs/no-duplication, mode C
  merge table + invariant + overlay geometry, error codes, REST routes and
  per-mode CSV.


## What ships in P6 (polish + docs)

**Runtime source configuration — switch sources without a restart.**
The *Sources ⚙* panel on the sessions view (and the REST surface below it)
reconfigures the running server in place:

- **InfluxDB ⇄ directory-only mode**: `influxEnabled` flips with one
  toggle/`PATCH`; the provider list (and the `/api/sources` pills) update on
  the same connection — new requests see the new universe immediately
  (budget identities aside, cached catalogs invalidate with every change).
- **`.lp` root / snapshot root overrides**: a runtime directory points the
  `lp-files` source or the snapshot store at another root for the session;
  the `LP_ROOT`/`SNAPSHOT_ROOT` env values stay the *defaults* (shown as such
  in the panel) and a "Reset" clears the override. Root paths are validated
  (must exist and be a directory) with a 400 `INVALID_CONFIG` otherwise, and
  patches apply **all-or-nothing** — a bad `snapshotRoot` never half-applies
  a good `lpRoot`.
- **Re-scan** forces the next request to rebuild the session catalog from
  disk/Influx even with a hot cache (useful after dropping new `session-*.lp`
  files into the directory).
- Routes (uniform error envelope; the Influx token is never echoed):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sources/config` | Effective runtime config (env vs override, universe mode, `pinned` flag) |
| `PATCH` | `/api/sources/config` | `{ influxEnabled?, lpRoot?, snapshotRoot? }` — validate-then-apply without restart |
| `POST` | `/api/sources/rescan` | Drop caches; returns the fresh `/api/sources` payload |
| `PUT` | `/api/sources/imported` | Activate the imported-files universe `{ files: [{ name, content }] }` |
| `DELETE` | `/api/sources/imported` | Clear the universe — back to all configured sources |

**Imported `.lp` files — the explicit multi-file pick (§3.10).** The panel's
file input picks any number of `.lp` files (up to 200, total ≤ 32 MiB); the
client posts their *contents* and — while the import is active — those files
alone define the temporary session universe: auto-scan and InfluxDB are
bypassed, never merged. The import lives in tool process memory only
(strictly read-only on disk; nothing persisted). An imported session's
timeline works end to end (`origin: imported-files`), and a re-scan is
refused with 409 `UNIVERSE_READ_ONLY` while the universe is active (imported
files don't change on disk). New error codes: `IMPORT_EMPTY`,
`IMPORT_TOO_MANY`, `IMPORT_TOO_LARGE` (413), `IMPORT_INVALID_FILE`,
`IMPORT_PARSE_FAILED`.

**Performance pass (big sessions + months-long aggregeates).**

- **Request coalescing**: identical in-flight `/api/aggregate` requests share
  one build — a burst of tabs/scrubs costs one upstream pass (unit-tested
  with a slow provider: two concurrent requests → one `fetchEvents`).
- **TTL response cache**: aggregate payloads are cached (`AGGREGATE_CACHE_MS`,
  default 15 s, `0` disables) *and* invalidated on every runtime source bump
  (config patch, import, rescan) — a mutation never serves a stale heatmap.
- **Client snapshot fetch coalescing**: on the session timeline, the replica
  panel and the filmstrip share one in-flight fetch per anchor index
  (`snapshotFor`) — scrubbing across captures no longer double-requests.
- **Perf gate script**: `node scripts/perf-check.mjs` boots the real server
  on a synthetic 5k-event session and enforces the §14 thresholds. On the
  dev rig (M-series MacBook, file source): sessions list p95 ≈ 1 ms,
  session meta p95 < 1.2 ms (< 50 ms budget), timeline DTO (5k events) ≈
  15 ms, aggregate over a 500-year range ≈ 4 ms (< 3 s budget). The
  aggregate-over-Influx number rides the same server code path plus the
  Influx query time, and *first cold* runs pay the Flux round-trip — the
  coalesced cache turns repeat visits into sub-ms responses. The script also
  verifies the meta owner/platform arrive from `ui_snapshot_taken` fields
  with **zero snapshot YAML reads** (unit-locked with a parser spy since P1).
- Big-session rendering itself is unchanged from P2 (per-pixel density bars,
  lazy bounded-concurrency filmstrip; `make-big-session-lp.mjs` for the
  `--anchors 0` unresolved-lane stress).

## Env vars (server)

| Var | Default | Meaning |
| --- | --- | --- |
| `INFLUX_URL` | `http://localhost:8086` | InfluxDB v2 base URL (compose: `http://influxdb:8086`) |
| `INFLUX_ORG` / `INFLUX_BUCKET` | `mdu` / `ui` | Target org/bucket (read-only) |
| `INFLUX_TOKEN` | local dev token | Bearer token for `/api/v2/query`. Baked compose/dev default only — override in any non-dev setup. Never shipped to the web bundle. |
| `INFLUX_TIMEOUT_MS` | `10000` | Query/health timeout |
| `LP_ROOT` | — | Directory auto-scanned for `*.lp` session files (file source; mount read-only in compose). Runtime-overridable via `PATCH /api/sources/config` (env value remains the default). |
| `SNAPSHOT_ROOT` | — | Snapshot storage root; surfaced in `/api/sources` and resolved by `/api/snapshots/:sessionId/:ref` since P2 (store probe → honest 503/404; mount read-only in compose). Runtime-overridable via `PATCH /api/sources/config`. |
| `AGGREGATE_CACHE_MS` | `15000` | TTL cache for aggregate payloads + request coalescing (P6). `0` disables caching (coalescing stays on). Cache invalidates on every source-config/import/rescan change. |
| `PORT` / `HOST` | `8087` / `0.0.0.0` | Server bind |
| `WEB_DIST` | `<repo>/web/dist` | Where the built client lives (served statically with SPA fallback) |

Queries the server runs: `GET /health` and `POST /api/v2/query` (Flux) —
nothing else; the tool performs **no writes**.

## Precision note

InfluxDB 2.7 OSS returns query CSV with microsecond-precision timestamps and
no annotation rows (tables separated by blank lines). The parser handles both
OSS and Annotated-CSV output; for exact nanosecond truth the `.lp` fixtures
are canonical (that is also why the files source contributes to the merge
first). Sessions present in several sources are **unioned** per session id —
details (timeline, aggregate) read that merged stream, never a single
provider run (regression 2026-10-21).

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
corepack pnpm --filter @mdu/telemetry-viewer-server test     # 143 tests
corepack pnpm test                                          # whole workspace (server + shared package)
node scripts/perf-check.mjs                                 # P6 perf gates (boots its own server; pass = exit 0)
```

P5 adds the shared package's own suite (`corepack pnpm --filter
@mdu/snapshot-render test`, builds the browser bundle first):
`standaloneParity.spec.ts` — the P5 side-by-side check (real snapshot-viewer
page in jsdom vs. goldens captured from the pre-extraction viewer.js, replica
+ flex + status line) — and `normalize.spec.ts` (anon/duplicate ids, hierarchy
+ orphan re-attachment, schema-drift wording, geometry-warning threshold).
The 2026-10-21 composite replica adds `composite.spec.ts` (canvas-layer rank
ordering, per-span capture pick + opening-capture grace, legacy global-chain
fallback) and `overlayPlacement.spec.ts` (popup-root anchor → CSS placement
with the y-flip, center fallback, transparent-stage rendering). The server's
`snapshots.spec.ts` keeps asserting that its DOM-free parser
stays output-equal to the standalone semantics.

P2 adds `timeline.spec.ts` (correlation "latest ≤ t", unresolved-never-dropped,
event-count invariance, dwell spans, synthetic 5k frame) and
`snapshots.spec.ts` (gz sniffing, geometry-warning parity with the standalone
viewer, id normalization, `SnapshotService` store probing + LRU).

P6 adds `sourceConfig.spec.ts` (env defaults, no-restart influx⇄directory
switch, override + reset semantics, all-or-nothing patch validation,
snapshot-store swap, rescan making new `.lp` files visible over a hot cache,
`PROVIDERS_PINNED` honesty), `importedUniverse.spec.ts` (three explicit files
alone define the universe; rejection table for invalid imports; 413-cap;
clear-restores), and `cache.spec.ts` (coalescing single-build, TTL reuse,
rescan bust, per-query keying). The perf gate itself is
`scripts/perf-check.mjs` (documented above).

P3 adds `canonical.spec.ts` (path rules, exact/approximate grading,
`(Clone)` stripping, root-only elements), `fingerprint.spec.ts`
(same-tree-different-ids ⇒ same fingerprint; layout-only tweaks ⇒ no bump;
union−intersection math; deterministic clustering), `aggregate.spec.ts`
(**hand-computed totals** over a deterministic multi-session world: the same
logical element in two sessions with different runtime `_id`s sums into one
key; mode-A hiding; template stability across repeated queries; unresolved
reason buckets; CSV quoting), and `aggregateApi.spec.ts` (route-level
selection rules, uniform error envelopes, content types, degraded-store
behavior at HTTP level).

## What ships in P5 (shared library extraction finalized)

The rendering core is now **one implementation for both tools** — the
`snapshot-viewer` refactor completed the extraction started in P2:

- **`@mdu/snapshot-render` is the single source of truth** for replica DOM,
  flex re-layout, theme token injection and color/text-style resolution; a
  grep proves render symbols (`hex`/`roleColor`-equivalent/`typeBaseName`/
  `applyTextStyles`/…) live only in the package — the standalone page's
  `viewer.js` keeps only tool chrome (tree/inspector/selection/file loading).
  The package also ships the shared `normalize` pipeline (schema warnings, id
  fill, hierarchy, geometry warning) via a `./normalize` subpath.
- **No-build consumption**: `pnpm build` compiles the package source to an
  IIFE bundle (`dist/snapshot-render.global.js`, `window.MduSnapshotRender`);
  `snapshot-viewer/index.html` declares exactly that import. Tool-side, the
  web client keeps bundling the TS sources through Vite; the server keeps its
  DOM-free parser twin (plan §5.4) — parity between the two is asserted in
  both directions by tests.
- **Side-by-side check scripted**: the package's
  `test/standaloneParity.spec.ts` boots the real snapshot-viewer page in
  jsdom (vendored js-yaml + the built bundle) and renders
  `fixtures/sample.yaml` in replica **and** flex modes against goldens that
  were captured from the *original* `viewer.js` before the extraction — DOM
  identity down to the serialized inline `style` attributes. Regenerating a
  golden requires running `scripts/capture-golden.mjs` consciously (any diff
  is a behavior change to review, never a silent reset). `test/normalize.spec.ts`
  pins the normalization semantics that used to be duplicated.
- **Workspace pinning**: `web` consumes `@mdu/snapshot-render@workspace:*`;
  the standalone page consumes the built artifact by declared path
  (`README.md` in that folder documents the one-time build + `--directory
  Extra` serving). No vendored render code remains anywhere
  (`vendor/` holds only third-party js-yaml).
- **Cross-references**: both tools' READMEs now describe the shared package,
  the `ui_snapshot_taken` ledger semantics and storage-key correlation.

## P0 ledger basis (runtime side)

Every successful snapshot export records one **ledger point** in the same
event pipeline as interaction events:

```
ui_snapshot_taken,session=<sid>,view=<View>,view_id=<guid> key=<storageKey>,hash=<sha256>,nodes=<n>,width=<w>,height=<h>,owner=<product>,platform=<p>,screen=<WxH>[,source=<trigger>] <ns>
```

- **One capture per visibility cycle** (fix 2026-10-21): every view comes from
  the object pool, so a re-opened cycle reuses the *same runtime id*. The old
  cross-cycle dedupe (`view id + node count` vs. the last capture ever, in
  `UISnapshotTriggers`) suppressed the capture of **every open cycle after the
  first** — per view, exactly one capture ever, consecutive snackbars never
  captured. The triggers now capture on every `onViewShown` /
  `onViewActivated` raise and only suppress near-simultaneous duplicate raises
  of the same view (0.1 s window); the 5 s transition rate-limit still applies
  to main-view transitions. Sessions recorded before the fix keep their
  missing captures (nothing is invented — spans without captures surface as
  warn chips in the timeline replica).

- **Runtime-mutation captures** (2026-10-23): UI elements created or removed
  while a view is open (dynamic panels, spawned controls, stack-panel closes)
  refresh a per-view debounce window; one capture fires when the window
  settles, tagged `source=mutation` (or `mutation:queued` when paced). The
  dedupe behind it is cycle-scoped by design — fingerprint equality only
  suppresses *mutation* captures within the *same* visibility cycle, so the
  re-open starvation above cannot return. Lifecycle captures and parse-time
  behaviour are unchanged.
- `source` — capture trigger (`view-transition`, `popup-shown`, `mutation`,
  `hotkey`, or their paced `...:queued` variants); optional field, absent on
  points written before the runtime carried it. The server/timeline ignore it
  today; it is projected for the client (`lp.ts` / `influx.ts`) so future
  badges need no re-parsing.

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

Phased delivery per `~/.opencode/plan/ui-telemetry-viewer.md` — all seven
phases are shipped: P0 (ledger + fixtures), P1 (tool skeleton, Influx
source, session list), P2 (single-session timeline + snapshot replays), P3
(aggregate mode A heatmaps), P4 (version modes B/C — fingerprint group tabs,
ground-truth merge), P5 (the standalone `Extra/snapshot-viewer` now runs on
the shared `@mdu/snapshot-render` package; parity locked) and P6 (runtime
source config, imported-files universe, cache/coalescing perf pass, docs +
perf gate). Everything under plan §13 remains future roadmap: S3-compatible
`SnapshotStore` adapters, multi-bucket/org sources, snapshot upload paths,
ghost-overlay diff rendering inside mode C and element-lifecycle lines.

> **P3 live-data note:** the two committed demo replays (and their live
> InfluxDB counterparts) were captured *before* the P0 runtime change, so
> they hold no `ui_snapshot_taken` points — aggregating them is honestly
> 100 % `unresolved` (see the totals in this README's flow). The canonical
> join itself is unit-locked against the deterministic snapshot-store world
> in `server/test/aggregateWorld.ts` (`aggregate.spec.ts`), and any session
> captured with the current runtime (≥ P0) lands ledger points, so replaying
> the demo scene with snapshots (F9) populates the heatmap end-to-end.
