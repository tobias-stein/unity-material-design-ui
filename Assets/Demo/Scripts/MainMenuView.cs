using System;
using mdu;
using mdu.ui;

[Serializable]
public struct MainMenuViewData
{
    
}

public class MainMenuView : UIView<MainMenuView, MainMenuViewData>
{
    public Button _newGameButton;
    public Button _multiplayerButton;
    public Button _optionsButton;
    public Button _creditsButton;
    public Button _quitButton;

    private UnityEngine.Events.UnityEvent _onNewGameClick, _onMultiplayerClick, _onOptionsClick, _onCreditsClick, _onQuitClick;

    public new void Awake()
    {
        base .Awake();

        _onNewGameClick = new UnityEngine.Events.UnityEvent();
        _onMultiplayerClick = new UnityEngine.Events.UnityEvent();
        _onOptionsClick = new UnityEngine.Events.UnityEvent();
        _onCreditsClick = new UnityEngine.Events.UnityEvent();
        _onQuitClick = new UnityEngine.Events.UnityEvent();

        _onNewGameClick.AddListener(() =>
        {
            Dialog.open(
                "New Game",
                "Preparing new game world for you. Please stand by ...",
                false
            );
        });

        _onMultiplayerClick.AddListener(() => UI.views.push<MultiplayerView, MultiplayerViewData>(new MultiplayerViewData {}));
        _onOptionsClick.AddListener(() => UI.views.push<OptionsView, OptionsViewData>(new OptionsViewData {}));
        _onCreditsClick.AddListener(() => UI.views.push<CreditsView, CreditsViewData>(new CreditsViewData {}));

        _onQuitClick.AddListener(() =>
        {
#if UNITY_EDITOR
                UnityEditor.EditorApplication.isPlaying = false;
#else
                Application.Quit(0);
#endif
        });
    }

    public override void setupUI(UISettings uISettings)
    {
        _newGameButton.binder.updateField(data => data.onClick, _onNewGameClick);
        _multiplayerButton.binder.updateField(data => data.onClick, _onMultiplayerClick);
        _optionsButton.binder.updateField(data => data.onClick, _onOptionsClick);
        _creditsButton.binder.updateField(data => data.onClick, _onCreditsClick);
        _quitButton.binder.updateField(data => data.onClick, _onQuitClick);
    }
}
