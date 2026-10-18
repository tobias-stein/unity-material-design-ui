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
    }
}
