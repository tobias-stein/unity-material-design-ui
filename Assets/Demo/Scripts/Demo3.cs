using UnityEngine;

public class Demo3 : MonoBehaviour
{
    // Start is called once before the first execution of Update after the MonoBehaviour is created
    void Start()
    {
        mdu.ui.UI.views.push<MainMenuView, MainMenuViewData>();   
    }
}
