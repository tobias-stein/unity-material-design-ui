using UnityEngine;

namespace mdu.ui.telemetry
{
    [CreateAssetMenu(fileName = "TelemetrySettings", menuName = "UMDUI/Telemetry Settings")]
    public class TelemetrySettings : ScriptableObject
    {
        [SerializeField] private TelemetryConfig _config = new TelemetryConfig();

        public TelemetryConfig config => _config;

        public TelemetryConfig cloneConfig()
        {
            // TelemetryConfig is a plain [Serializable] class of primitives/enums/strings,
            // so a JsonUtility roundtrip is a safe deep copy.
            return JsonUtility.FromJson<TelemetryConfig>(JsonUtility.ToJson(_config));
        }
    }
}
