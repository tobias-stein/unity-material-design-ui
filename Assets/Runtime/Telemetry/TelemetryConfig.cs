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
        [Tooltip("Minimum seconds between two automatic transition captures. 0 = no pacing " +
                 "(every activation captures immediately). At >0 the minimum spacing still guarantees " +
                 "every view cycle: activations paced out by the interval wait in a defer queue and " +
                 "capture when it elapses instead of being dropped.")]
        public float viewTransitionMinInterval = 1f;
        [Tooltip("Seconds to wait after a view activation before taking its transition snapshot, " +
                 "so views that populate or animate themselves while opening (panels sliding in, " +
                 "async content creation) are captured settled instead of mid-animation. " +
                 "0 = capture immediately. If the view closes inside the window the capture is " +
                 "skipped for that cycle — its lifecycle events are recorded regardless.")]
        public float viewTransitionSettle = 0.5f;
        [Tooltip("Snap one capture per near-simultaneous duplicate raise of the same view (one capture per visibility cycle is always kept). The old cross-cycle 'view id + node count' dedupe is gone — pooled views re-open with the same id, which starved re-opened cycles and consecutive snackbars of their captures.")]
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

        [Header("Popup views (dialogs, snackbars)")]
        [Tooltip("Emit view_open/view_close for popup-layer views (Dialog, Snackbar, …) " +
                 "and capture their snapshots on show, so the timeline gets a filmstrip row per popup.")]
        public bool popupTrackingEnabled = true;
        [Tooltip("Popup view type names excluded from lifecycle tracking and snapshot capture.")]
        public string[] popupExcludedViews = { "Tooltip" };

        [Header("Runtime mutation trigger (UI created while a view is open)")]
        [Tooltip("Capture snapshots when UI elements are created during a open view's " +
                 "lifetime (panels spawning, dynamic lists, …). Each creation under a view " +
                 "refreshes a per-view debounce window; one snapshot fires when it settles, " +
                 "so bursts (panel + its contents) coalesce. Also fills the gap left by the " +
                 "view-transition capture when a view populates itself asynchronously right " +
                 "after activation.")]
        public bool runtimeCaptureEnabled = true;
        [Tooltip("Seconds after the last structural UI change (create/remove) under a view " +
                 "before the debounced mutation capture fires. Anything changing inside the " +
                 "window coalesces into that single snapshot. Kept short on purpose — the " +
                 "burst a spawned panel produces (panel + its contents) lands within ~100ms.")]
        public float mutationDebounce = 0.25f;
        [Tooltip("Maximum mutation captures per view visibility cycle (0 = unlimited). " +
                 "Emergency only: it must stay high enough that normal interactive use never " +
                 "hits it (a dynamic view can easily consume one slot per open/close action); " +
                 "the mutation dedupe makes a high cap cheap — structural duplicates never " +
                 "export. A hit is logged as a warning.")]
        public int mutationMaxCapturesPerCycle = 50;
        [Tooltip("Skip exporting a mutation capture whose node tree (ids, types, rects) is " +
                 "identical to the view's last exported one within the current visibility " +
                 "cycle — e.g. a created element that settled into an unchanged layout. " +
                 "Scoped to mutation captures only: managed transitions and popups always " +
                 "export, so the 'exactly one snapshot per cycle' contract is untouched.")]
        public bool mutationDedupe = true;

        /// <summary>Whether this popup-layer view is excluded from tracking (type-name match against popupExcludedViews).</summary>
        public bool isExcludedPopup(IView view)
        {
            if (view == null || popupExcludedViews == null || popupExcludedViews.Length == 0)
            {
                return false;
            }
            var name = view.GetType().Name;
            foreach (var excluded in popupExcludedViews)
            {
                if (string.Equals(excluded, name, StringComparison.Ordinal))
                {
                    return true;
                }
            }
            return false;
        }

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
        [Tooltip("Flush the event buffer after this many seconds. Lives 1s so the telemetry " +
                 "viewer's live mode (1s poll) sees the session in near-realtime.")]
        public float eventFlushInterval = 1f;
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
