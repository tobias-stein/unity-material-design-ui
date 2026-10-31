using System;
using mdu.ui;


[Serializable]
public struct CreditsViewData
{
    
}

public class CreditsView : UIView<CreditsView, CreditsViewData>
{
    public WindowFrame _window;

    private UnityEngine.Events.UnityEvent _onBack;

    public new void Awake()
    {
        base .Awake();

        _onBack = new UnityEngine.Events.UnityEvent();
        _onBack.AddListener(() => this.close());
    }

    public override void setupUI(UISettings uISettings)
    {
        _window.binder.updateField(data => data.onClose, _onBack);
    }
}
