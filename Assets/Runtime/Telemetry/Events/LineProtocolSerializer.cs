using System.Globalization;
using System.Text;

namespace mdu.ui.telemetry.events
{
    /// <summary>
    /// Serializes <see cref="TelemetryEvent"/> records to InfluxDB line protocol
    /// (<c>measurement[,tags] [fields] [timestamp]</c>, nanosecond precision), so
    /// exported files can be fed straight into <c>influxd write</c> or a future
    /// HTTP sink without reformatting.
    /// </summary>
    public static class LineProtocolSerializer
    {
        /// <summary> Serializes one event to a single line (no trailing newline). </summary>
        public static string serialize(TelemetryEvent e)
        {
            var sb = new StringBuilder(256);

            sb.Append(string.IsNullOrEmpty(e.measurement) ? Measurements.UiEvent : e.measurement);

            appendTag(sb, "type", e.type);
            appendTag(sb, "session", e.sessionId);
            if (!string.IsNullOrEmpty(e.viewId) || !string.IsNullOrEmpty(e.viewName))
            {
                appendTag(sb, "view", e.viewName);
                appendTag(sb, "view_id", e.viewId);
            }
            if (!string.IsNullOrEmpty(e.elementId))
            {
                appendTag(sb, "element", e.elementId);
                appendTag(sb, "element_type", e.elementTypeName);
            }

            sb.Append(" value=1i");
            if (e.flag.HasValue)
            {
                sb.Append(",on=").Append(e.flag.Value ? "true" : "false");
            }
            if (e.dwellSeconds.HasValue)
            {
                sb.Append(",dwell=")
                  .Append(e.dwellSeconds.Value.ToString("0.###", CultureInfo.InvariantCulture));
            }

            sb.Append(' ').Append(e.timestampNs);
            return sb.ToString();
        }

        /// <summary>
        /// Appends <c>,key=value</c> with line-protocol escaping
        /// (space, comma, equals and backslash) when the value is present.
        /// </summary>
        private static void appendTag(StringBuilder sb, string key, string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return;
            }

            sb.Append(',').Append(key).Append('=');
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                switch (c)
                {
                    case ' ': sb.Append("\\s"); break;
                    case ',': sb.Append("\\,"); break;
                    case '=': sb.Append("\\="); break;
                    case '\\': sb.Append("\\\\"); break;
                    default: sb.Append(c); break;
                }
            }
        }
    }
}
