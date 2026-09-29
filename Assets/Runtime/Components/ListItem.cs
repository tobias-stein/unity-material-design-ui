using System;
using com.convalise.UnityMaterialSymbols;
using DG.Tweening;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct ListItemData
    {
        public string title;
        public string subtitle;

        public MaterialSymbolData prefix;
        public MaterialSymbolData postfix;

        public ListItem.Alignment alignment;
        public ListItem.Size size;
        public ListItem.Shape shape;

        public bool enabled;

        public bool showSubtitle;
        public bool showPrefix;
        public bool showPostfix;

        public Action<ListItem> onClick;
    }

    public class ListItem : UIComponent<ListItem, ListItemData> , IPointerEnterHandler, IPointerExitHandler, IPointerDownHandler, IPointerUpHandler
    {
        public enum Size { SM, MD, LG, XL };
        public enum Shape { Round, Square };
        public enum Alignment { Horizontal, Vertical };

        [SerializeField] internal HVLayoutGroup _layout;
        [SerializeField] private UnityEngine.UI.Button _button;
        [SerializeField] private SDFQuad _sdf;
        [SerializeField] private Image _stateLayer;
        [SerializeField] private RectTransform _ripple;
        [SerializeField] private Icon _prefix;
        [SerializeField] private Icon _postfix;
        [SerializeField] private VerticalLayoutGroup _titleSubtitleLayout;
        [SerializeField] private Text _title;
        [SerializeField] private Text _subtitle;

        private event Action<bool> _onHoverStateChange;
        private event Action<(bool, PointerEventData)> _onPressStateChange;

        private float _defaultCornerRadius, _pressedCornerRadius;

        public string title
        {
            get => _title.binder.data.text;
            set => _title.binder.updateField(data => data.text, value);
        }

        public string subtitle
        {
            get => _subtitle.binder.data.text;
            set => _subtitle.binder.updateField(data => data.text, value);
        }
        
        public override void setupUI(UISettings uISettings)
        {
            _onHoverStateChange = null;
            _onPressStateChange = null;
            _defaultCornerRadius = 0f;
            _pressedCornerRadius = 0f;


            // apply color
            var hoverColor = uISettings.getColor(UISettings.ColorRole.OnSurface).withAlpha(0.1f);
            _ripple.GetComponent<Image>().color = hoverColor;
            _button.colors = new ColorBlock
            {
                normalColor = uISettings.getColor(UISettings.ColorRole.Surface),
                highlightedColor = hoverColor,
                pressedColor = hoverColor,
                disabledColor = Color.white.withAlpha(0f),
                selectedColor = hoverColor,
                colorMultiplier = 1.0f,
                fadeDuration = 0.1f
            };

            var labelColor = UISettings.ColorRole.OnSurface;
            var labelColor2 = UISettings.ColorRole.OnSurfaceVariant;
            var labelDisableColor = UISettings.ColorRole.OnSurface;
            //).withAlpha(0.38f);

            // apply ripple and shape-morph effect
            _onPressStateChange += state =>
            {
                if (!binder.data.enabled) { return; }

                var (pressed, eventData) = state;
                if (pressed) // pressed
                {
                    if (RectTransformUtility.ScreenPointToLocalPointInRectangle(rectTransform, eventData.position, eventData.pressEventCamera, out var localClickPosition))
                    {
                        animateRipple(localClickPosition, 0.3f);
                    }

                    animateShape(_pressedCornerRadius, 0.2f);
                }
                else
                {
                    animateShape(_defaultCornerRadius, 0.2f);
                }
            };



            #region DATA BINDING

            binder.bind(data => data.enabled, value =>
            {
                _button.interactable = value;

                var opacity = value ? 1.0f : 0.38f;
                _title.binder.updateField(data => data.colorRole, value ? labelColor : labelDisableColor);
                _subtitle.binder.updateField(data => data.colorRole, value ? labelColor2 : labelDisableColor);
                _prefix.binder.updateField(data => data.colorRole, value ? labelColor : labelDisableColor);
                _postfix.binder.updateField(data => data.colorRole, value ? labelColor : labelDisableColor);
                _title.binder.updateField(data => data.opacity, opacity);
                _subtitle.binder.updateField(data => data.opacity, opacity);
                _prefix.binder.updateField(data => data.opacity, opacity);
                _postfix.binder.updateField(data => data.opacity, opacity);
            });
            binder.bind(data => data.title, value => title = value);
            binder.bind(data => data.subtitle, value => subtitle = value);
            binder.bind(data => data.showPrefix, value => _prefix.gameObject.SetActive(value));
            binder.bind(data => data.showPostfix, value => _postfix.gameObject.SetActive(value));
            binder.bind(data => data.showSubtitle, value => _subtitle.gameObject.SetActive(value));
            binder.bind(data => data.onClick, value =>
            {
                _button.onClick.RemoveAllListeners();
                if (value != null)
                {
                    _button.onClick.AddListener(() => value.Invoke(this));
                }
            });
            binder.bind(data => data.prefix, value => _prefix.binder.updateField(data => data.symbol, value));
            binder.bind(data => data.postfix, value => _postfix.binder.updateField(data => data.symbol, value));
            binder.bind(data => data.size, value =>
            {
                // dependency
                var alignment = binder.data.alignment;

                switch (value)
                {
                    case Size.SM:
                    case Size.MD:
                    case Size.LG:
                        _layout.padding = new RectOffset { top = 8, left = 16, bottom = 8, right = 16 };
                        break;
                    case Size.XL:
                        _layout.padding = new RectOffset { top = 12, left = 0, bottom = 12, right = 16 };
                        break;
                }

                // spacing
                _layout.spacing = alignment == Alignment.Vertical ? 8.0f : 16.0f;
                rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, alignment == Alignment.Vertical ? 68.0f : 56.0f);

            }, dependsOn: data => data.alignment);
            binder.bind(data => data.alignment, value =>
            {
                switch (value)
                {
                    case Alignment.Horizontal:
                        _layout.isVertical = false;
                        _layout.childAlignment = TextAnchor.MiddleLeft;
                        _titleSubtitleLayout.childAlignment = TextAnchor.MiddleLeft;
                        break;
                    case Alignment.Vertical:
                        _layout.isVertical = true;
                        _layout.childAlignment = TextAnchor.MiddleCenter;
                        _titleSubtitleLayout.childAlignment = TextAnchor.MiddleCenter;
                        break;
                }

                LayoutRebuilder.MarkLayoutForRebuild(rectTransform);
            });
            binder.bind(data => data.shape, value =>
            {
                // dependency
                var size = binder.data.size;

                switch (size)
                {
                    case Size.SM:
                        _defaultCornerRadius = value switch
                        {
                            Shape.Square => 12.0f,
                            Shape.Round => rectTransform.sizeDelta.y * 0.5f,
                            _ => throw new NotImplementedException()
                        };
                        _pressedCornerRadius = 8f;
                        break;
                    case Size.MD:
                        _defaultCornerRadius = value switch
                        {
                            Shape.Square => 16.0f,
                            Shape.Round => rectTransform.sizeDelta.y * 0.5f,
                            _ => throw new NotImplementedException()
                        };
                        _pressedCornerRadius = 12f;
                        break;
                    case Size.LG:
                        _defaultCornerRadius = value switch
                        {
                            Shape.Square => 28.0f,
                            Shape.Round => rectTransform.sizeDelta.y * 0.5f,
                            _ => throw new NotImplementedException()
                        };
                        _pressedCornerRadius = 16f;
                        break;
                    case Size.XL:
                        _defaultCornerRadius = value switch
                        {
                            Shape.Square => 28.0f,
                            Shape.Round => rectTransform.sizeDelta.y * 0.5f,
                            _ => throw new NotImplementedException()
                        };
                        _pressedCornerRadius = 16f;
                        break;
                }

                _sdf.radius = _defaultCornerRadius;
            }, dependsOn: data => data.size);

            #endregion // DATA BINDING
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
        
        private void animateShape(float targetRadius, float duration)
        {
            // Kill any existing tweens on this object to prevent conflicts
            // We use the component instance as the tween ID
            DOTween.Kill(_sdf);

            DOTween.To(() => _sdf.radius, x => _sdf.radius = x, targetRadius, duration)
                .SetEase(Ease.OutQuad)
                .SetTarget(_sdf)
                .OnUpdate(() =>
                {
                    // IMPORTANT: We must call SetAllDirty() every frame the tween is running
                    // to make the UI update its visuals.
                    _sdf.SetAllDirty();
                });
        }
        
        private new void OnDestroy()
        {
            base.OnDestroy();
            
            DOTween.Kill(_sdf);
            DOTween.Kill(_ripple);
        }

        #endregion
    }
}