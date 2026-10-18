namespace mdu.ui.telemetry.events
{
    /// <summary>Measurement names used in the exported line protocol.</summary>
    public static class Measurements
    {
        /// <summary>Single UI interaction or view lifecycle point.</summary>
        public const string UiEvent = "ui_event";

        /// <summary>Session boundary point (type = start | end).</summary>
        public const string Session = "session";
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

        /// <summary>Interacted element's IUI id. Null for view/session points.</summary>
        public string elementId;

        /// <summary>Interacted element's CLR type name, e.g. "mdu.ui.Button".</summary>
        public string elementTypeName;

        /// <summary>New state for toggles; null otherwise.</summary>
        public bool? flag;

        /// <summary>Seconds the view was open, on view_close points; null otherwise.</summary>
        public double? dwellSeconds;
    }
}
