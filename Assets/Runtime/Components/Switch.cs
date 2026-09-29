using System;
using com.convalise.UnityMaterialSymbols;
using DG.Tweening;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct SwitchData
    {
        public bool enabled;
        public bool isOn;
        public bool showOnIcon;
        public bool showOffIcon;
        public MaterialSymbolData onIcon;
        public MaterialSymbolData offIcon;

        public UnityEvent<bool> onStateChange;
    }

    public class Switch : UIComponent<Switch, SwitchData>, IPointerEnterHandler, IPointerExitHandler, IPointerDownHandler, IPointerUpHandler
    {
        [SerializeField] private Icon _icon;
        [SerializeField] private SDFQuad _container;
        [SerializeField] private SDFCircle _handleColor;
        [SerializeField] private RectTransform _handleRect;
        [SerializeField] private Image _stateLayer0;
        [SerializeField] private SDFCircle _stateLayer1;

        private event Action<bool> _onHoverStateChange;
        private event Action<(bool, PointerEventData)> _onPressStateChange;

        private Tweener _switchPressAnimation;
        private Sequence _switchAnimation, _switchHoverAnomation;
        private float onPosX = 36f;
        private float offPosX = 16f;
        private float handleSizeOff = 16f;
        private float handleSizeOn = 24f;
        private float handleSizePressed = 28f;

        public override void setupUI(UISettings uISettings)
        {
            _onHoverStateChange = null;
            _onPressStateChange = null;

            rectTransform.sizeDelta = new Vector2(52f, 32f);

            binder.bind(data => data.isOn, value =>
            {
                // dependencies
                var enabled = binder.data.enabled;
                var showOnIcon = binder.data.showOnIcon;
                var showOffIcon = binder.data.showOffIcon;
                var onIcon = binder.data.onIcon;
                var offIcon = binder.data.offIcon;

                if (value) // on
                {
                    _container.outline = false;
                    _container.fillColor = uISettings.getColor(UISettings.ColorRole.Primary).withAlpha(enabled ? 1f : 0.12f);

                    _handleColor.fillColor = uISettings.getColor(UISettings.ColorRole.OnPrimary).withAlpha(enabled ? 1f : 0.38f);

                    _stateLayer1.fillColor = uISettings.getColor(UISettings.ColorRole.Primary).withAlpha(0f);

                    _icon.binder.updateField(data => data.symbol, onIcon);
                    _icon.binder.updateField(data => data.colorRole, UISettings.ColorRole.Primary);
                    _icon.binder.updateField(data => data.opacity, showOnIcon ? (enabled ? 1f : 0.38f) : 0f);
                }
                else // off
                {
                    _container.outline = true;
                    _container.outlineWidth = UISettings.DpToUnityUnits(1f);
                    _container.outlineColor = uISettings.getColor(UISettings.ColorRole.Outline).withAlpha(enabled ? 1f : 0.12f);
                    _container.fillColor = uISettings.getColor(UISettings.ColorRole.SurfaceContainerHighest).withAlpha(enabled ? 1f : 0.12f);

                    _handleColor.fillColor = uISettings.getColor(UISettings.ColorRole.Outline).withAlpha(enabled ? 1f : 0.38f);

                    _stateLayer1.fillColor = uISettings.getColor(UISettings.ColorRole.OnSurface).withAlpha(0f);

                    _icon.binder.updateField(data => data.symbol, offIcon);
                    _icon.binder.updateField(data => data.colorRole, UISettings.ColorRole.Outline);
                    _icon.binder.updateField(data => data.opacity, showOffIcon ? (enabled ? 1f : 0.38f) : 0f);
                }
                
                animateSwitch(value);

            }, data => data.enabled, data => data.showOnIcon, data => data.showOffIcon, data => data.onIcon, data => data.offIcon);

            _onPressStateChange += e => onPress(e.Item1, e.Item2);
            _onHoverStateChange += isHovered => onHover(isHovered, uISettings);
        }

        public new void OnDestroy()
        {
            base.OnDestroy();

            _switchAnimation?.Kill();
            _switchHoverAnomation?.Kill();
            _switchPressAnimation?.Kill();
        }

        private void onPress(bool isPressed, PointerEventData data)
        {
            if (!binder.data.enabled) { return; }

            if (isPressed)
            {
                animatePress(true);
            }
            else
            {
                binder.updateField(data => data.isOn, !binder.data.isOn);
            }
        }

        private void onHover(bool isHovered, UISettings uISettings)
        {
            if (!binder.data.enabled) { return; }
            animateHover(isHovered, uISettings);
        }

        #region IPOINTER

        public void OnPointerExit(PointerEventData eventData)
        {
            _onHoverStateChange?.Invoke(false);
        }

        public void OnPointerEnter(PointerEventData eventData)
        {
            _onHoverStateChange?.Invoke(true);
        }

        public void OnPointerDown(PointerEventData eventData)
        {
            _onPressStateChange?.Invoke((true, eventData));
        }

        public void OnPointerUp(PointerEventData eventData)
        {
            _onPressStateChange?.Invoke((false, eventData));
        }

        #endregion

        #region ANIMATION

        private void animateSwitch(bool isOn)
        {
            _switchAnimation?.Kill();
            if (Application.isPlaying)
            {
                _switchAnimation = DOTween.Sequence();
                _switchAnimation.Append(_handleRect.DOAnchorPosX(isOn ? onPosX : offPosX, 0.2f));
                _switchAnimation.Join(animatePress(false));
                _switchAnimation.OnKill(() => binder.data.onStateChange?.Invoke(isOn));
            }
            else
            {
                _handleRect.anchoredPosition = new Vector2(isOn ? onPosX : offPosX, _handleRect.anchoredPosition.y);
                _handleRect.sizeDelta = binder.data.isOn
                    ? new Vector2(handleSizeOn, handleSizeOn)
                    : binder.data.showOffIcon
                        ? new Vector2(handleSizeOn, handleSizeOn)
                        : new Vector2(handleSizeOff, handleSizeOff);
            }
        }

        private void animateHover(bool isHovered, UISettings uISettings)
        {
            _switchHoverAnomation?.Kill();
            _switchHoverAnomation = DOTween.Sequence();

            _switchHoverAnomation.Append(DOTween.To(() => _stateLayer1.fillColor.a, x => _stateLayer1.fillColor = _stateLayer1.fillColor.withAlpha(x), isHovered ? 0.08f : 0.0f, 0.1f));
            _switchHoverAnomation.Join(DOTween.To(() => 0f, x =>
                {
                    Color _color(bool hoverState) => hoverState
                            ? binder.data.isOn ? uISettings.getColor(UISettings.ColorRole.PrimaryContainer) : uISettings.getColor(UISettings.ColorRole.OnSurfaceVariant)
                            : binder.data.isOn ? uISettings.getColor(UISettings.ColorRole.OnPrimary) : uISettings.getColor(UISettings.ColorRole.Outline);

                    _handleColor.fillColor = Color.Lerp(_color(!isHovered), _color(isHovered), x);
                }, 1.0f, 0.1f)
                .OnKill(() =>
                { 
                    _handleColor.fillColor = isHovered
                            ? binder.data.isOn ? uISettings.getColor(UISettings.ColorRole.PrimaryContainer) : uISettings.getColor(UISettings.ColorRole.OnSurfaceVariant)
                            : binder.data.isOn ? uISettings.getColor(UISettings.ColorRole.OnPrimary) : uISettings.getColor(UISettings.ColorRole.Outline);
                })
            );
        }

        private Tweener animatePress(bool isPressed)
        {
            _switchPressAnimation?.Kill();
            _switchPressAnimation = _handleRect.DOSizeDelta(
                isPressed
                    ? new Vector2(handleSizePressed, handleSizePressed)
                    : binder.data.isOn
                        ? new Vector2(handleSizeOn, handleSizeOn)
                        : binder.data.showOffIcon
                            ? new Vector2(handleSizeOn, handleSizeOn)
                            : new Vector2(handleSizeOff, handleSizeOff),
                0.1f
            );

            return _switchPressAnimation;
        }
        
        #endregion
    }
}