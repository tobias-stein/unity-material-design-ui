using System;
using com.convalise.UnityMaterialSymbols;
using DG.Tweening;
using MaterialColorUtilities.Palettes;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct ChipData
    {
        public Chip.Style style;

        public MaterialSymbolData icon;
        public string label;
        public UnityEvent onClose;
        public UISettings.ColorRole colorRole;
        public Color customColor;


        public bool showIcon;
        public bool closable;
        public bool enabled;
    }

    public class Chip : UIComponent<Chip, ChipData>, IPointerClickHandler
    {
        public enum Style { Outline, Filled }

        [SerializeField] private SDFQuad _sdf;
        [SerializeField] private HorizontalLayoutGroup _layout;

        [SerializeField] private Icon _icon;
        [SerializeField] private Text _label;
        [SerializeField] private Icon _close;
        [SerializeField] private RectTransform _ripple;

        public bool isEnabled => binder.data.enabled;

        public override void setupUI(UISettings uISettings)
        {
            rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, 32f);

            binder.bind(data => data.style, value =>
            {
                switch (value)
                {
                    case Style.Outline:
                        _sdf.outline = true;
                        _sdf.outlineWidth = 1.0f;
                        _sdf.fillColor = Color.clear.withAlpha(1E-2f);
                        break;
                    case Style.Filled:
                        _sdf.outline = false;
                        _sdf.fillColor = Color.clear.withAlpha(1E-2f);
                        break;
                }
            });
            binder.bind(data => data.showIcon, value =>
            {
                _icon.gameObject.SetActive(value);
                _layout.padding.left = value ? 8 : 16;
            });
            binder.bind(data => data.icon, value => _icon.binder.updateField(data => data.symbol, value));
            binder.bind(data => data.closable, value =>
            {
                _close.gameObject.SetActive(value);
                _layout.padding.right = value ? 8 : 16;
            });
            binder.bind(data => data.label, value => _label.binder.updateField(data => data.text, value));
            binder.bind(data => data.colorRole, value =>
            {
                // dependencies 
                var style = binder.data.style;
                var customColor = binder.data.customColor;
                var enabled = binder.data.enabled;

                if (value == UISettings.ColorRole.Customized)
                {
                    var schema = new Scheme(CorePalette.Of(customColor.ToInt(), MaterialColorUtilities.Palettes.Style.Vibrant), uISettings.useDarkTheme);

                    switch (style)
                    {
                        case Style.Outline:
                            _sdf.outlineColor = schema.Primary;
                            _icon.binder.updateField(data => data.colorRole, UISettings.ColorRole.Customized);
                            _label.binder.updateField(data => data.colorRole, UISettings.ColorRole.Customized);
                            _close.binder.updateField(data => data.colorRole, UISettings.ColorRole.Customized);
                            _icon.binder.updateField(data => data.customColor, schema.Primary);
                            _label.binder.updateField(data => data.customColor, schema.Primary);
                            _close.binder.updateField(data => data.customColor, schema.OnSurface);
                            _ripple.GetComponent<Image>().color = schema.OnSurfaceVariant.withAlpha(0.1f);
                            break;
                        case Style.Filled:
                            _sdf.fillColor = schema.PrimaryContainer;
                            _icon.binder.updateField(data => data.colorRole, UISettings.ColorRole.Customized);
                            _label.binder.updateField(data => data.colorRole, UISettings.ColorRole.Customized);
                            _close.binder.updateField(data => data.colorRole, UISettings.ColorRole.Customized);
                            _icon.binder.updateField(data => data.customColor, schema.OnPrimaryContainer);
                            _label.binder.updateField(data => data.customColor, schema.OnPrimaryContainer);
                            _close.binder.updateField(data => data.customColor, schema.OnSurface);
                            _ripple.GetComponent<Image>().color = schema.OnPrimary.withAlpha(0.1f);
                            break;
                    }
                }
                else
                {
                    switch (style)
                    {
                        case Style.Outline:
                            _sdf.outlineColor = uISettings.getColor(value);
                            _icon.binder.updateField(data => data.colorRole, value);
                            _label.binder.updateField(data => data.colorRole, value);
                            _close.binder.updateField(data => data.colorRole, UISettings.ColorRole.OnSurface);
                            _ripple.GetComponent<Image>().color = uISettings.getColor(UISettings.ColorRole.OnSurfaceVariant).withAlpha(0.1f);
                            break;
                        case Style.Filled:
                            _sdf.fillColor = uISettings.getColor(value);
                            _icon.binder.updateField(data => data.colorRole, UISettings.ColorRole.OnSurface);
                            _label.binder.updateField(data => data.colorRole, UISettings.ColorRole.OnSurface);
                            _close.binder.updateField(data => data.colorRole, UISettings.ColorRole.OnSurface);
                            _ripple.GetComponent<Image>().color = uISettings.getColor(UISettings.ColorRole.OnPrimary).withAlpha(0.1f);
                            break;
                    }
                }

                _icon.binder.updateField(data => data.opacity, enabled ? 1.0f : 0.38f);
                _label.binder.updateField(data => data.opacity, enabled ? 1.0f : 0.38f);
                _close.binder.updateField(data => data.opacity, enabled ? 1.0f : 0.38f);
                switch (style)
                {
                    case Style.Outline:
                        _sdf.outlineColor = _sdf.outlineColor.withAlpha(enabled ? 1.0f : 0.12f);
                        break;
                    case Style.Filled:
                        _sdf.fillColor = _sdf.fillColor.withAlpha(enabled ? 1.0f : 0.12f);
                        break;
                }

                                
            }, data => data.customColor, data => data.style, data => data.enabled);
        }

        #region IPOINTER

        public void OnPointerClick(PointerEventData eventData)
        {
            if (!binder.data.enabled) { return; }

            if (RectTransformUtility.ScreenPointToLocalPointInRectangle(rectTransform, eventData.position, eventData.pressEventCamera, out var localClickPosition))
            {
                animateRipple(localClickPosition, 0.3f);
            }

            if (binder.data.closable && RectTransformUtility.RectangleContainsScreenPoint(_close.rectTransform, eventData.position, eventData.pressEventCamera))
            {
                binder.data.onClose?.Invoke();
            }
        }

        #endregion

        #region ANIMATION

        private void animateRipple(Vector2 localClickPosition, float duration)
        {
            _ripple.localPosition = localClickPosition;
            DOTween.Kill(_ripple);
            DOTween.To(() => _ripple.localScale, x => _ripple.localScale = x, Vector3.one * (2f * Mathf.Max(rectTransform.rect.width, rectTransform.rect.height)), duration)
                .SetEase(Ease.OutQuad)
                .OnKill(() => _ripple.localScale = Vector2.zero)
                .OnComplete(() => _ripple.localScale = Vector2.zero)
                .SetTarget(_ripple);
        }

        #endregion
    }
}