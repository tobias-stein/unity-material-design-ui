/* Telemetry architecture — illustrative timelines.
 *
 * Durations are representative, not measurements. Config-backed values are
 * called out in `note`/`detail`; the real defaults live in TelemetryConfig.cs.
 */
(function () {
  "use strict";
  var doc = window.TELEMETRY_DOC;

  function item(lane, start, dur, label, kind, detail, components) {
    return {
      id: lane + "-" + start + "-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      lane: lane,
      start: start,
      dur: dur,
      label: label,
      kind: kind || "work",
      detail: detail || "",
      components: components || []
    };
  }

  doc.timelines = {
    capture: {
      title: "Inside one capture",
      kicker: "Capture pipeline",
      description: "The main thread decides and walks; serialization and the file write move to the thread pool. Event delivery is a separate cadence.",
      lanes: [
        { id: "main", label: "main thread" },
        { id: "pool", label: "thread pool" },
        { id: "disk", label: "disk" },
        { id: "net", label: "network" }
      ],
      variants: [
        {
          id: "transition",
          label: "View transition",
          note: "A view opens; settle absorbs population, then the first capture becomes the cycle anchor.",
          domain: [0, 1700],
          items: [
            item("main", 0, 0, "onViewActivated", "event", "The lifecycle raise starts the capture clock. No work happens until settle finishes.", ["viewmanager", "snapshottriggers"]),
            item("main", 0, 500, "settle 500 ms (config)", "wait", "viewTransitionSettle waits for the view to populate. A close inside this window captures nothing.", ["snapshottriggers"]),
            item("main", 500, 8, "gate + build / walk", "work", "The layout gate decides whether to force; the builder walks the live tree into UISnapshot.", ["layoutgate", "builder", "timing"]),
            item("main", 508, 1, "fingerprint", "work", "A structural fingerprint is computed for the cycle's dedupe state.", ["builder", "snapshottriggers"]),
            item("main", 509, 1, "prepareWrite", "work", "Main thread resolves the path, format, and theme mode; the heavy work moves off-thread.", ["exporter"]),
            item("pool", 510, 4, "serialize MDS v3", "work", "UISnapshotBinaryWriter emits the anchor bytes. The theme is registered before the file references it.", ["binarywriter", "thememanifest"]),
            item("pool", 514, 1, "encode + SHA-256", "work", "The hash is computed over the exact bytes that will land on disk.", ["exporter"]),
            item("pool", 515, 1, "write file", "io", "The file write happens on the pool. No main-thread hitch.", ["exporter", "snapshotfiles"]),
            item("disk", 517, 1, "prune", "io", "Retention runs newest-survives after the write.", ["retention"]),
            item("main", 518, 0, "ledger point", "event", "Only now does EventCollector receive snapshotTaken. A failed write would have skipped this.", ["exporter", "eventcollector"]),
            item("main", 518, 1000, "outbox batch window", "wait", "eventFlushInterval = 1 s, or 64 events, whichever comes first.", ["outbox"]),
            item("disk", 1518, 1, "persist pending-*.lp", "io", "The batch is written to disk before the first POST.", ["outbox", "pending"]),
            item("net", 1519, 20, "POST /api/v2/write", "net", "Line protocol with precision=ns. One request in flight.", ["influxdb"]),
            item("net", 1539, 0, "2xx ack", "ok", "Only an acknowledged file is deleted.", ["outbox"]),
            item("disk", 1539, 0, "delete pending file", "io", "The outbox drops the file after the acknowledgement.", ["pending"])
          ]
        },
        {
          id: "mutation",
          label: "Mutation burst",
          note: "A structural change coalesces through a 250 ms debounce, then becomes a sparse delta.",
          domain: [0, 1500],
          items: [
            item("main", 0, 0, "element created", "event", "A burst may raise many creation/removal hooks; only the settled result is captured.", ["uiinteractions", "snapshottriggers"]),
            item("main", 0, 250, "debounce 250 ms (config)", "wait", "Every new mutation refreshes the window. The burst is coalesced into one capture.", ["snapshottriggers"]),
            item("main", 250, 5, "build / walk", "work", "The builder walks the settled tree and records the post-mutation state.", ["builder", "layoutgate"]),
            item("main", 255, 1, "fingerprint", "work", "If this equals the last exported fingerprint, the capture stops here.", ["builder", "snapshottriggers"]),
            item("main", 256, 2, "delta vs materialized", "work", "Removed ids, added nodes, and changed nodes against the last chain member.", ["delta"]),
            item("pool", 258, 1, "serialize sparse delta", "work", "The delta carries baseHash and bases[] so a store-only consumer can materialize it.", ["binarywriter"]),
            item("pool", 259, 1, "write member", "io", "The chain state commits only after this write succeeds.", ["exporter", "snapshotfiles"]),
            item("main", 260, 0, "ledger point", "event", "The ledger records the delta mode and base; the hash identifies the bytes.", ["eventcollector"]),
            item("main", 260, 1000, "outbox batch window", "wait", "Event delivery does not block the capture.", ["outbox"]),
            item("disk", 1260, 1, "persist pending-*.lp", "io", "Write-ahead before delivery.", ["pending"]),
            item("net", 1261, 20, "POST + ack", "net", "On success the pending file is deleted.", ["influxdb"])
          ]
        },
        {
          id: "dedupe",
          label: "Dedupe · no export",
          note: "A mutation capture that produces no structural change writes no file, no ledger point, and no timing line.",
          domain: [0, 650],
          items: [
            item("main", 0, 0, "mutation raise", "event", "The debounce starts again.", ["uiinteractions", "snapshottriggers"]),
            item("main", 0, 250, "debounce", "wait", "Mutation captures wait for the burst to settle.", ["snapshottriggers"]),
            item("main", 250, 6, "build / walk", "work", "The capture still walks: the whole point is to find out whether anything changed.", ["builder"]),
            item("main", 256, 1, "fingerprint", "work", "Structural identity, independent of transient object references.", ["builder"]),
            item("main", 257, 0, "fingerprint equal", "skip", "Same content as the last exported capture of this cycle.", ["snapshottriggers"]),
            item("main", 257, 250, "no export · no ledger · no timing", "skip", "The capture is intentionally dropped. This is dedupe, not pacing: pacing would have queued it.", ["snapshottriggers", "exporter"])
          ]
        },
        {
          id: "hotkey",
          label: "F9 manual capture",
          note: "The developer hotkey bypasses settle and debounce; it is a deliberate immediate capture.",
          domain: [0, 1200],
          items: [
            item("main", 0, 0, "F9", "event", "hotkeyEnabled + hotkeyDevOnly; no capture in a player build unless explicitly configured.", ["snapshottriggers"]),
            item("main", 0, 7, "build / walk", "work", "Manual capture skips the settle window.", ["builder"]),
            item("main", 7, 1, "prepareWrite", "work", "Same export pipeline as automated captures.", ["exporter"]),
            item("pool", 8, 3, "serialize", "work", "Anchor or delta depends on the current chain state.", ["binarywriter"]),
            item("pool", 11, 1, "encode + hash", "work", "Exact-byte hash.", ["exporter"]),
            item("pool", 12, 1, "write", "io", "File lands before the ledger point.", ["snapshotfiles"]),
            item("disk", 14, 1, "prune", "io", "Retention still applies.", ["retention"]),
            item("main", 15, 0, "ledger point", "event", "source=manual can be attached for later filtering.", ["eventcollector"]),
            item("main", 15, 1000, "outbox batch window", "wait", "Then the normal delivery cadence resumes.", ["outbox"]),
            item("disk", 1015, 1, "persist pending", "io", "Write-ahead.", ["pending"]),
            item("net", 1016, 20, "POST + ack", "net", "Ack, then delete.", ["influxdb"])
          ]
        }
      ]
    },

    view: {
      title: "A view's lifetime",
      kicker: "View lifecycle",
      description: "Interaction points, mutation captures, and the final close all hang off one span. The span is the unit of replay.",
      lanes: [
        { id: "view", label: "main view" },
        { id: "popup", label: "popup layer" },
        { id: "captures", label: "captures" },
        { id: "events", label: "ui_event" }
      ],
      variants: [
        {
          id: "cycle",
          label: "Main view cycle",
          note: "One opening anchor, then mutation deltas. Dedupe is cycle-scoped, so reopening later always captures again.",
          domain: [0, 9000],
          items: [
            item("view", 0, 8000, "visible span", "work", "view_open at 0, view_close at 8.0 s. Dwell is computed from this pair.", ["viewmanager", "eventcollector"]),
            item("view", 0, 0, "view_open", "event", "The view is now the active main view.", ["eventcollector"]),
            item("captures", 500, 0, "opening anchor", "event", "Settle completes; the first capture starts the cycle chain.", ["snapshottriggers", "exporter"]),
            item("events", 1500, 0, "click", "event", "The interaction is correlated to the latest snapshot of this view at or before t.", ["uiinteractions", "timeline"]),
            item("events", 2600, 0, "toggle", "event", "A second interaction with no capture in between resolves to the same anchor.", ["uiinteractions", "timeline"]),
            item("events", 3800, 250, "mutation burst", "wait", "Creation/removal hooks coalesce for mutationDebounce.", ["uiinteractions", "snapshottriggers"]),
            item("captures", 4050, 0, "mutation delta", "event", "One sparse delta against the anchor.", ["delta", "exporter"]),
            item("events", 5200, 0, "click", "event", "Resolves to the latest capture at or before 5.2 s.", ["uiinteractions", "timeline"]),
            item("events", 6200, 250, "mutation burst", "wait", "A second settled burst in the same cycle.", ["snapshottriggers"]),
            item("captures", 6450, 0, "mutation delta", "event", "The chain now has two members beyond the anchor.", ["delta"]),
            item("view", 8000, 0, "view_close", "event", "Dwell 8.0 s. The chain state for this view is retired; a reopen starts a new anchor.", ["eventcollector"])
          ]
        },
        {
          id: "popup",
          label: "Popup over a view",
          note: "A Dialog or Snackbar keeps its own span and captures on the POPUP canvas layer; the main view stays top-of-stack.",
          domain: [0, 5600],
          items: [
            item("view", 0, 5600, "main view span", "work", "The host view stays visible underneath.", ["viewmanager"]),
            item("view", 0, 0, "main view_open", "event", "The main view is still top-of-stack.", ["eventcollector"]),
            item("captures", 500, 0, "main opening anchor", "event", "The underlying view is captured after its settle.", ["exporter"]),
            item("popup", 1000, 2200, "popup span", "work", "Popup visibility is tracked separately when popupTrackingEnabled.", ["eventcollector"]),
            item("popup", 1000, 0, "popup view_open", "event", "Tooltip is excluded by default via popupExcludedViews.", ["viewmanager", "eventcollector"]),
            item("captures", 1000, 0, "popup opening anchor", "event", "The popup gets its own capture chain.", ["exporter"]),
            item("events", 1500, 0, "click inside popup", "event", "Owner resolution walks to the innermost open popup containing the element.", ["eventcollector"]),
            item("events", 1700, 250, "mutation burst", "wait", "The popup's own debounce window.", ["snapshottriggers"]),
            item("captures", 1950, 0, "popup delta", "event", "Captured on the POPUP layer; the composite stacks it above the main view.", ["delta", "replica"]),
            item("popup", 3200, 0, "popup view_close", "event", "Dwell is measured on the popup span.", ["eventcollector"]),
            item("view", 5600, 0, "main view_close", "event", "The main span closes independently.", ["eventcollector"])
          ]
        }
      ]
    },

    delivery: {
      title: "Event delivery",
      kicker: "Outbox & retry",
      description: "Events are persisted before they are sent. The only question is how long they wait on disk.",
      lanes: [
        { id: "buffer", label: "in-memory batch" },
        { id: "disk", label: "disk" },
        { id: "http", label: "HTTP" },
        { id: "state", label: "outbox state" }
      ],
      variants: [
        {
          id: "online",
          label: "Online",
          note: "Happy path: 1 s / 64-event batches, write-ahead, POST, delete on 2xx. No gap in the ledger.",
          domain: [0, 4200],
          items: [
            item("buffer", 0, 1000, "batch 1", "wait", "eventFlushCount = 64, eventFlushInterval = 1 s.", ["outbox"]),
            item("disk", 1000, 1, "persist batch 1", "io", "pending-<ts>-<seq>.lp is on disk before the first request.", ["pending"]),
            item("http", 1001, 20, "POST batch 1", "net", "precision=ns, one request in flight.", ["influxdb"]),
            item("state", 1021, 0, "ack · delete", "ok", "The file is removed only after a 2xx.", ["outbox"]),
            item("buffer", 1021, 1000, "batch 2", "wait", "New events accumulate while the previous batch is in flight/settling.", ["outbox"]),
            item("disk", 2021, 1, "persist batch 2", "io", "Write-ahead again.", ["pending"]),
            item("http", 2022, 20, "POST batch 2", "net", "Same contract.", ["influxdb"]),
            item("state", 2042, 0, "ack · delete", "ok", "Queue drained to zero.", ["outbox"]),
            item("buffer", 2042, 1000, "batch 3", "wait", "The cadence continues independently of captures.", ["outbox"]),
            item("disk", 3042, 1, "persist batch 3", "io", "Write-ahead.", ["pending"]),
            item("http", 3043, 20, "POST batch 3", "net", "Line protocol.", ["influxdb"]),
            item("state", 3063, 0, "ack · delete", "ok", "Nothing left on disk.", ["outbox"])
          ]
        },
        {
          id: "offline",
          label: "Offline",
          note: "Failures keep the file. Backoff starts at 1 s, doubles to a 60 s cap, and coalesces a backlog into bounded requests.",
          domain: [0, 68000],
          items: [
            item("buffer", 0, 1000, "first batch", "wait", "The first flush window is normal.", ["outbox"]),
            item("disk", 1000, 1, "persist pending", "io", "The file is now the durable queue.", ["pending"]),
            item("http", 1001, 20, "attempt 1 · fail", "error", "Connection refused / 5xx / timeout.", ["influxdb"]),
            item("state", 1021, 1000, "backoff 1 s", "wait", "The first retry delay is the flush interval.", ["outbox"]),
            item("http", 2021, 20, "attempt 2 · fail", "error", "The pending file stays in place.", ["influxdb"]),
            item("state", 2041, 2000, "backoff 2 s", "wait", "Exponential backoff, capped at 60 s.", ["outbox"]),
            item("http", 4041, 20, "attempt 3 · fail", "error", "No data is lost.", ["influxdb"]),
            item("state", 4061, 4000, "backoff 4 s", "wait", "Meanwhile new events keep appending to new pending files.", ["outbox"]),
            item("http", 8061, 20, "attempt 4 · fail", "error", "The queue grows by file, not by rewriting the head.", ["influxdb"]),
            item("state", 8081, 8000, "backoff 8 s", "wait", "Still one request in flight.", ["outbox"]),
            item("http", 16081, 20, "attempt 5 · fail", "error", "A failed head remains first in line.", ["influxdb"]),
            item("state", 16101, 16000, "backoff 16 s", "wait", "The viewer can read these same files today.", ["outbox", "lpprovider"]),
            item("http", 32101, 20, "attempt 6 · fail", "error", "Backoff is now at the cap.", ["influxdb"]),
            item("state", 32121, 31879, "backoff 32 s → 60 s cap", "wait", "The cap prevents unbounded waits; recovery is still attempted.", ["outbox"]),
            item("disk", 1001, 63000, "pending-*.lp backlog", "wait", "At-least-once replay is idempotent because identical series overwrite.", ["pending"]),
            item("state", 64000, 20, "coalesce 16 files / 512 KB", "work", "pendingCoalesce and pendingCoalesceMaxBytes bound the request body.", ["outbox"]),
            item("http", 64020, 20, "recovery POST", "net", "InfluxDB is back; the coalesced body is accepted.", ["influxdb"]),
            item("state", 64040, 0, "ack · drain", "ok", "Acknowledged pending files are deleted.", ["outbox"]),
            item("disk", 64040, 0, "delete acknowledged files", "io", "The backlog shrinks file by file.", ["pending"])
          ]
        },
        {
          id: "restart",
          label: "Restart recovery",
          note: "An old backlog is recovered by scanning the events directory at startup; nothing is sent twice on purpose.",
          domain: [0, 2600],
          items: [
            item("disk", 0, 5, "scan pending-*.lp", "io", "Startup builds the queue from the disk, sorted by file name.", ["outbox", "eventstore"]),
            item("buffer", 0, 1000, "new in-memory batch", "wait", "Fresh events use the normal cadence.", ["outbox"]),
            item("state", 5, 10, "load queue", "work", "The oldest pending head is first; one request in flight.", ["outbox"]),
            item("disk", 15, 1, "coalesce backlog", "io", "Old files are combined under the size/count caps.", ["pending"]),
            item("http", 16, 20, "retry old head", "net", "No distinction between a fresh and recovered file.", ["influxdb"]),
            item("state", 36, 0, "ack · delete", "ok", "Recovered files leave the queue.", ["outbox"]),
            item("disk", 36, 0, "next file", "io", "The scan/queue loop continues until empty.", ["pending"])
          ]
        }
      ]
    },

    viewer: {
      title: "A viewer request",
      kicker: "Read path",
      description: "The server builds a read model from providers; the browser fetches only the slices it needs. Snapshot bytes are a second request.",
      lanes: [
        { id: "client", label: "browser" },
        { id: "server", label: "server" },
        { id: "store", label: "snapshot store" }
      ],
      variants: [
        {
          id: "miss",
          label: "Cold cache",
          note: "Catalog and snapshot caches are empty. The timeline arrives first; the snapshot is resolved and materialized after the playhead settles.",
          domain: [0, 260],
          items: [
            item("client", 0, 1, "GET /timeline", "net", "The timeline view requests the session frame.", ["timelineview", "api"]),
            item("server", 1, 15, "catalog cache miss", "work", "AGGREGATE_CACHE_MS / catalog cache miss; providers are queried.", ["catalog"]),
            item("server", 16, 80, "provider describe + fetch", "io", "LP files first, InfluxDB last. Slow providers do not block the others.", ["lpprovider", "influxprovider"]),
            item("server", 96, 8, "union + wire dedupe", "work", "Sessions present in several providers are merged, exact duplicate points collapsed.", ["catalog"]),
            item("server", 104, 6, "project sessions", "work", "Session bounds, spans, counts, and ledger entries; no snapshot parsing.", ["projection"]),
            item("server", 110, 7, "build timeline frame", "work", "Every ui_event is ordered; latest snapshot ≤ t is correlated per span.", ["timeline"]),
            item("client", 117, 18, "draw tracks", "work", "Marble events, density bars, and span rows are drawn. Filmstrips load lazily.", ["timelineview"]),
            item("client", 135, 1, "GET /snapshots/…?near=", "net", "The replica asks for the nearest anchor at the playhead.", ["timelineview", "api"]),
            item("server", 136, 5, "resolve ledger entry", "work", "Hash first, then storage key as a hint.", ["snapshotservice"]),
            item("store", 141, 25, "resolve key / hash", "io", "Probe the root, find the file, read bytes.", ["snapshotstore", "snapshotfiles"]),
            item("store", 166, 5, "decode MDS v3", "work", "Magic sniff and binary decode.", ["parse"]),
            item("store", 171, 10, "materialize delta chain", "work", "The chain is walked from the store alone; no ledger needed.", ["snapshotservice"]),
            item("store", 181, 3, "resolve theme manifest", "work", "Theme refs are resolved; a missing manifest degrades with a warning.", ["manifestfile", "snapshotservice"]),
            item("server", 184, 5, "parse + normalize", "work", "Shared normalization, geometry warning, and DTO assembly.", ["parse", "render"]),
            item("client", 189, 25, "composite replica", "work", "Every span covering t is stacked bottom-to-top by canvas layer.", ["replica"]),
            item("client", 214, 16, "paint replica", "work", "DOM nodes and minimap blocks are updated in one pass.", ["render", "filmstrip"])
          ]
        },
        {
          id: "hit",
          label: "Warm cache",
          note: "Catalog and parsed-snapshot LRU hits remove most server work. The timeline still redraws because the playhead moved.",
          domain: [0, 80],
          items: [
            item("client", 0, 1, "GET /timeline", "net", "Same route, cached catalog.", ["timelineview"]),
            item("server", 1, 2, "catalog cache hit", "ok", "Catalog cache is fresh; providers are not re-queried.", ["catalog"]),
            item("server", 3, 6, "build timeline frame", "work", "Frame assembly is cheap but not cached across playhead moves.", ["timeline"]),
            item("client", 9, 15, "draw tracks", "work", "Canvas redraw.", ["timelineview"]),
            item("client", 24, 1, "GET /snapshots/…?near=", "net", "Second request.", ["api"]),
            item("store", 25, 2, "parsed LRU hit", "ok", "The decoded/normalized snapshot is reused.", ["snapshotservice"]),
            item("client", 27, 15, "composite replica", "work", "Layer resolution and DOM patch.", ["replica"]),
            item("client", 42, 15, "paint", "work", "No disk or InfluxDB round trip.", ["render"])
          ]
        },
        {
          id: "degraded",
          label: "Missing artifact",
          note: "The viewer reports exactly what is missing. It never fabricates a blank UI as if it were a real capture.",
          domain: [0, 130],
          items: [
            item("client", 0, 1, "GET /snapshots/…", "net", "The ledger entry points at a pruned or missing file.", ["timelineview"]),
            item("server", 1, 19, "resolve entry", "work", "Hash lookup misses; the storage-key hint also misses.", ["snapshotservice"]),
            item("store", 20, 20, "store miss", "error", "The store distinguishes unconfigured root, unreachable root, and missing artifact.", ["snapshotstore"]),
            item("server", 40, 1, "404 SNAPSHOT_ARTIFACT_MISSING", "error", "A coded error, not an empty 200.", ["api"]),
            item("client", 41, 2, "warn chip", "skip", "The clip and interaction are still shown; the replica says why it cannot render.", ["timelineview"]),
            item("client", 43, 7, "honest empty state", "skip", "No invented UI, no silent fallback.", ["replica"]),
            item("client", 50, 70, "session remains navigable", "wait", "Other spans and artifacts still work.", ["timelineview"])
          ]
        }
      ]
    }
  };

  doc.timelineOrder = ["capture", "view", "delivery", "viewer"];
})();
