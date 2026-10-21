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
            // Bounded tag (CanvasLayer enum names) so series growth stays linear.
            appendTag(sb, "layer", e.layer);
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
            // Field section shape (line protocol): `measurement[,tags] fields ts` —
            // the FIRST field separates from the tag set with a single space, not
            // a comma. Today's parser (telemetry-viewer `lp.ts`) also treats every
            // fused tag/field line as malformed and drops the ledger point.
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
            hasField = appendIntegerField(sb, hasField, "nodes", e.nodeCount);
            hasField = appendFloatField(sb, hasField, "width", e.screenWidth);
            hasField = appendFloatField(sb, hasField, "height", e.screenHeight);
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
        /// Appends a string field with separator handling: the FIRST field of a
        /// section separates from the tag set with a single space, later fields
        /// with a comma. String fields are written as `key="value"` with
        /// backslash and quote escaping; absent values are skipped. Returns
        /// whether a field now exists.
        /// </summary>
        private static bool appendField(StringBuilder sb, bool hasField, string key, string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return hasField;
            }

            sb.Append(hasField ? ',' : ' ');
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

        /// <summary>
        /// Int field variant of <see cref="appendField(StringBuilder,bool,string,string)"/>:
        /// line-protocol integer syntax `key=42i` (the .lp parser projects nodes
        /// only from int/uint field values).
        /// </summary>
        private static bool appendIntegerField(StringBuilder sb, bool hasField, string key, int? value)
        {
            if (!value.HasValue)
            {
                return hasField;
            }

            sb.Append(hasField ? ',' : ' ');
            sb.Append(key).Append('=').Append(value.Value.ToString(CultureInfo.InvariantCulture)).Append('i');
            return true;
        }

        /// <summary>
        /// Float field variant of <see cref="appendField(StringBuilder,bool,string,string)"/>:
        /// unquoted line-protocol float `width=1920` (invariant culture, no
        /// scientific notation; the .lp parser projects width/height only from
        /// numeric field values).
        /// </summary>
        private static bool appendFloatField(StringBuilder sb, bool hasField, string key, float? value)
        {
            if (!value.HasValue)
            {
                return hasField;
            }

            sb.Append(hasField ? ',' : ' ');
            sb.Append(key).Append('=').Append(presentFloat(value.Value));
            return true;
        }

        private static string presentFloat(float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                return "0";
            }
            return value.ToString("0.######", CultureInfo.InvariantCulture);
        }
    }
}
