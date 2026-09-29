using System;
using com.convalise.UnityMaterialSymbols;
using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct IconData
    {
        public MaterialSymbolData symbol;
        public UISettings.ColorRole colorRole;
        public Color customColor;
        [Range(0f, 1f)] public float opacity;
        public Icon.Size size;
    }

    [RequireComponent(typeof(MaterialSymbol))]
    public class Icon : UIComponent<Icon, IconData>
    {
        public enum Size { XS, SM, MD, LG, XL, XXL };

        private MaterialSymbol _symbol;

        public new void Awake()
        {
            base.Awake();
            _symbol = GetComponent<MaterialSymbol>();
        }

        public override void setupUI(UISettings uiSettings)
        {
            _symbol = GetComponent<MaterialSymbol>();
            _symbol.hideFlags = HideFlags.HideInInspector;

            binder.bind(data => data.size, value =>
            {
                switch (value)
                {
                    case Size.XS: rectTransform.sizeDelta = new Vector2(16f, 16f); break;
                    case Size.SM: rectTransform.sizeDelta = new Vector2(20f, 20f); break;
                    case Size.MD: rectTransform.sizeDelta = new Vector2(24f, 24f); break;
                    case Size.LG: rectTransform.sizeDelta = new Vector2(32f, 32f); break;
                    case Size.XL: rectTransform.sizeDelta = new Vector2(40f, 40f); break;
                    case Size.XXL: rectTransform.sizeDelta = new Vector2(48f, 48f); break;
                }

                LayoutRebuilder.MarkLayoutForRebuild(rectTransform);
            });
            binder.bind(data => data.colorRole, value =>
            {
                _symbol.color = value != UISettings.ColorRole.Customized ? uiSettings.getColor(value) : binder.data.customColor;
            }, dependsOn: data => data.customColor);
            binder.bind(data => data.opacity, value => { _symbol.color = _symbol.color.withAlpha(value); }, dependsOn: data => data.colorRole);
            binder.bind(data => data.symbol, value => _symbol.symbol = value);
        }
    }
}