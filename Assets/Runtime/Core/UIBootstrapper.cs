using UnityEngine;

namespace mdu.ui
{
    public static class UIBootstrapper
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Initialize()
        {
            var uiSettings = Resources.Load<UISettings>("Settings/UISettings");
            var runtimeInstance = uiSettings.clone();

            var ui = new UI(runtimeInstance);

            Camera.main.backgroundColor = runtimeInstance.getColor(UISettings.ColorRole.Surface5);
            runtimeInstance.onChanged += _ =>
            {
                Camera.main.backgroundColor = runtimeInstance.getColor(UISettings.ColorRole.Surface5);
            };
        }
    }
}
