namespace mdu.ui.telemetry.events
{
    /// <summary>Measurement names used in the exported line protocol.</summary>
    public static class Measurements
    {
        /// <summary>Single UI interaction or view lifecycle point.</summary>
        public const string UiEvent = "ui_event";

        /// <summary>Session boundary point (type = start | end).</summary>
        public const string Session = "session";

        /// <summary>
        /// Snapshot ledger point, emitted once per successfully written snapshot
        /// file. Tags are bounded (session/view/view_id — the same series space
        /// as ui_event); the identifying payload (storage key, content hash,
        /// counts, owner info) lives in fields to avoid series explosions.
        /// </summary>
        public const string UiSnapshotTaken = "ui_snapshot_taken";
    }

    /// <summary>Event type tag values (the "type" tag).</summary>
    public static class EventTypes
    {
        public const string Click = "click";
        public const string Toggle = "toggle";
        public const string Close = "close";
        public const string BackdropClick = "backdrop_click";
        public const string ViewOpen = "view_open";
        public const string ViewClose = "view_close";
        public const string SessionStart = "start";
        public const string SessionEnd = "end";
    }

    /// <summary>
    /// One telemetry point. Pure POCO — serialization to InfluxDB line protocol
    /// happens in <see cref="LineProtocolSerializer"/>.
    /// </summary>
    public sealed class TelemetryEvent
    {
        /// <summary>Line protocol measurement (see <see cref="Measurements"/>).</summary>
        public string measurement;

        /// <summary>Event type tag value (see <see cref="EventTypes"/>).</summary>
        public string type;

        /// <summary>UTC timestamp in nanoseconds since the Unix epoch.</summary>
        public long timestampNs;

        public string sessionId;

        /// <summary>View the event happened in (id of the IView). Null for session points.</summary>
        public string viewId;

        /// <summary>Short view type name, e.g. "UIDemoMainMenu".</summary>
        public string viewName;

        /// <summary>
        /// Canvas layer of the view the event belongs to (<see cref="CanvasLayer"/> name,
        /// e.g. "POPUP" for dialogs/snackbars). Only written on view_open/view_close
        /// points; null otherwise.
        /// </summary>
        public string layer;

        /// <summary>Interacted element's IUI id. Null for view/session points.</summary>
        public string elementId;

        /// <summary>Interacted element's CLR type name, e.g. "mdu.ui.Button".</summary>
        public string elementTypeName;

        /// <summary>New state for toggles; null otherwise.</summary>
        public bool? flag;

        /// <summary>Seconds the view was open, on view_close points; null otherwise.</summary>
        public double? dwellSeconds;

        // ---------------------------------------------------------------
        // ui_snapshot_taken payload — null/absent on every other point.
        // ---------------------------------------------------------------

        /// <summary>
        /// Storage key of the written snapshot file, relative to the convention
        /// root (always forward slashes): "snapshots/&lt;yyyy&gt;/&lt;mm&gt;/&lt;dd&gt;/&lt;fileName&gt;".
        /// </summary>
        public string storageKey;

        /// <summary>
        /// SHA-256 of the exact bytes written to disk (lowercase hexadecimal).
        /// The authoritative join key; the storage key is only a lookup hint.
        /// </summary>
        public string fileHash;

        /// <summary>Node count of the captured snapshot.</summary>
        public int? nodeCount;

        /// <summary>Screen width/height the snapshot was captured in (as app info reports it).</summary>
        public float? screenWidth;
        public float? screenHeight;

        /// <summary>Product name of the app that wrote the snapshot (owner info).</summary>
        public string owner;

        /// <summary>Platform the snapshot was captured on, e.g. "OSXEditor".</summary>
        public string platform;

        /// <summary>Screensize summary "WxH" (synced with screenWidth/screenHeight).</summary>
        public string screen;
    }

    /// <summary>
    /// Payload needed to emit one <see cref="Measurements.UiSnapshotTaken"/> ledger
    /// point. Built by <see cref="snapshot.UISnapshotExporter"/> after its file
    /// write returned, passed to <c>EventCollector.snapshotTaken</c>.
    /// </summary>
    public sealed class SnapshotTakenInfo
    {
        /// <summary>Session the snapshot belongs to (from the capture); the collector falls back to its own session id.</summary>
        public string sessionId;

        public string viewId;
        public string viewName;
        public string storageKey;
        public string fileHash;
        public int nodeCount;
        public float screenWidth;
        public float screenHeight;
        public string owner;
        public string platform;
    }
}
