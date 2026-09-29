using UnityEngine;

namespace mdu.ui.demo
{
    public class DemoStartup : MonoBehaviour
    {
        void Start()
        {
            UI.views.push<UIDemoMainMenu, UIDemoMainMenuData>(
                new UIDemoMainMenuData
                {
                },
                // post construct
                async instance =>
                {
                    return;
                }
            );   
        }
    }
}
