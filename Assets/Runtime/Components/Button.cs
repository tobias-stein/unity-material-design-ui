using System;
using com.convalise.UnityMaterialSymbols;
using Cysharp.Threading.Tasks;
using DG.Tweening;
using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace mdu.ui
{
    [Serializable]
    public struct ButtonData
    {
        public Button.Style style;
        public Button.Shape shape;
        public Button.Size size;
        public string text;
        public MaterialSymbolData icon;
        public bool showLabel;
        public bool showIcon;
        public bool iconRight;
        public bool enabled;
        public Vector4 individualCornerSize;
        public UnityEvent onClick;
        public int preferredWidth;
    }

    [RequireComponent(typeof(UnityEngine.UI.Button))]
    public class Button : UIComponent<Button, ButtonData>, IPointerEnterHandler, IPointerExitHandler, IPointerDownHandler, IPointerUpHandler
    {
        public enum Style { Filled, Elevated, Tonal, Outlined, Text }
        public enum Shape { Square, Round, Individual }
        public enum Size { XXS, XS, SM, MD, LG, XL }

        [SerializeField] private Text _label;
        [SerializeField] private Icon _icon;
        [SerializeField] private HorizontalLayoutGroup _layout;
        [SerializeField] private SDFQuad _sdf;
        [SerializeField] private Image _stateLayer;
        [SerializeField] private RectTransform _ripple;
        [SerializeField] private ContentSizeFitter _contentSizeFitter;

        private event Action<bool> _onHoverStateChange;
        private event Action<(bool, PointerEventData)> _onPressStateChange;

        private UnityEngine.UI.Button _button;

        private float _defaultCornerRadius, _pressedCornerRadius;

        private UISettings.ColorRole labelColorRole, labelDisableColorRole;
        public float labelOpacity;

        public string text
        {
            get => _label.binder.data.text;
            set => _label.binder.updateField(data => data.text, value);
        }

        public UISettings.TextRole textRole
        {
            get => _label.binder.data.textRole;
            set => _label.binder.updateField(data => data.textRole, value);
        }

        public UISettings.ColorRole textColorRole
        {
            get => _label.binder.data.colorRole;
            set => _label.binder.updateField(data => data.colorRole, value);
        }

        public UISettings.ColorRole iconColor
        {
            get => _icon.binder.data.colorRole;
            set => _icon.binder.updateField(data => data.colorRole, value);
        }

        public Icon.Size iconSize
        {
            get => _icon.binder.data.size;
            set => _icon.binder.updateField(data => data.size, value);
        }

        public MaterialSymbolData iconSymbol
        {
            get => _icon.binder.data.symbol;
            set => _icon.binder.updateField(data => data.symbol, value);
        }
        
        public new void Awake()
        {
            base.Awake();
            
            _button = GetComponent<UnityEngine.UI.Button>();
        }

        public override void setupUI(UISettings uiSettings)
        {
            _button = GetComponent<UnityEngine.UI.Button>();
            _button.hideFlags = HideFlags.HideInInspector;

            _sdf.outline = false;
            _sdf.shadow = false;
            _sdf.fillColor = Color.white;

            _onHoverStateChange = null;
            _onPressStateChange = null;
            _defaultCornerRadius = 0f;
            _pressedCornerRadius = 0f;

            labelColorRole = UISettings.ColorRole.OnSurface;
            labelDisableColorRole = UISettings.ColorRole.OnSurfaceVariant;
            labelOpacity = 1.0f;

            _onPressStateChange += state =>
            {
                if (!binder.data.enabled) { return; }

                // note: we defer this until the end of frame, so onClick handler have a chance to manipulate button data
                UniTask.WaitForEndOfFrame().ContinueWith(() =>
                {
                    var (pressed, eventData) = state;
                    if (pressed) // pressed
                    {
                        if (RectTransformUtility.ScreenPointToLocalPointInRectangle(rectTransform, eventData.position, eventData.pressEventCamera, out var localClickPosition))
                        {
                            animateRipple(localClickPosition, 0.3f);
                        }

                        switch (binder.data.shape)
                        {
                            case Shape.Square:
                            case Shape.Round:
                                animateShape(_pressedCornerRadius, 0.2f);
                                break;
                            case Shape.Individual:
                                animateShapeIndividual(Vector4.one * _pressedCornerRadius, 0.2f);
                                break;
                        }
                    }
                    else
                    {
                        switch (binder.data.shape)
                        {
                            case Shape.Square:
                            case Shape.Round:
                                animateShape(_defaultCornerRadius, 0.2f);
                                break;
                            case Shape.Individual:
                                animateShapeIndividual(binder.data.individualCornerSize, 0.2f);
                                break;
                        }
                    }
                });
            };


            #region DATA BINDING

            binder.bind(data => data.text, value => text = value);
            binder.bind(data => data.onClick, value =>
            {
                var onClick = new UnityEngine.UI.Button.ButtonClickedEvent();
                onClick.AddListener(() => value?.Invoke());
                _button.onClick = onClick;
            });
            binder.bind(data => data.icon, value => iconSymbol = value);
            binder.bind(data => data.enabled, value =>
            {
                textColorRole = iconColor = value ? labelColorRole : labelDisableColorRole;
                _label.binder.updateField(data => data.opacity, labelOpacity);
                _icon.binder.updateField(data => data.opacity, labelOpacity);

                _button.interactable = value;
            }, dependsOn: data => data.style);
            binder.bind(data => data.iconRight, value => _layout.reverseArrangement = value);
            binder.bind(data => data.showIcon, value => _icon.gameObject.SetActive(value));
            binder.bind(data => data.showLabel, value =>
            {
                // dependency field
                var size = binder.data.size;

                _label.gameObject.SetActive(value);
                if (value)
                {
                    var padding = uiSettings.GetSpacingInUnityUnits(size switch
                    {
                        Size.XS => UISettings.Spacing.XS,
                        Size.SM => UISettings.Spacing.SM,
                        Size.MD => UISettings.Spacing.MD,
                        Size.LG => UISettings.Spacing.LG,
                        Size.XL => UISettings.Spacing.XL,
                        _ => UISettings.Spacing.XS
                    });

                    _layout.padding = new RectOffset
                    {
                        top = 0,
                        left = (int)Mathf.Ceil(padding),
                        bottom = 0,
                        right = (int)Mathf.Ceil(padding),
                    };
                }
                else
                {
                    var padding = size switch
                    {
                        Size.XXS => 2,
                        Size.XS => 6,
                        Size.SM => 6,
                        Size.MD => 16,
                        Size.LG => 32,
                        Size.XL => 48,
                        _ => 6
                    };

                    _layout.padding = new RectOffset
                    {
                        top = padding,
                        left = padding,
                        bottom = padding,
                        right = padding,
                    };
                }

                _contentSizeFitter.verticalFit = value ? ContentSizeFitter.FitMode.Unconstrained : ContentSizeFitter.FitMode.PreferredSize;
            }, dependsOn: data => data.size);
            binder.bind(data => data.size, value =>
            {
                // dependency
                var shape = binder.data.shape;
                var individualCornerSize = binder.data.individualCornerSize;

                switch (value)
                {
                    case Size.XXS:
                        _layout.spacing = 2f;
                        iconSize = Icon.Size.XS;
                        textRole = UISettings.TextRole.LabelMedium;
                        rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, 16f);
                        _pressedCornerRadius = 4f;
                        break;
                    case Size.XS:
                        _layout.spacing = 4f;
                        iconSize = Icon.Size.SM;
                        textRole = UISettings.TextRole.BodyMedium;
                        rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, 32f);
                        _pressedCornerRadius = 8f;
                        break;
                    case Size.SM:
                        _layout.spacing = 8f;
                        iconSize = Icon.Size.MD;
                        textRole = UISettings.TextRole.TitleMedium;
                        rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, 40f);
                        _pressedCornerRadius = 8f;
                        break;
                    case Size.MD:
                        _layout.spacing = 8f;
                        iconSize = Icon.Size.LG;
                        textRole = UISettings.TextRole.HeadlineMedium;
                        rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, 56f);
                        _pressedCornerRadius = 12f;
                        break;
                    case Size.LG:
                        _layout.spacing = 12f;
                        iconSize = Icon.Size.XL;
                        textRole = UISettings.TextRole.DisplaySmall;
                        rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, 96f);
                        _pressedCornerRadius = 16f;
                        break;
                    case Size.XL:
                        _layout.spacing = 16f;
                        iconSize = Icon.Size.XL;
                        textRole = UISettings.TextRole.DisplayMedium;
                        rectTransform.sizeDelta = new Vector2(rectTransform.sizeDelta.x, 136f);
                        _pressedCornerRadius = 20f;
                        break;
                }
            });
            binder.bind(data => data.style, value =>
            {
                labelColorRole = UISettings.ColorRole.Primary;
                labelDisableColorRole = UISettings.ColorRole.OnSurface;
                labelOpacity = 1.0f;

                switch (value)
                {
                    case Style.Elevated:
                        _sdf.shadow = true;
                        _sdf.shadowColor = uiSettings.getColor(UISettings.ColorRole.Shadow);
                        _sdf.shadowOffset = new Vector2(0f, -2f);
                        _sdf.shadowWidth = 2f;
                        _sdf.shadowSoftness = 4f;
                        _sdf.shadowInnerSoftWidth = 1f;

                        _button.colors = new ColorBlock
                        {
                            normalColor = uiSettings.getColor(UISettings.ColorRole.SurfaceContainerLow),
                            highlightedColor = uiSettings.getColor(UISettings.ColorRole.SurfaceContainerLow),
                            pressedColor = uiSettings.getColor(UISettings.ColorRole.SurfaceContainerLow),
                            disabledColor = uiSettings.getColor(labelDisableColorRole).withAlpha(0.1f),
                            selectedColor = uiSettings.getColor(UISettings.ColorRole.SurfaceContainerLow),
                            colorMultiplier = 1.0f,
                            fadeDuration = 0.1f
                        };

                        _ripple.GetComponent<Image>().color = uiSettings.getColor(UISettings.ColorRole.Primary).withAlpha(0.1f);
                        _onHoverStateChange += hovered =>
                        {
                            if (hovered && binder.data.enabled)
                            {
                                _stateLayer.color = uiSettings.getColor(UISettings.ColorRole.Primary).withAlpha(0.1f);
                                animateShadow(uiSettings.getColor(UISettings.ColorRole.Shadow), new Vector2(0f, -4f), 4f, 0.2f);
                            }
                            else
                            {
                                _stateLayer.color = uiSettings.getColor(UISettings.ColorRole.Primary).withAlpha(0.0f);
                                animateShadow(uiSettings.getColor(UISettings.ColorRole.Shadow), new Vector2(0f, -2f), 4f, 0.2f);
                            }
                        };

                        break;
                    case Style.Filled:
                        labelColorRole = UISettings.ColorRole.OnPrimary;
                        _button.colors = new ColorBlock
                        {
                            normalColor = uiSettings.getColor(UISettings.ColorRole.Primary),
                            highlightedColor = uiSettings.getColor(UISettings.ColorRole.Primary),
                            pressedColor = uiSettings.getColor(UISettings.ColorRole.Primary),
                            disabledColor = uiSettings.getColor(labelDisableColorRole).withAlpha(0.1f),
                            selectedColor = uiSettings.getColor(UISettings.ColorRole.Primary),
                            colorMultiplier = 1.0f,
                            fadeDuration = 0.1f
                        };

                        _ripple.GetComponent<Image>().color = uiSettings.getColor(UISettings.ColorRole.OnPrimary).withAlpha(0.1f);
                        _onHoverStateChange += hovered =>
                        {
                            if (hovered && binder.data.enabled)
                            {
                                _stateLayer.color = uiSettings.getColor(UISettings.ColorRole.OnPrimary).withAlpha(0.1f);
                            }
                            else
                            {
                                _stateLayer.color = uiSettings.getColor(UISettings.ColorRole.OnPrimary).withAlpha(0.0f);
                            }
                        };
                        break;
                    case Style.Tonal:
                        labelColorRole = UISettings.ColorRole.OnSecondaryContainer;
                        _button.colors = new ColorBlock
                        {
                            normalColor = uiSettings.getColor(UISettings.ColorRole.SecondaryContainer),
                            highlightedColor = uiSettings.getColor(UISettings.ColorRole.SecondaryContainer),
                            pressedColor = uiSettings.getColor(UISettings.ColorRole.SecondaryContainer),
                            disabledColor = uiSettings.getColor(labelDisableColorRole).withAlpha(0.1f),
                            selectedColor = uiSettings.getColor(UISettings.ColorRole.SecondaryContainer),
                            colorMultiplier = 1.0f,
                            fadeDuration = 0.1f
                        };

                        _ripple.GetComponent<Image>().color = uiSettings.getColor(UISettings.ColorRole.OnSecondaryContainer).withAlpha(0.1f);
                        _onHoverStateChange += hovered =>
                        {
                            if (hovered && binder.data.enabled)
                            {
                                _stateLayer.color = uiSettings.getColor(UISettings.ColorRole.OnSecondaryContainer).withAlpha(0.1f);
                            }
                            else
                            {
                                _stateLayer.color = uiSettings.getColor(UISettings.ColorRole.OnSecondaryContainer).withAlpha(0.0f);
                            }
                        };
                        break;
                    case Style.Outlined:
                        _sdf.outline = true;
                        _sdf.outlineColor = uiSettings.getColor(UISettings.ColorRole.OutlineVariant);
                        _sdf.outlineWidth = UISettings.DpToUnityUnits(1.0f);
                        labelColorRole = UISettings.ColorRole.OnSurfaceVariant;

                        var containerDisabledColor = uiSettings.getColor(UISettings.ColorRole.OutlineVariant).withAlpha(0.1f);
                        var containerHoveredLayerColor = uiSettings.getColor(UISettings.ColorRole.OnSurfaceVariant).withAlpha(0.1f);
                        _ripple.GetComponent<Image>().color = containerHoveredLayerColor;
                        _sdf.fillColor = new Color(0f, 0f, 0f, 0.0f);
                        _button.colors = new ColorBlock
                        {
                            normalColor = Color.white,
                            highlightedColor = containerHoveredLayerColor,
                            pressedColor = containerHoveredLayerColor,
                            disabledColor = containerDisabledColor,
                            selectedColor = containerHoveredLayerColor,
                            colorMultiplier = 1.0f,
                            fadeDuration = 0.1f
                        };

                        break;
                    case Style.Text:
                        var colorHover = uiSettings.getColor(UISettings.ColorRole.Primary).withAlpha(0.1f);
                        _ripple.GetComponent<Image>().color = colorHover;
                        _button.colors = new ColorBlock
                        {
                            normalColor = new Color(1.0f, 1.0f, 1.0f, 0.0f),
                            highlightedColor = colorHover,
                            pressedColor = colorHover,
                            disabledColor = uiSettings.getColor(labelDisableColorRole).withAlpha(0.1f),
                            selectedColor = colorHover,
                            colorMultiplier = 1.0f,
                            fadeDuration = 0.1f
                        };
                        break;
                }
            });
            binder.bind(data => data.shape, value =>
            {
                // dependendcies
                var size = binder.data.size;
                var individualCornerSize = binder.data.individualCornerSize;

                _sdf.independent = value == Shape.Individual;


                switch (value)
                {
                    case Shape.Square:
                        _sdf.radius = _defaultCornerRadius = size switch
                        {
                            Size.XS => 12.0f,
                            Size.SM => 12.0f,
                            Size.MD => 16.0f,
                            Size.LG => 28.0f,
                            Size.XL => 28.0f,
                            _ => 12.0f
                        };
                        break;
                    case Shape.Round:
                        _sdf.radius = _defaultCornerRadius = rectTransform.sizeDelta.y * 0.5f;
                        break;
                    case Shape.Individual:
                        _sdf.radiusX = individualCornerSize.x;
                        _sdf.radiusY = individualCornerSize.y;
                        _sdf.radiusZ = individualCornerSize.z;
                        _sdf.radiusW = individualCornerSize.w;
                        break;
                }
                
            }, data => data.size, data => data.individualCornerSize);
            binder.bind(data => data.preferredWidth, value =>
            {
                _contentSizeFitter.horizontalFit = value > 0 ? ContentSizeFitter.FitMode.Unconstrained : ContentSizeFitter.FitMode.PreferredSize;
                if(value > 0)
                {   
                    rectTransform.sizeDelta = new Vector2(value, rectTransform.sizeDelta.y);
                } 
            });
            #endregion
        }

        public new void OnEnable()
        {
            gameObject.GetComponent<ContentSizeFitter>().enabled = true;
            base.OnEnable();
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

        private void animateShadow(Color targetColor, Vector2 targetOffset, float targetSoftness, float duration)
        {
            // Kill any existing tweens on this object to prevent conflicts
            // We use the component instance as the tween ID
            DOTween.Kill(_sdf);

            // Tween Shadow Color
            DOTween.To(() => _sdf.shadowColor, x => _sdf.shadowColor = x, targetColor, duration)
                .SetEase(Ease.OutQuad)
                .SetTarget(_sdf); // Link tween to this object

            // Tween Shadow Offset
            DOTween.To(() => _sdf.shadowOffset, x => _sdf.shadowOffset = x, targetOffset, duration)
                .SetEase(Ease.OutQuad)
                .SetTarget(_sdf);

            // Tween Shadow Softness
            // This tween will also be responsible for updating the UI every frame
            DOTween.To(() => _sdf.shadowSoftness, x => _sdf.shadowSoftness = x, targetSoftness, duration)
                .SetEase(Ease.OutQuad)
                .SetTarget(_sdf)
                .OnUpdate(() =>
                {
                    // IMPORTANT: We must call SetAllDirty() every frame the tween is running
                    // to make the UI update its visuals.
                    _sdf.SetAllDirty();
                });
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

        private void animateShapeIndividual(Vector4 target, float duration)
        {
            DOTween.Kill(_sdf);

            DOTween.To(() => new Vector4(_sdf.radiusX, _sdf.radiusY, _sdf.radiusZ, _sdf.radiusW), x => { _sdf.radiusX = x.x; _sdf.radiusY = x.y; _sdf.radiusZ = x.z; _sdf.radiusW = x.z; }, target, duration)
                .SetEase(Ease.OutQuad)
                .SetTarget(_sdf)
                .OnUpdate(() =>
                {
                    // IMPORTANT: We must call SetAllDirty() every frame the tween is running
                    // to make the UI update its visuals.
                    _sdf.SetAllDirty();
                });
        }

        #endregion

        private new void OnDestroy()
        {
            base.OnDestroy();

            DOTween.Kill(_sdf);
            DOTween.Kill(_ripple);
        }
    }
}