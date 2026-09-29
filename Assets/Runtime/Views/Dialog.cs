using System;
using mdu.ui;
using UnityEngine;
using UnityEngine.Assertions;
using UnityEngine.Events;
using UnityEngine.UI;

namespace mdu
{
    [Serializable]
    public struct DialogData
    {
        public string title;
        public string text;
        public bool persistent;
    }

    [RequireComponent(typeof(VerticalLayoutGroup))]
    public class Dialog : UIView<Dialog, DialogData>
    {
        [SerializeField] private ui.Text _title;
        [SerializeField] private ui.Text _supportText;
        [SerializeField] private RectTransform _actions;
        [SerializeField] private VerticalLayoutGroup _layout;
        [SerializeField] private Shadow _shadow;
        [SerializeField] private ui.Button _close;
        [SerializeField] private Backdrop _backdrop;
        
        public new void Awake()
        {
            base.Awake();
            Assert.IsNotNull(_title, "Title reference missing");
            Assert.IsNotNull(_supportText, "Support text reference missing");
            Assert.IsNotNull(_actions, "Actions reference missing");
            Assert.IsNotNull(_layout, "Layout group reference missing");
            Assert.IsNotNull(_close, "Close button reference missing");
            Assert.IsNotNull(_backdrop, "Backdrop reference missing");
        }

        public override void setupUI(UISettings uiSettings)
        {
            _layout.padding = new RectOffset
            {
                top = (int)Math.Ceiling(uiSettings.GetSpacingInUnityUnits(UISettings.Spacing.SM)),
                left = (int)Math.Ceiling(uiSettings.GetSpacingInUnityUnits(UISettings.Spacing.SM)),
                bottom = (int)Math.Ceiling(uiSettings.GetSpacingInUnityUnits(UISettings.Spacing.SM)),
                right = (int)Math.Ceiling(uiSettings.GetSpacingInUnityUnits(UISettings.Spacing.SM))
            };

            _layout.spacing = (int)Math.Ceiling(uiSettings.GetSpacingInUnityUnits(UISettings.Spacing.SM));
            _shadow.effectColor = uiSettings.getColor(UISettings.ColorRole.Shadow);
            _shadow.effectDistance = new Vector2(1, -1) * 3f;

            _backdrop.color = uiSettings.getColor(UISettings.ColorRole.Shadow).withAlpha(0.32f);
            _backdrop.onClick = null;

            _title.binder.updateField(data => data.colorRole, UISettings.ColorRole.OnSurface);
            _supportText.binder.updateField(data => data.colorRole, UISettings.ColorRole.OnSurface);

            binder.bind(data => data.title, value => _title.binder.updateField(data => data.text, value));
            binder.bind(data => data.text, value => _supportText.binder.updateField(data => data.text, value));
            binder.bind(data => data.persistent, value =>
            {
                _backdrop.onClick = null;
                if (!value)
                {
                    _backdrop.onClick = close;
                }
            });

            var onClick = new UnityEvent();
            onClick.AddListener(close);
            _close.binder.updateField(data => data.onClick, onClick);
        }

        public override void close()
        {
            Dispose();
        }
        
        public static void open(string title, string text, bool persistent = false)
        {
            open(new DialogData
            {
                title = title,
                text = text,
                persistent = persistent   
            });
        }
    }
}
