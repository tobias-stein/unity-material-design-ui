using System;
using UnityEngine;
using mdu.ui.telemetry.events;
using mdu.ui.telemetry.snapshot;

namespace mdu.ui.telemetry
{
    /// <summary>
    /// Entry point for telemetry: owns configuration and bootstraps the hidden
    /// runtime host plus all telemetry features on scene load.
    /// </summary>
    public static class Telemetry
    {
        private static TelemetryConfig _config;
        private static TelemetryHost _host;
        private static UISnapshotTriggers _snapshotTriggers;
        private static EventCollector _eventCollector;

        /// <summary>
        /// Effective configuration. Lazily loaded from Resources/Settings/TelemetrySettings
        /// when present, otherwise built-in defaults.
        /// </summary>
        public static TelemetryConfig config
        {
            get
            {
                if (_config == null)
                {
                    var asset = Resources.Load<TelemetrySettings>("Settings/TelemetrySettings");
                    _config = asset != null ? asset.cloneConfig() : new TelemetryConfig();
                }

                return _config;
            }
        }

        /// <summary> Live snapshot trigger feature (null before bootstrap). </summary>
        public static UISnapshotTriggers snapshotTriggers => _snapshotTriggers;

        /// <summary> Live event collector feature (null before bootstrap). </summary>
        public static EventCollector events => _eventCollector;

        /// <summary>
        /// Id of the current telemetry session. Generated when telemetry
        /// bootstraps and replaced by <see cref="newSession"/>. Null before bootstrap.
        /// Every exported event (and snapshot app info) carries this id.
        /// </summary>
        public static string sessionId => _eventCollector?.sessionId;

        /// <summary>
        /// Ends the current session, flushes its events to disk and starts a
        /// new session id. Safe to call at any time at runtime.
        /// </summary>
        public static void newSession()
        {
            _eventCollector?.newSession();
        }

        /// <summary>
        /// Editor play-mode exit hook: closes the open view spans, writes the
        /// session end point and persists every buffered event to disk.
        /// <see cref="Application.quitting"/> does not fire when play mode
        /// ends in the editor, so without this the sink's in-memory batch is
        /// either lost to the domain reload or stranded until the next play.
        /// No-op when telemetry never bootstrapped.
        /// </summary>
        public static void endSessionForPlayModeExit()
        {
            _eventCollector?.endForExit();
        }

        /// <summary>
        /// Mutates the effective configuration (merged over asset/defaults).
        /// Example: <c>Telemetry.configure(cfg => cfg.maxFiles = 20);</c>
        /// </summary>
        public static void configure(Action<TelemetryConfig> apply)
        {
            apply?.Invoke(config);
        }

        /// <summary> Drops the cached config so the next access reloads from the Resources asset. </summary>
        public static void resetConfig()
        {
            _config = null;
        }

        /// <summary>
        /// Bootstraps all telemetry: creates the DontDestroyOnLoad host object and
        /// starts every feature. Runs once per play session (safe with
        /// disabled domain reload — a destroyed host triggers re-bootstrap).
        /// </summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void bootstrap()
        {
            if (_host != null)
            {
                return;
            }

            _snapshotTriggers = new UISnapshotTriggers();
            _eventCollector = new EventCollector();

            var go = new GameObject("[Telemetry]");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _host = go.AddComponent<TelemetryHost>();
        }

        internal static void tick()
        {
            try
            {
                _snapshotTriggers?.tick();
            }
            catch (Exception ex)
            {
                // A broken feature must never take down the host (or the app).
                Debug.LogException(ex);
            }

            try
            {
                _eventCollector?.tick();
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }
    }
}
