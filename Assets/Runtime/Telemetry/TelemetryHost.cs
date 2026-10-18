using UnityEngine;

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
    }
}
