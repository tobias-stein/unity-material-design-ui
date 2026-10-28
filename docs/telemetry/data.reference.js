/* Telemetry architecture — reference tables, failure matrix, ADRs, recipes. */
(function () {
  "use strict";
  var doc = window.TELEMETRY_DOC;

  doc.reference = {
    measurements: [
      {
        name: "ui_event",
        tags: ["session", "view", "view_id", "layer (optional)", "element", "element_type (optional)"],
        fields: ["value=1i", "on=1i (toggle)", "dwell=<seconds> (view_close)"],
        note: "One point per interaction or lifecycle event. The element tag is bounded; the timestamp is exact nanoseconds."
      },
      {
        name: "session",
        tags: ["type=start|end", "session"],
        fields: ["value=1i"],
        note: "Session boundaries. The end point is written on normal shutdown and on editor play-mode exit."
      },
      {
        name: "ui_snapshot_taken",
        tags: ["session", "view", "view_id"],
        fields: ["key", "hash", "nodes", "width", "height", "owner", "platform", "screen", "source", "mode", "theme", "base", "anchor"],
        note: "The ledger. Emitted only after a successful file write; hash is the authoritative join key. source examples: view-transition, mutation, popup-shown, manual."
      }
    ],

    routes: [
      { method: "GET", path: "/api/health", purpose: "Liveness only; no source probing.", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/sources", purpose: "Effective source status, roots, mode, imported universe.", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/sessions", purpose: "Session list; q/from/to/limit (default 200, max 1000).", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/sessions/:id", purpose: "One projected Session with views, snapshots, metadata.", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/sessions/:id/timeline", purpose: "TimelineFrame: events, spans, rows, lanes, snapshot correlation.", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/snapshots/:id/:ref", purpose: "Resolve ledger entry by index/hash/key; near=<ms> and viewId=<id> supported.", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/aggregate", purpose: "Cross-session heatmap and version groups; sessions XOR from/to; mode=a|b|c; group=<viewKey>#<i>.", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/aggregate/export.csv", purpose: "CSV export of the same aggregate selection.", source: "server/src/api/app.ts" },
      { method: "GET", path: "/api/sources/config", purpose: "Read runtime source config (never the Influx token).", source: "server/src/api/sourcesConfig.ts" },
      { method: "PATCH", path: "/api/sources/config", purpose: "Switch influxEnabled, override LP/snapshot roots; validate-then-apply all-or-nothing.", source: "server/src/api/sourcesConfig.ts" },
      { method: "POST", path: "/api/sources/rescan", purpose: "Force a provider re-scan; 409 while imported universe is active.", source: "server/src/api/sourcesConfig.ts" },
      { method: "PUT", path: "/api/sources/imported", purpose: "Replace the temporary imported .lp universe (200 files / 32 MiB caps).", source: "server/src/api/sourcesConfig.ts" },
      { method: "DELETE", path: "/api/sources/imported", purpose: "Drop the imported universe and return to auto-scan/Influx.", source: "server/src/api/sourcesConfig.ts" }
    ],

    env: [
      { name: "INFLUX_URL", default: "http://localhost:8086", note: "InfluxDB v2 base URL." },
      { name: "INFLUX_ORG", default: "mdu", note: "Must match the runtime default." },
      { name: "INFLUX_BUCKET", default: "ui", note: "Must match the runtime default." },
      { name: "INFLUX_TOKEN", default: "(required for Influx)", note: "Server-only; never echoed to the browser." },
      { name: "INFLUX_TIMEOUT_MS", default: "10000", note: "Provider request timeout." },
      { name: "LP_ROOT", default: "(unset)", note: "Optional .lp directory auto-scan." },
      { name: "SNAPSHOT_ROOT", default: "(unset)", note: "Optional local snapshot directory." },
      { name: "AGGREGATE_CACHE_MS", default: "15000", note: "Aggregate TTL; 0 disables." },
      { name: "CATALOG_CACHE_MS", default: "1000", note: "Session catalog TTL; 0 disables." },
      { name: "PORT", default: "8087", note: "HTTP port." },
      { name: "HOST", default: "0.0.0.0", note: "Bind address." },
      { name: "WEB_DIST", default: "(auto)", note: "Built web client; static hosting is skipped if absent." }
    ],

    formats: [
      {
        name: "MDS v3 binary",
        ext: ".mds",
        magic: "MDS\\n",
        schema: "format/schema 3",
        compression: "none",
        members: "anchor, delta, theme manifest",
        note: "Default. String table + varints; delta members carry baseHash, bases[], nodeCount, fingerprint."
      },
      {
        name: "YAML v2",
        ext: ".yaml / .yaml.gz",
        magic: "(text)",
        schema: "schema 2",
        compression: "optional gzip",
        members: "full snapshot only",
        note: "Escape hatch. The parser supports it indefinitely; binary is the measured default."
      }
    ],

    config: [
      { group: "Feature", field: "enabled", default: "true", effect: "Master switch; bootstrap becomes a no-op when false." },
      { group: "Hotkey", field: "hotkeyEnabled", default: "true", effect: "Enables the manual capture hotkey." },
      { group: "Hotkey", field: "hotkey", default: "F9", effect: "KeyCode used for manual capture." },
      { group: "Hotkey", field: "hotkeyDevOnly", default: "true", effect: "Ignore the hotkey outside the editor/development builds." },
      { group: "View transitions", field: "viewTransitionEnabled", default: "true", effect: "Capture after view activation." },
      { group: "View transitions", field: "viewTransitionMinInterval", default: "1 s", effect: "Minimum spacing; excess captures are deferred, never dropped." },
      { group: "View transitions", field: "viewTransitionSettle", default: "0.5 s", effect: "Wait for a view to populate before capturing." },
      { group: "View transitions", field: "viewTransitionDedupe", default: "true", effect: "Suppresses near-simultaneous duplicate raises of the same view." },
      { group: "Output", field: "outputLocation", default: "PersistentData", effect: "Output root preset; the other option is a custom path." },
      { group: "Output", field: "customOutputPath", default: "\"\"", effect: "Used when outputLocation is Custom." },
      { group: "Output", field: "outputSubfolder", default: "Telemetry/snapshots", effect: "Snapshots subfolder under the root." },
      { group: "Output", field: "fileNameTemplate", default: "{viewName}-{timestamp}", effect: "File stem; sanitized per capture." },
      { group: "Format", field: "gzip", default: "true", effect: "YAML only. Binary output is never gzipped." },
      { group: "Format", field: "snapshotFormat", default: "Binary", effect: "Binary (MDS v3) or legacy YAML v2." },
      { group: "Format", field: "mutationDeltaEnabled", default: "true", effect: "Allow sparse deltas in binary format when a chain exists." },
      { group: "Capture", field: "dataDumpDefaults", default: "true", effect: "Include default-valued data-dump fields; false suppresses them." },
      { group: "Retention", field: "maxFiles", default: "100", effect: "Snapshot file cap; 0 = unlimited." },
      { group: "Retention", field: "maxTotalMB", default: "50", effect: "Snapshot size cap; 0 = unlimited." },
      { group: "Layout", field: "forceRebuildLayout", default: "false", effect: "Force a layout sweep before every capture; bypasses the dirt gate." },
      { group: "Layout", field: "skipPooled", default: "true", effect: "Skip pooled/object-pool subtrees during the walk." },
      { group: "Timing", field: "captureTimingEnabled", default: "true", effect: "Emit one aggregate [Telemetry] timing line per successful capture." },
      { group: "Popups", field: "popupTrackingEnabled", default: "true", effect: "Give popup views their own spans and captures." },
      { group: "Popups", field: "popupExcludedViews", default: "[\"Tooltip\"]", effect: "Popup view names excluded from tracking." },
      { group: "Capture", field: "runtimeCaptureEnabled", default: "true", effect: "Capture at runtime; disabling leaves events only." },
      { group: "Mutation", field: "mutationDebounce", default: "0.25 s", effect: "Coalesce a burst of structural changes." },
      { group: "Mutation", field: "mutationMaxCapturesPerCycle", default: "50", effect: "Per-view cycle cap; further captures are suppressed with a warning." },
      { group: "Mutation", field: "mutationDedupe", default: "true", effect: "Skip a mutation capture whose fingerprint equals the last export." },
      { group: "Ledger", field: "snapshotLedger", default: "true", effect: "Emit ui_snapshot_taken after a successful write." },
      { group: "Events", field: "eventsEnabled", default: "true", effect: "Record interactions, spans, and ledger points." },
      { group: "Events", field: "eventsSubfolder", default: "Telemetry/events", effect: "Events subfolder under the output root." },
      { group: "Events", field: "eventFlushCount", default: "64", effect: "Batch size for event delivery." },
      { group: "Events", field: "eventFlushInterval", default: "1 s", effect: "Maximum batch age." },
      { group: "Events", field: "eventsMaxFiles", default: "100", effect: "Event file-count cap; 0 = unlimited." },
      { group: "Outbox", field: "pendingCoalesce", default: "16", effect: "Maximum pending files combined into one request." },
      { group: "Outbox", field: "pendingCoalesceMaxBytes", default: "512 KB", effect: "Maximum coalesced request body; an oversized head is sent alone." },
      { group: "InfluxDB", field: "influxEnabled", default: "true", effect: "Route to the outbox; false selects FileEventSink archive mode." },
      { group: "InfluxDB", field: "influxUrl", default: "http://localhost:8086", effect: "InfluxDB v2 base URL." },
      { group: "InfluxDB", field: "influxOrg", default: "mdu", effect: "InfluxDB org." },
      { group: "InfluxDB", field: "influxBucket", default: "ui", effect: "InfluxDB bucket." },
      { group: "InfluxDB", field: "influxToken", default: "dev-only default", effect: "Do not ship a production token in a build." },
      { group: "InfluxDB", field: "influxTimeoutSeconds", default: "10 s", effect: "Write request timeout." }
    ],

    failures: [
      {
        signal: "InfluxDB unreachable / 5xx",
        surface: "Runtime outbox",
        behaviour: "The batch remains in pending-*.lp. Retries use exponential backoff (1 s → 60 s cap); delivered files delete only on 2xx.",
        recovery: "The viewer keeps reading the same pending/archive files. When Influx returns, coalescing drains up to 16 files / 512 KB per request.",
        code: "outbox"
      },
      {
        signal: "Snapshot file write fails",
        surface: "Unity exporter",
        behaviour: "exportToFileAsync returns null, logs the error, emits no ledger point, and rolls back the mutation fingerprint so a later identical capture is not deduped away.",
        recovery: "Fix disk/permissions; the next capture retries normally.",
        code: "exporter"
      },
      {
        signal: "Ledger point exists, artifact missing",
        surface: "GET /api/snapshots/:id/:ref",
        behaviour: "404 SNAPSHOT_ARTIFACT_MISSING. Hash is tried first; the storage key is only a hint.",
        recovery: "Restore the file under SNAPSHOT_ROOT or accept an honest missing-replica warning.",
        code: "snapshotservice"
      },
      {
        signal: "Delta chain broken / empty",
        surface: "SnapshotService / chain materializer",
        behaviour: "409 SNAPSHOT_CHAIN_BROKEN or SNAPSHOT_EMPTY after parse. The viewer never presents a partial tree as complete.",
        recovery: "Restore the missing chain member or use an older anchor; retention may have pruned it.",
        code: "parse"
      },
      {
        signal: "Theme manifest missing / pruned",
        surface: "SnapshotService",
        behaviour: "The snapshot resolves with a warning and degraded theme; a manifest-degraded parse is deliberately not cached so a rewritten manifest can self-heal.",
        recovery: "Restore/re-export the manifest; reload the session.",
        code: "thememanifest"
      },
      {
        signal: "No source available",
        surface: "GET /api/sessions or /timeline",
        behaviour: "503 NO_SOURCE_AVAILABLE. The SPA shows a configure-sources state, not an empty session table.",
        recovery: "Set INFLUX_* / LP_ROOT or import .lp files via the Sources panel.",
        code: "catalog"
      },
      {
        signal: "LP root unconfigured or unreadable",
        surface: "lp-files provider",
        behaviour: "The provider reports unconfigured/unreachable/degraded in /api/sources; other providers still serve.",
        recovery: "PATCH /api/sources/config with a valid lpRoot or set LP_ROOT and restart.",
        code: "sourceruntime"
      },
      {
        signal: "Snapshot root unconfigured",
        surface: "SnapshotStore / snapshot routes",
        behaviour: "503 SNAPSHOT_STORE_UNCONFIGURED; the session and timeline still render without replicas.",
        recovery: "Set SNAPSHOT_ROOT (or the runtime override) to the snapshot output directory.",
        code: "snapshotstore"
      },
      {
        signal: "Imported universe is active",
        surface: "POST /api/sources/rescan",
        behaviour: "409 UNIVERSE_READ_ONLY. Imported files alone define the universe; auto-scan is bypassed rather than merged.",
        recovery: "DELETE /api/sources/imported, then re-scan.",
        code: "importedprovider"
      },
      {
        signal: "Invalid source config patch",
        surface: "PATCH /api/sources/config",
        behaviour: "400 INVALID_CONFIG; validation happens before any field is applied (all-or-nothing).",
        recovery: "Correct the field; the previous config remains active.",
        code: "sourceruntime"
      },
      {
        signal: "Geometry violation on a gated capture",
        surface: "UILayoutGate / viewer",
        behaviour: "The capture proceeds but the next capture of that view forces layout once. The viewer shows a ⚠ geometry warning.",
        recovery: "Self-heals on the next capture; a persistent warning means the dirt signal is wrong.",
        code: "layoutgate"
      },
      {
        signal: "Mutation cap reached",
        surface: "UISnapshotTriggers",
        behaviour: "Captures beyond mutationMaxCapturesPerCycle (50) are suppressed for that view cycle and a warning is logged once.",
        recovery: "Increase the cap or reduce churn; the cycle boundary resets it.",
        code: "snapshottriggers"
      },
      {
        signal: "Malformed LP line in a file",
        surface: "lp-files provider",
        behaviour: "The line is counted in the source's malformed count, not silently dropped; valid lines still flow.",
        recovery: "Inspect the source status / file; fix or ignore the offending line.",
        code: "lpprovider"
      },
      {
        signal: "Bad aggregate group pick",
        surface: "GET /api/aggregate?mode=c&group=…",
        behaviour: "400 AggregateGroupError when the <viewKey>#<versionIndex> does not exist.",
        recovery: "Pick a group from the mode-B response or clear group to use the default ground truth.",
        code: "aggregate"
      }
    ],

    files: [
      { path: "Assets/Runtime/Telemetry/", purpose: "Runtime facade, config, host, and feature registration." },
      { path: "Assets/Runtime/Telemetry/Events/", purpose: "Event collector, sinks, outbox, line protocol, file store." },
      { path: "Assets/Runtime/Telemetry/Snapshot/", purpose: "Triggers, builder, delta, exporter, binary/YAML writers, theme manifest, layout gate, timing." },
      { path: "Extra/telemetry-viewer/server/src/api/", purpose: "Fastify routes, query parsing, error envelope, runtime source config." },
      { path: "Extra/telemetry-viewer/server/src/sources/", purpose: "LP file, InfluxDB, imported universes, shared source runtime." },
      { path: "Extra/telemetry-viewer/server/src/core/", purpose: "Catalog union, projection, timeline, aggregate, canonical keys, versioning." },
      { path: "Extra/telemetry-viewer/server/src/snapshots/", purpose: "Snapshot resolution, chain materialization, MDS/YAML parse." },
      { path: "Extra/telemetry-viewer/server/src/storage/", purpose: "Read-only local filesystem snapshot store." },
      { path: "Extra/telemetry-viewer/web/src/", purpose: "Hash-routed SPA, sessions/timeline/aggregate views, API client." },
      { path: "Extra/telemetry-viewer/packages/snapshot-render/src/", purpose: "Shared model, decode, normalize, colors, replica, flex, minimap, composite." },
      { path: "Extra/telemetry-viewer/server/test/", purpose: "Server tests: sources, projection, timeline, aggregate, snapshot store/service, routes." },
      { path: "Extra/telemetry-viewer/packages/snapshot-render/test/", purpose: "Shared renderer/normalizer/binary/composite tests." },
      { path: "ADRs/", purpose: "Performance decision records 0001–0011, including the two declines." },
      { path: "Extra/Infrastructure/docker-compose.yml", purpose: "Local InfluxDB + viewer deployment." }
    ],

    adrs: [
      { id: "0001", title: "Capture-side performance instrumentation", status: "Shipped", summary: "One timing line per successful capture; it is the measurement gate for every later optimization.", file: "ADRs/0001-capture-performance-instrumentation.md" },
      { id: "0002", title: "Single component sweep in fillResolved", status: "Shipped", summary: "One GetComponents pass instead of repeated lookups; reduces the walk's first-order cost.", file: "ADRs/0002-fillresolved-single-component-sweep.md" },
      { id: "0003", title: "Per-Type string caching in the walk", status: "Shipped", summary: "Caches type names/strings by Type so the walk stops re-allocating the same labels.", file: "ADRs/0003-per-type-string-interning.md" },
      { id: "0004", title: "Coalesced pending-file delivery", status: "Shipped", summary: "Batch up to 16 pending files / 512 KB per request without changing the per-batch file cadence.", file: "ADRs/0004-outbox-request-coalescing.md" },
      { id: "0005", title: "Default suppression for Data dumps", status: "Shipped", summary: "dataDumpDefaults=false drops default-valued reflected fields, cutting serialize bytes.", file: "ADRs/0005-data-dump-default-suppression.md" },
      { id: "0006", title: "Gate UILayout.forceNow on layout dirt", status: "Shipped", summary: "Skip the forced rebuild when layout is clean; verify geometry and self-heal with a one-force latch.", file: "ADRs/0006-layout-force-gating.md" },
      { id: "0007", title: "Session-scoped theme manifest", status: "Shipped (with 0008/0009)", summary: "One theme block per session by hash instead of repeating the palette on every capture.", file: "ADRs/0007-session-theme-manifest.md" },
      { id: "0008", title: "Binary snapshot format v3", status: "Shipped (with 0007/0009)", summary: "String table + varints; self-describing magic MDS\\n, format/schema 3, no gzip.", file: "ADRs/0008-binary-snapshot-format-v3.md" },
      { id: "0009", title: "Delta mutation captures on the anchor chain", status: "Shipped (with 0007/0008)", summary: "Sparse deltas against the last member; the chain is resolvable from the store alone.", file: "ADRs/0009-delta-mutation-captures.md" },
      { id: "0010", title: "Walk-level node/data pooling", status: "Declined 2026-10-27", summary: "Gen-0 collections never landed in capture windows; reopens only on Profiler-proven capture-correlated main-thread GC spikes.", file: "ADRs/0010-walk-node-pooling.md" },
      { id: "0011", title: "Memoized composite resolution index", status: "Declined 2026-10-26", summary: "The session had 76 events / 32 anchors; the thousands-of-anchors trigger is two orders of magnitude away.", file: "ADRs/0011-composite-resolution-cache.md" }
    ]
  };

  doc.recipes = [
    {
      title: "Add a new event type",
      steps: [
        "Add the measurement + tags/fields to EventCollector and LineProtocolSerializer; keep identifying payload in fields, not unbounded tags.",
        "If the viewer needs it, extend RawEvent/domain and the LP/Influx parsers without changing wire identity.",
        "Teach sessionProjection or timeline.ts how to interpret it; keep eventCount and event ordering invariants.",
        "Add a server fixture test and check the timeline actually draws every instance."
      ],
      files: ["Assets/Runtime/Telemetry/Events/EventCollector.cs", "Assets/Runtime/Telemetry/Events/LineProtocolSerializer.cs", "Extra/telemetry-viewer/server/src/core/sessionProjection.ts", "Extra/telemetry-viewer/server/src/core/timeline.ts"]
    },
    {
      title: "Add a capture trigger",
      steps: [
        "Raise a signal from UIInteractions/ViewManager, never call telemetry from the UI layer.",
        "Subscribe in UISnapshotTriggers and route through the existing settle/debounce/pacing helpers.",
        "Define the cycle semantics (open/close, mutation cap, dedupe) before adding a new source string.",
        "Add a timing line check and a fixture that proves the trigger creates exactly one capture per intended cycle."
      ],
      files: ["Assets/Runtime/Core/UIInteractions.cs", "Assets/Runtime/Telemetry/Snapshot/UISnapshotTriggers.cs", "Assets/Runtime/Telemetry/Snapshot/UISnapshotBuilder.cs"]
    },
    {
      title: "Add a viewer source provider",
      steps: [
        "Implement SourceProvider (describe/fetch/status) and return RawEvent objects with the shared wire identity.",
        "Register it in SourceRuntime in the intended priority (files first, Influx last) and report health honestly.",
        "Make union/dedupe explicit: same session should merge, not first-win; exact duplicate points collapse.",
        "Add source tests for unavailable, partial, and duplicate streams."
      ],
      files: ["Extra/telemetry-viewer/server/src/sources/runtime.ts", "Extra/telemetry-viewer/server/src/sources/lpFiles.ts", "Extra/telemetry-viewer/server/src/core/sessionCatalog.ts", "Extra/telemetry-viewer/server/src/domain.ts"]
    },
    {
      title: "Add an aggregate mode or field",
      steps: [
        "Start from canonical keys and structure versioning, not from raw node ids.",
        "Define the no-double-count invariant for the new mode and encode it in a test.",
        "Expose the mode through aggregateQuery.ts and render its hidden/unmatched accounting.",
        "Keep CSV and JSON selection identical."
      ],
      files: ["Extra/telemetry-viewer/server/src/core/heatmap.ts", "Extra/telemetry-viewer/server/src/core/versioning.ts", "Extra/telemetry-viewer/server/src/api/aggregateQuery.ts", "Extra/telemetry-viewer/web/src/views/aggregate.ts"]
    },
    {
      title: "Change a telemetry default",
      steps: [
        "Change TelemetryConfig.cs, not a call site default.",
        "Update the docs config table and any compose/server env default that must match.",
        "Check the mutation/capture tests and the local viewer smoke path.",
        "If the change affects the wire or file format, it needs an ADR and a migration plan."
      ],
      files: ["Assets/Runtime/Telemetry/TelemetryConfig.cs", "docs/telemetry/data.reference.js", "Extra/Infrastructure/docker-compose.yml", "ADRs/README.md"]
    },
    {
      title: "Change the snapshot format",
      steps: [
        "Write the ADR first; 0007/0008/0009 are explicitly one migration, not three.",
        "Update the writer, server parser, shared normalize/renderer, and fixtures in the same change.",
        "Keep the old format readable until the backlog ages out; document the degradation path.",
        "Verify chain materialization from the store alone and the theme-manifest reference path."
      ],
      files: ["Assets/Runtime/Telemetry/Snapshot/UISnapshotBinaryWriter.cs", "Extra/telemetry-viewer/server/src/snapshots/parse.ts", "Extra/telemetry-viewer/packages/snapshot-render/src/normalize.ts", "ADRs/README.md"]
    }
  ];
})();
