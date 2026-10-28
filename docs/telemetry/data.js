/*
 * Telemetry architecture documentation — core content.
 *
 * The docs are deliberately build-free: each data.*.js file attaches one slice
 * to window.TELEMETRY_DOC, doc.js renders it, and check-links.mjs validates
 * every cited file/symbol/route against the repository.
 */
(function () {
  "use strict";

  window.TELEMETRY_DOC = {
    meta: {
      title: "Telemetry architecture",
      subtitle: "From a UI raise to a replay pixel — the Unity runtime, the storage contract, and the read-only viewer.",
      verified: "2026-10-27",
      commit: "working tree",
      repo: "Unity-MaterialDesign-UI"
    },

    planes: [
      {
        id: "runtime",
        label: "Unity runtime",
        short: "Raise",
        color: "runtime",
        caption: "Signals, session state, view spans",
        x: 20,
        w: 300
      },
      {
        id: "capture",
        label: "Capture & encode",
        short: "Capture",
        color: "capture",
        caption: "Debounce, walk, diff, serialize",
        x: 340,
        w: 350
      },
      {
        id: "transport",
        label: "Deliver & store",
        short: "Store",
        color: "transport",
        caption: "Line protocol, outbox, files, InfluxDB",
        x: 700,
        w: 340
      },
      {
        id: "server",
        label: "Viewer server",
        short: "Read",
        color: "server",
        caption: "Sources, catalog, read models, snapshots",
        x: 1050,
        w: 340
      },
      {
        id: "browser",
        label: "Browser",
        short: "Render",
        color: "browser",
        caption: "SPA views, replays, heatmaps",
        x: 1400,
        w: 240
      }
    ],

    mechanics: [
      {
        id: "session",
        kicker: "01 · correlation root",
        title: "A session id ties every point together",
        body: "Telemetry generates a 32-character session id at bootstrap (and on Telemetry.newSession). Every ui_event, session boundary, and ui_snapshot_taken ledger point carries it; snapshot app info carries it too. That is the only join the viewer needs before it starts reconstructing a timeline.",
        node: "telemetry",
        tags: ["session", "ui_event", "ui_snapshot_taken"]
      },
      {
        id: "span",
        kicker: "02 · the timeline clip",
        title: "Views open and close spans",
        body: "UIInteractions raises show/end once per visible cycle. EventCollector pairs them into view_open/view_close points with dwell seconds and a canvas layer, so popups get their own track. A close raised by an interaction dedupes against the lifecycle raise — exactly one span per cycle.",
        node: "eventcollector",
        tags: ["view_open", "view_close", "dwell", "POPUP"]
      },
      {
        id: "ledger",
        kicker: "03 · file + point",
        title: "A snapshot is a file joined by SHA-256",
        body: "The exporter writes the snapshot first, then emits one ui_snapshot_taken ledger point. The point's hash is the authoritative join key; the storage key (snapshots/yyyy/mm/dd/name) is only a lookup hint. A failed write emits no ledger point, so a recorded point always has bytes on disk.",
        node: "exporter",
        tags: ["hash", "storageKey", "ledger after write"]
      },
      {
        id: "format",
        kicker: "04 · storage shape",
        title: "Anchors capture, deltas describe change",
        body: "A visibility cycle starts with an anchor (full tree). Later mutation captures can be sparse deltas against the previous exported member; the file carries its ancestor hashes so the viewer can materialize the tree without the ledger. The session theme manifest replaces repeated theme blocks by reference.",
        node: "delta",
        tags: ["MDS v3", "anchor", "delta", "theme manifest"]
      },
      {
        id: "outbox",
        kicker: "05 · delivery",
        title: "Persist before you send",
        body: "The InfluxDB sink batches events, writes pending-*.lp to disk before the first POST, and deletes a file only after a 2xx acknowledgement. Failures back off to 60 s; a startup scan recovers an old backlog; delivery coalesces up to 16 files or 512 KB per request.",
        node: "outbox",
        tags: ["pending-*.lp", "at-least-once", "backoff", "coalesce"]
      },
      {
        id: "read-models",
        kicker: "06 · reading it back",
        title: "The viewer never trusts a single source",
        body: "Sources normalize to RawEvent, the catalog unions providers per session and collapses wire-exact duplicates, and projection builds Session objects without parsing a snapshot. Timeline, replay, and aggregate are separate read models over that one stream — all using the same latest-snapshot-at-or-before rule.",
        node: "catalog",
        tags: ["RawEvent", "union", "projection", "latest ≤ t"]
      }
    ],

    scenarios: [
      {
        id: "live",
        label: "Live · InfluxDB up",
        short: "Live",
        accent: "ok",
        description: "Default path. Events leave pending-*.lp as soon as InfluxDB acknowledges the write. Snapshots stay in the local snapshot directory; the viewer can read either side.",
        timeline: { tab: "delivery", variant: "online" }
      },
      {
        id: "offline",
        label: "InfluxDB offline",
        short: "Offline",
        accent: "warn",
        description: "The write fails, the batch stays in pending-*.lp, and retries back off (1 s → 60 s). The viewer can still read the pending and archive files; when InfluxDB returns, coalesced delivery drains the queue.",
        timeline: { tab: "delivery", variant: "offline" }
      },
      {
        id: "archive",
        label: "File-archive mode",
        short: "Archive",
        accent: "info",
        description: "influxEnabled=false. EventCollector routes points to FileEventSink, which appends one session-<id>.lp file. The viewer's lp-files source is the primary ingress.",
        timeline: { tab: "delivery", variant: "online" }
      },
      {
        id: "delta",
        label: "Anchor + delta cycle",
        short: "Delta",
        accent: "capture",
        description: "Binary format. The first capture of a view cycle is an anchor; mutation captures become sparse delta members. The server materializes the chain from the store, then resolves the session theme manifest.",
        timeline: { tab: "capture", variant: "mutation" }
      },
      {
        id: "viewer-files",
        label: "Viewer · files only",
        short: "Files only",
        accent: "server",
        description: "The viewer runs without a reachable InfluxDB: LP files build the catalog and the snapshot store resolves artifacts by hash. Missing roots are reported honestly as degraded, not as an empty universe.",
        timeline: { tab: "viewer", variant: "miss" }
      },
      {
        id: "imported",
        label: "Imported .lp universe",
        short: "Imported",
        accent: "browser",
        description: "Uploaded .lp files define a temporary in-memory universe. Auto-scan and InfluxDB are bypassed, never merged. Re-scan is refused while the universe is active because the imported files do not change on disk.",
        timeline: { tab: "viewer", variant: "miss" }
      }
    ],

    flow: [
      {
        title: "A UI signal is raised",
        kicker: "01 · runtime",
        short: "Interaction or lifecycle signal",
        detail: "A component calls UIInteractions.click/toggle/close/backdropClick. UIView.show/hide raises onViewShown/onViewEnded, and UI element creation/removal raises the mutation hooks. UIInteractions knows nothing about telemetry: with no listener every raise is a no-op, and subscriber exceptions are contained.",
        payload: "UIInteraction / IView / IUI",
        branch: "No listener → no-op. A subscriber exception never breaks element creation.",
        components: ["uiinteractions", "viewmanager"],
        timeline: { tab: "view", variant: "cycle" }
      },
      {
        title: "EventCollector makes a point",
        kicker: "02 · correlate",
        short: "Session + view attribution",
        detail: "EventCollector resolves the owning view (the view itself, the innermost open popup containing the element, or the top-of-stack fallback), advances the open/close span bookkeeping, and builds a TelemetryEvent with the session id. Snapshot ledger points enter here too, after the exporter's write returns.",
        payload: "TelemetryEvent (measurement, tags, fields, ns)",
        branch: "Close without an open span is ignored; a lost close is implicitly closed by the next open of the same view identity.",
        components: ["eventcollector", "viewmanager"],
        timeline: { tab: "view", variant: "cycle" }
      },
      {
        title: "A capture trigger fires",
        kicker: "03 · decide",
        short: "Settle, debounce, pace, dedupe",
        detail: "View transitions wait viewTransitionSettle (default 500 ms) so a view can populate. Mutations refresh a per-view debounce window (250 ms) and coalesce a burst. Captures pace at viewTransitionMinInterval (1 s) by waiting in a deferred queue, never by dropping. Near-simultaneous duplicate raises of the same view are suppressed within 100 ms.",
        payload: "DeferredCapture / PendingMutation",
        branch: "A view that closes inside the settle or debounce window captures nothing for that cycle; its lifecycle events are still recorded.",
        components: ["snapshottriggers", "layoutgate"],
        timeline: { tab: "capture", variant: "transition" }
      },
      {
        title: "The tree is walked",
        kicker: "04 · capture",
        short: "UISnapshotBuilder",
        detail: "The builder force-rebuilds layout only when the dirt gate says it must, skips pooled subtrees (skipPooled), walks the live hierarchy, records root-relative and local rects, layout data, resolved colors/text, and a per-node error marker. The result is a plain UISnapshot POCO with a deterministic fingerprint.",
        payload: "UISnapshot → nodes[], theme, app, view, source",
        branch: "A broken node is marked, not allowed to abort the walk. A gated capture that violates geometry arms a one-force recovery latch.",
        components: ["builder", "layoutgate", "timing"],
        timeline: { tab: "capture", variant: "transition" }
      },
      {
        title: "Dedupe, then diff",
        kicker: "05 · change detection",
        short: "Fingerprint and delta",
        detail: "Mutation captures compare a structural fingerprint with the last exported tree of the same cycle. Equal → no export, no ledger, no timing line. Otherwise, if binary format and a chain exists, UISnapshotDeltaBuilder emits removed/added/changed nodes against the last materialized member; the delta carries its base and ancestor hashes.",
        payload: "SnapshotDelta (removedIds, added, changed, bases)",
        branch: "No anchor in the cycle → this capture becomes the anchor. Dedupe is cycle-scoped by design, so pooled views always capture again on reopen.",
        components: ["snapshottriggers", "delta", "builder"],
        timeline: { tab: "capture", variant: "dedupe" }
      },
      {
        title: "Write the file",
        kicker: "06 · encode",
        short: "Exporter, theme manifest, MDS",
        detail: "prepareWrite resolves the output directory and path on the main thread, registers the theme in the session manifest, then moves serialization to the thread pool. Binary writes MDS v3 anchor/delta bytes; the YAML escape hatch still supports gzip. SHA-256 is computed over the exact bytes, retention runs, and the result returns to the main thread.",
        payload: ".mds / .yaml[.gz] + sha256",
        branch: "A write failure returns null and emits no ledger point. The mutation fingerprint is rolled back so identical content is not lost to a later dedupe.",
        components: ["exporter", "binarywriter", "thememanifest", "timing"],
        timeline: { tab: "capture", variant: "transition" }
      },
      {
        title: "Emit the ledger point",
        kicker: "07 · join",
        short: "ui_snapshot_taken",
        detail: "Only after the write succeeded does the exporter call EventCollector.snapshotTaken. The point carries session/view tags and fields for key, hash, nodes, screen, owner/platform, source, mode, theme, base, and anchor. Tags stay bounded; identifying payload stays in fields.",
        payload: "ui_snapshot_taken,session=… key=…,hash=…,nodes=…",
        branch: "snapshotLedger=false or eventsEnabled=false → no ledger point; the snapshot file still exists.",
        components: ["exporter", "eventcollector", "lpserializer"],
        timeline: { tab: "capture", variant: "transition" }
      },
      {
        title: "Deliver or archive",
        kicker: "08 · transport",
        short: "Outbox / session file",
        detail: "The active sink is chosen per write: InfluxOutboxSink when influxEnabled, otherwise FileEventSink. The outbox batches by count (64) or age (1 s), persists pending-*.lp before sending, POSTs line protocol with precision=ns, and deletes the file only on 2xx. Archive mode appends to session-<id>.lp.",
        payload: "line protocol → pending-*.lp / session-<id>.lp",
        branch: "Failures stay on disk and retry; an old backlog is scanned at startup. At-least-once replay is idempotent because identical series overwrite.",
        components: ["outbox", "filesink", "pending", "archive", "influxdb"],
        timeline: { tab: "delivery", variant: "offline" }
      },
      {
        title: "Normalize sources",
        kicker: "09 · ingest",
        short: "LP files, InfluxDB, imports",
        detail: "The viewer's providers return RawEvent objects: measurement, nanosecond timestamp, tags, fields. The LP parser is canonical for nanosecond truth; the Influx CSV parser handles OSS and annotated CSV. Imported files replace the universe rather than merging with it.",
        payload: "RawEvent[] + malformedCount + structured error",
        branch: "A malformed line is counted; a failed provider returns a SourceError and the catalog degrades per source instead of failing the whole request.",
        components: ["sourceruntime", "lpprovider", "influxprovider", "importedprovider"],
        timeline: { tab: "viewer", variant: "miss" }
      },
      {
        title: "Union and project",
        kicker: "10 · read model",
        short: "SessionCatalog → Session",
        detail: "Providers are queried in priority order (files first, Influx last). Sessions present in several providers are unioned, not first-wins, so a pending tail cannot hide a complete Influx ledger. Wire-exact duplicates collapse on measurement + timestamp + full tag set + key. projectSessions builds spans, counts, snapshots, and owner metadata without opening a snapshot.",
        payload: "Session[] + unioned sessionEvents",
        branch: "No source available → 503 NO_SOURCE_AVAILABLE. One degraded source still serves the rest.",
        components: ["catalog", "projection"],
        timeline: { tab: "viewer", variant: "miss" }
      },
      {
        title: "Build the timeline / aggregate",
        kicker: "11 · derive",
        short: "TimelineFrame, ParsedSnapshot, heatmap",
        detail: "The timeline frame orders every ui_event, packs view spans into NLE rows, and attaches the latest snapshot anchor of the same view at or before each interaction. Snapshot requests resolve by index, hash, or near-time, then decode/parse/materialize deltas and resolve the theme manifest. Aggregate joins canonical element keys and slices structure versions.",
        payload: "TimelineFrame / ParsedSnapshot / AggregateResult",
        branch: "Unresolved interactions are never dropped; they ride the unresolved lane. A missing artifact is an honest 404/warning, not a silent wrong replay.",
        components: ["timeline", "snapshotservice", "snapshotstore", "parse", "aggregate"],
        timeline: { tab: "viewer", variant: "degraded" }
      },
      {
        title: "Render the pixels",
        kicker: "12 · browser",
        short: "SPA → shared renderer",
        detail: "The hash-routed SPA mounts sessions, timeline, or aggregate. The timeline draws tracks and marble events on canvas, fetches minimaps lazily, and composites every view covering the playhead bottom-to-top by canvas layer. @mdu/snapshot-render turns ParsedSnapshot into DOM, resolves theme roles, and draws replicas and filmstrips.",
        payload: "DOM replica, minimap bitmap, heat overlay",
        branch: "A capture with a geometry warning gets a warn chip. A broken chain or missing manifest degrades with a coded warning rather than inventing UI.",
        components: ["spa", "sessionsview", "timelineview", "aggregateview", "render", "replica", "filmstrip"],
        timeline: { tab: "viewer", variant: "miss" }
      }
    ]
  };
})();
