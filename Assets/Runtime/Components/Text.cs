using System;
using TMPro;
using UnityEngine;

namespace mdu.ui
{

    [Serializable]
    public struct TextData
    {
        public string text;
        public UISettings.TextRole textRole;
        public UISettings.ColorRole colorRole;
        public Color customColor;
        [Range(0f, 1f)] public float opacity;
        public TextWrappingModes wrapping;
        public TextOverflowModes overflow;
        public HorizontalAlignmentOptions horizontalAlignment;
        public VerticalAlignmentOptions verticalAlignment;
    }

    [RequireComponent(typeof(TMP_Text))]
    public class Text : UIComponent<Text, TextData>
    {
        [SerializeField] private TMP_Text _text;

        public override void setupUI(UISettings uiSettings)
        {
            binder.bind(data => data.text, value => _text.text = value);
            binder.bind(data => data.colorRole, value =>
            {
                _text.color = value != UISettings.ColorRole.Customized ? uiSettings.getColor(value) : binder.data.customColor;
            }, dependsOn: data => data.customColor);
            binder.bind(data => data.opacity, value => _text.alpha = value);
            binder.bind(data => data.horizontalAlignment, value => _text.horizontalAlignment = value);
            binder.bind(data => data.verticalAlignment, value => _text.verticalAlignment = value);
            binder.bind(data => data.textRole, value => _text.applyFont(uiSettings, value));
            binder.bind(data => data.wrapping, value => _text.textWrappingMode = value);
            binder.bind(data => data.overflow, value => _text.overflowMode = value);
        }
    }
}