/* Telemetry architecture — the directed system graph. */
(function () {
  "use strict";
  var doc = window.TELEMETRY_DOC;

  var ALL = ["live", "offline", "archive", "delta", "viewer-files", "imported"];
  var RUNTIME = ["live", "offline", "archive", "delta"];
  var FILE_READ = ["live", "offline", "archive", "viewer-files"];

  function edge(from, to, label, scenarios, kind) {
    return { from: from, to: to, label: label, scenarios: scenarios, kind: kind || "data" };
  }

  doc.edges = [
    /* Unity runtime: signals and control. */
    edge("uiinteractions", "eventcollector", "interaction + lifecycle raises", RUNTIME, "control"),
    edge("uiinteractions", "snapshottriggers", "view + element raises", RUNTIME, "control"),
    edge("viewmanager", "uiinteractions", "show / end once per cycle", RUNTIME, "control"),
    edge("telemetry", "telemetryhost", "creates + ticks", RUNTIME, "control"),
    edge("telemetry", "eventcollector", "constructs", RUNTIME, "control"),
    edge("telemetry", "snapshottriggers", "constructs", RUNTIME, "control"),
    edge("telemetryhost", "eventcollector", "tick()", RUNTIME, "control"),
    edge("telemetryhost", "snapshottriggers", "tick()", RUNTIME, "control"),
    edge("uilayout", "snapshottriggers", "layout dirt signals", RUNTIME, "control"),
    edge("viewmanager", "snapshottriggers", "onViewActivated", RUNTIME, "control"),

    /* Capture pipeline. */
    edge("snapshottriggers", "builder", "capture root", RUNTIME, "control"),
    edge("snapshottriggers", "layoutgate", "shouldForce / verify", RUNTIME, "control"),
    edge("snapshottriggers", "delta", "open-cycle chain state", ["delta"], "data"),
    edge("snapshottriggers", "exporter", "buildAndExportAsync", RUNTIME, "control"),
    edge("builder", "exporter", "UISnapshot", RUNTIME, "data"),
    edge("delta", "exporter", "SnapshotDelta", ["delta"], "data"),
    edge("timing", "builder", "phase timings", RUNTIME, "data"),
    edge("timing", "exporter", "pool timings", RUNTIME, "data"),
    edge("exporter", "thememanifest", "register theme", RUNTIME, "data"),
    edge("exporter", "binarywriter", "serialize on pool", RUNTIME, "data"),
    edge("exporter", "snapshotfiles", "write bytes", RUNTIME, "write"),
    edge("exporter", "eventcollector", "ledger after write", RUNTIME, "data"),
    edge("thememanifest", "manifestfile", "writeIfDirty", RUNTIME, "write"),
    edge("eventcollector", "lpserializer", "TelemetryEvent", RUNTIME, "data"),
    edge("lpserializer", "outbox", "line protocol", ["live", "offline"], "data"),
    edge("lpserializer", "filesink", "line protocol", ["archive"], "data"),
    edge("exporter", "retention", "prune after write", RUNTIME, "control"),
    edge("eventcollector", "retention", "eventsMaxFiles", RUNTIME, "control"),

    /* Transport and storage. */
    edge("outbox", "eventstore", "resolve events dir", ["live", "offline"], "control"),
    edge("outbox", "pending", "persist before send", ["live", "offline"], "write"),
    edge("outbox", "influxdb", "POST /api/v2/write", ["live"], "http"),
    edge("pending", "influxdb", "retry + coalesce", ["offline"], "http"),
    edge("filesink", "archive", "append session file", ["archive"], "write"),
    edge("filesink", "eventstore", "resolve dir + prune", ["archive"], "control"),
    edge("eventstore", "pending", "pending-*.lp", ["live", "offline"], "data"),
    edge("eventstore", "archive", "session-*.lp", ["archive"], "data"),
    edge("retention", "snapshotfiles", "delete oldest", RUNTIME, "control"),
    edge("retention", "pending", "delete oldest", ["live", "offline"], "control"),
    edge("retention", "archive", "delete oldest", ["archive"], "control"),
    edge("pending", "lpprovider", "tail of the outbox", ["offline", "viewer-files"], "file"),
    edge("archive", "lpprovider", "read session-*.lp", ["offline", "archive", "viewer-files"], "file"),
    edge("influxdb", "influxprovider", "Flux query / CSV", ["live"], "http"),

    /* Viewer server read models. */
    edge("api", "sourceruntime", "providers()", ALL, "control"),
    edge("api", "catalog", "catalog()", ALL, "control"),
    edge("api", "timeline", "buildTimelineFrame", ALL, "control"),
    edge("api", "aggregate", "buildAggregate", ALL, "control"),
    edge("api", "snapshotservice", "resolve snapshot", ALL, "control"),
    edge("sourceruntime", "lpprovider", "LP_ROOT", FILE_READ, "control"),
    edge("sourceruntime", "influxprovider", "INFLUX_*", ["live"], "control"),
    edge("sourceruntime", "importedprovider", "imported universe", ["imported"], "control"),
    edge("catalog", "lpprovider", "describe + fetch", FILE_READ, "read"),
    edge("catalog", "influxprovider", "describe + fetch", ["live"], "read"),
    edge("catalog", "importedprovider", "describe + fetch", ["imported"], "read"),
    edge("catalog", "projection", "RawEvent[]", ALL, "data"),
    edge("catalog", "timeline", "Session + union events", ALL, "data"),
    edge("catalog", "aggregate", "selected sessions", ALL, "data"),
    edge("aggregate", "snapshotservice", "loadSnapshot", ALL, "read"),
    edge("snapshotservice", "snapshotstore", "resolve key / hash", ALL, "read"),
    edge("snapshotstore", "snapshotfiles", "read bytes", ALL, "file"),
    edge("snapshotservice", "parse", "decode / parse", ALL, "data"),
    edge("snapshotservice", "manifestfile", "resolve theme hash", ALL, "read"),

    /* Browser. */
    edge("spa", "sessionsview", "mount #/sessions", ALL, "control"),
    edge("spa", "timelineview", "mount #/session/:id", ALL, "control"),
    edge("spa", "aggregateview", "mount #/aggregate", ALL, "control"),
    edge("sessionsview", "api", "GET /api/sessions", ALL, "http"),
    edge("timelineview", "api", "GET timeline + snapshots", ALL, "http"),
    edge("aggregateview", "api", "GET /api/aggregate", ALL, "http"),
    edge("timelineview", "render", "replica + minimaps", ALL, "data"),
    edge("aggregateview", "render", "template + heat overlay", ALL, "data"),
    edge("render", "replica", "buildReplicaStage", ALL, "data"),
    edge("render", "filmstrip", "computeMiniMap", ALL, "data")
  ];
})();
