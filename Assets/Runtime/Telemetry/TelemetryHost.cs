using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace mdu.ui.telemetry
{
    /// <summary>
    /// Minimal MonoBehaviour host created by <see cref="Telemetry.bootstrap"/> —
    /// it exists solely to tick registered telemetry features every frame.
    /// </summary>
    public class TelemetryHost : MonoBehaviour
    {
        private void Update()
        {
            Telemetry.tick();
        }

#if UNITY_EDITOR
        private void OnEnable()
        {
            // Application.quitting does not fire when play mode ends in the
            // editor, so the sink's in-memory batch would either linger until
            // the next play or be lost to a domain reload. Intercept the
            // play-mode transition instead.
            EditorApplication.playModeStateChanged -= onPlayModeStateChanged;
            EditorApplication.playModeStateChanged += onPlayModeStateChanged;
        }

        private void OnDisable()
        {
            EditorApplication.playModeStateChanged -= onPlayModeStateChanged;
        }

        private void onPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.ExitingPlayMode)
            {
                Telemetry.endSessionForPlayModeExit();
            }
        }
#endif
    }
}
