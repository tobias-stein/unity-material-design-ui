using System;
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
            var measurement = string.IsNullOrEmpty(e.measurement) ? Measurements.UiEvent : e.measurement;
            return measurement == Measurements.UiSnapshotTaken
                ? serializeSnapshotTaken(e)
                : serializeUiEvent(e, measurement);
        }

        private static string serializeUiEvent(TelemetryEvent e, string measurement)
        {
            var sb = new StringBuilder(256);

            sb.Append(measurement);

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
        /// Serializes a <see cref="Measurements.UiSnapshotTaken"/> ledger point:
        /// only the bounded tag set (session/view/view_id) so series growth stays
        /// linear, all payload (key/hash/counts/owner info) in fields.
        /// </summary>
        private static string serializeSnapshotTaken(TelemetryEvent e)
        {
            var sb = new StringBuilder(256);

            sb.Append(Measurements.UiSnapshotTaken);

            appendTag(sb, "session", e.sessionId);
            if (!string.IsNullOrEmpty(e.viewId) || !string.IsNullOrEmpty(e.viewName))
            {
                appendTag(sb, "view", e.viewName);
                appendTag(sb, "view_id", e.viewId);
            }

            var hasField = false;
            hasField = appendField(sb, hasField, "key", e.storageKey);
            hasField = appendField(sb, hasField, "hash", e.fileHash);
            hasField = appendField(sb, hasField, "nodes", e.nodeCount, CultureInfo.InvariantCulture);
            hasField = appendField(sb, hasField, "width", e.screenWidth, "0.###");
            hasField = appendField(sb, hasField, "height", e.screenHeight, "0.###");
            hasField = appendField(sb, hasField, "owner", e.owner);
            hasField = appendField(sb, hasField, "platform", e.platform);
            hasField = appendField(sb, hasField, "screen", e.screen);

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

        /// <summary>
        /// Appends a string field (<c>&lt;sep&gt;key="value"</c> with backslash and
        /// quote escaping) when the value is present. Returns whether a field now
        /// exists (so callers can separate the first field by a space, not a comma).
        /// </summary>
        private static bool appendField(StringBuilder sb, bool hasField, string key, string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return hasField;
            }

            if (hasField)
            {
                sb.Append(',');
            }

            sb.Append(key).Append("=\"");
            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    default: sb.Append(c); break;
                }
            }
            sb.Append('"');
            return true;
        }

        /// <summary> Int field variant of <see cref="appendField(StringBuilder,bool,string,string)"/>. </summary>
        private static bool appendField(StringBuilder sb, bool hasField, string key, int? value, IFormatProvider format)
        {
            return value.HasValue
                ? appendField(sb, hasField, key, value.Value.ToString(format))
                : hasField;
        }

        /// <summary> Float field variant of <see cref="appendField(StringBuilder,bool,string,string)"/>. </summary>
        private static bool appendField(StringBuilder sb, bool hasField, string key, float? value, string format)
        {
            return value.HasValue
                ? appendField(sb, hasField, key, value.Value.ToString(format, CultureInfo.InvariantCulture))
                : hasField;
        }
    }
}
