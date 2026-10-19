using System;
using UnityEngine;

namespace mdu.ui.telemetry
{
    public enum TelemetryOutputLocation
    {
        /// <summary>Application.persistentDataPath (default, works on all platforms).</summary>
        PersistentData,

        /// <summary>Absolute path provided by customOutputPath.</summary>
        Custom
    }

    /// <summary>
    /// Configuration for telemetry capture. Loaded once from
    /// Resources/Settings/TelemetrySettings (if present), otherwise code defaults apply.
    /// Runtime overrides via <c>Telemetry.configure(cfg => ...)</c>.
    /// </summary>
    [Serializable]
    public class TelemetryConfig
    {
        [Tooltip("Master switch for automatic triggers. Manual capture APIs are unaffected.")]
        public bool enabled = true;

        [Header("Hotkey trigger")]
        public bool hotkeyEnabled = true;
        public KeyCode hotkey = KeyCode.F9;
        [Tooltip("Only allow the hotkey in the editor / development builds.")]
        public bool hotkeyDevOnly = true;

        [Header("View transition trigger")]
        public bool viewTransitionEnabled = true;
        [Tooltip("Minimum seconds between two automatic transition captures.")]
        public float viewTransitionMinInterval = 5f;
        [Tooltip("Skip writing when view id and node count are unchanged since the last capture.")]
        public bool viewTransitionDedupe = true;

        [Header("Output")]
        public TelemetryOutputLocation outputLocation = TelemetryOutputLocation.PersistentData;
        [Tooltip("Used when outputLocation is Custom.")]
        public string customOutputPath = "";
        [Tooltip("Subfolder under the base directory. Forward slashes are fine.")]
        public string outputSubfolder = "Telemetry/snapshots";
        [Tooltip("Tokens: {viewName}, {timestamp}, {id}")]
        public string fileNameTemplate = "{viewName}-{timestamp}";
        public bool gzip = false;

        [Header("Retention (0 = unlimited)")]
        [Tooltip("Delete oldest snapshots beyond this many files.")]
        public int maxFiles = 100;
        [Tooltip("Delete oldest snapshots beyond this total size in megabytes.")]
        public float maxTotalMB = 50;

        [Header("Capture")]
        [Tooltip("Run LayoutRebuildLayoutImmediate before walking the tree so rects are current.")]
        public bool forceRebuildLayout = true;
        [Tooltip("Skip pooled (inactive, recycled) UI elements and their subtrees.")]
        public bool skipPooled = true;

        [Header("Snapshot ledger")]
        [Tooltip("Emit one ui_snapshot_taken point per successfully written snapshot file " +
                 "(tags: session/view/view_id; fields: key/hash/nodes/width/height/owner/platform/screen). " +
                 "Rides the same event pipeline as interaction events — it lands in pending-*.lp " +
                 "when InfluxDB is down and in session-<id>.lp in file-archive mode. Requires eventsEnabled.")]
        public bool snapshotLedger = true;

        [Header("Events (InfluxDB line protocol)")]
        [Tooltip("Record UI interaction and view dwell events with the session id.")]
        public bool eventsEnabled = true;
        [Tooltip("Subfolder under the base directory for event files (session-<id>.lp / pending-*.lp).")]
        public string eventsSubfolder = "Telemetry/events";
        [Tooltip("Flush the event buffer once this many events are pending.")]
        public int eventFlushCount = 64;
        [Tooltip("Flush the event buffer after this many seconds.")]
        public float eventFlushInterval = 5f;
        [Tooltip("Delete oldest event files beyond this many (0 = unlimited). Safety cap for undelivered pending files.")]
        public int eventsMaxFiles = 100;

        [Header("InfluxDB (v2 HTTP API)")]
        [Tooltip("Deliver events to InfluxDB as a write-ahead outbox: persisted to pending-*.lp first, " +
                 "file deleted on 204. When off, events are archived to session-<id>.lp files instead. " +
                 "url/org/bucket/token must match Extra/Infrastructure/docker-compose.yml.")]
        public bool influxEnabled = true;
        public string influxUrl = "http://localhost:8086";
        public string influxOrg = "mdu";
        public string influxBucket = "ui";
        [Tooltip("Local dev token from the compose file — never put a production token here for shipping builds.")]
        public string influxToken = "mdu-local-dev-token-0123456789abcdef";
        [Tooltip("HTTP timeout per write attempt, in seconds.")]
        public float influxTimeoutSeconds = 10f;
    }
}
