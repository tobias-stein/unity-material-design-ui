using System;
using TMPro;
using UnityEngine;

namespace mdu.ui
{
    [CreateAssetMenu(fileName = "UISettings", menuName = "UMDUI/Settings")]
    public class UISettings : ScriptableObject
    {
        public event Action<UISettings> onChanged;

#if UNITY_EDITOR

        private static UISettings _current;
        public static UISettings current
        {
            get
            {
                if (_current == null)
                {
                    _current = Resources.Load<UISettings>("Settings/UISettings");
                }

                return _current;
            }
        }


#endif // UNITY_EDITOR

        [System.Serializable]
        public struct BreakpointConfig
        {
            [Header("Breakpoint Thresholds (pixels)")]
            public int mobileMax;    // 0 to this value
            public int tabletMax;    // mobileMax+1 to this value
                                     // tabletMax+1 and above is desktop

            public BreakpointConfig(int mobMax, int tabMax)
            {
                mobileMax = mobMax;
                tabletMax = tabMax;
            }
        }

        public enum DeviceType
        {
            None,
            Mobile,
            Tablet,
            Desktop
        }

        public enum Spacing
        {
            None, XS, SM, MD, LG, XL, XXL
        }

        public enum Sizing
        {
            IconSm, IconMd, IconLg, ButtonHeight, InputHeight, ToolbarHeight, TouchTarget
        }

        public enum TextRole
        {
            DisplayLarge, DisplayMedium, DisplaySmall,
            HeadlineLarge, HeadlineMedium, HeadlineSmall,
            TitleLarge, TitleMedium, TitleSmall,
            BodyLarge, BodyMedium, BodySmall,
            LabelLarge, LabelMedium, LabelSmall
        }

        public enum ColorRole
        {
            // Grouped for readability
            // Primary Family
            Primary, OnPrimary, PrimaryContainer, OnPrimaryContainer,

            // Secondary Family
            Secondary, OnSecondary, SecondaryContainer, OnSecondaryContainer,

            // Tertiary Family
            Tertiary, OnTertiary, TertiaryContainer, OnTertiaryContainer,

            // Error Family
            Error, OnError, ErrorContainer, OnErrorContainer,

            // Surface & Background Family
            Background, OnBackground,
            Surface, OnSurface, SurfaceVariant, OnSurfaceVariant,
            SurfaceDim, SurfaceBright,
            SurfaceContainer,
            SurfaceContainerLow, SurfaceContainerLowest,
            SurfaceContainerHigh, SurfaceContainerHighest,

            Surface1, Surface2, Surface3, Surface4, Surface5,

            // Other Roles
            Outline, OutlineVariant,
            Shadow, InverseSurface, InverseOnSurface, InversePrimary,

            Customized
        }

        [Header("Breakpoint Configuration")]
        [SerializeField] private BreakpointConfig _breakpoints = new BreakpointConfig(599, 1199);

        [SerializeField] private bool _useDarkTheme;
        [SerializeField] private ColorTheme _colors;
        private ColorTheme _oldColorsRef;

        [SerializeField] private TypographyTheme _typography;
        private TypographyTheme _oldTypographyRef;
        [SerializeField] private SpaceSizeTheme _spacesSizes;
        private SpaceSizeTheme _oldSpaceSizeTheme;

        [SerializeField] private DeviceType _defaultDeviceType = DeviceType.None;

        // Cached current device type to avoid recalculating every frame
        private DeviceType? cachedDeviceType = null;
        private Vector2 lastScreenSize = Vector2.zero;
        private bool _refreshPending;

        /// <summary>
        /// Gets the current device type based on screen width
        /// </summary>
        public DeviceType CurrentDeviceType
        {
            get
            {
                if (_defaultDeviceType != DeviceType.None)
                {
                    return _defaultDeviceType;    
                }

                Vector2 currentScreenSize = new Vector2(Screen.width, Screen.height);

                // Only recalculate if screen size changed
                if (cachedDeviceType == null || lastScreenSize != currentScreenSize)
                {
                    lastScreenSize = currentScreenSize;
                    cachedDeviceType = DetermineDeviceType(Screen.width);
                }

                return cachedDeviceType.Value;
            }
        }

        /// <summary>
        /// Gets spacing values for current device type
        /// </summary>
        private SpaceSizeTheme.SpacingSet CurrentSpacing => _spacesSizes.GetSpacingForDevice(CurrentDeviceType);

        /// <summary>
        /// Gets size values for current device type  
        /// </summary>
        private SpaceSizeTheme.SizeSet CurrentSizes => _spacesSizes.GetSizesForDevice(CurrentDeviceType);


        public bool useDarkTheme
        {
            get => _useDarkTheme;
            set
            {
                _useDarkTheme = value;
                onChanged?.Invoke(this);
            }
        }

        public Color seedColor
        {
            get => _colors.SeedColor;
            set
            {
                _colors.SeedColor = value;
                _colors.Generate();
                onChanged?.Invoke(this);
            }
        }


        public UISettings clone()
        {
            var clone = ScriptableObject.CreateInstance<UISettings>();
            clone._breakpoints = this._breakpoints;
            clone._colors = this._colors.clone();
            clone._spacesSizes = this._spacesSizes.clone();
            clone._typography = this._typography.clone();
            clone._defaultDeviceType = this._defaultDeviceType;
            clone._useDarkTheme = this._useDarkTheme;

            clone.OnValidate();
            return clone;
        }

        private void OnDisable()
        {
            if (_oldColorsRef != null)
            {
                _oldColorsRef.onChanged -= OnValidate;
            }
            if (_oldTypographyRef != null)
            {
                _oldTypographyRef.onChanged -= OnValidate;
            }
            if (_oldSpaceSizeTheme != null)
            {
                _oldSpaceSizeTheme.onChanged -= OnValidate;
            }
        }

        public void OnValidate()
        {
            if (_oldColorsRef != null)
            {
                _oldColorsRef.onChanged -= OnValidate;
            }
            if (_oldTypographyRef != null)
            {
                _oldTypographyRef.onChanged -= OnValidate;
            }
            if (_oldSpaceSizeTheme != null)
            {
                _oldSpaceSizeTheme.onChanged -= OnValidate;
            }
            _colors.onChanged += OnValidate;
            _typography.onChanged += OnValidate;
            _spacesSizes.onChanged += OnValidate;
            _oldColorsRef = _colors;
            _oldTypographyRef = _typography;
            _oldSpaceSizeTheme = _spacesSizes;

            if (_breakpoints.mobileMax <= 0) _breakpoints.mobileMax = 599;
            if (_breakpoints.tabletMax <= _breakpoints.mobileMax) _breakpoints.tabletMax = 1199;

#if UNITY_EDITOR
            if (!_refreshPending)
            {
                _refreshPending = true;
                UnityEditor.EditorApplication.delayCall += () =>
                {
                    _refreshPending = false;
                    if (this == null) { return; }
                    onChanged?.Invoke(this);
                };
            }
#else
            onChanged?.Invoke(this);
#endif
        }


        /// <summary>
        /// Determines device type based on screen width
        /// </summary>
        /// <param name="screenWidth">Screen width in pixels</param>
        /// <returns>Device type classification</returns>
        public DeviceType DetermineDeviceType(int screenWidth)
        {
            if (screenWidth <= _breakpoints.mobileMax)
                return DeviceType.Mobile;
            else if (screenWidth <= _breakpoints.tabletMax)
                return DeviceType.Tablet;
            else
                return DeviceType.Desktop;
        }

        /// <summary>
        /// Gets appropriate touch target size for current device
        /// </summary>
        private float GetTouchTargetSize()
        {
            var sizes = CurrentSizes;
            return CurrentDeviceType == DeviceType.Desktop ? sizes.minClickTarget : sizes.minTouchTarget;
        }

        /// <summary>
        /// Gets spacing value converted to Unity units
        /// </summary>
        internal float GetSpacingInUnityUnits(Spacing spacingSize)
        {
            var spacing = CurrentSpacing;
            float dpValue = spacingSize switch
            {
                Spacing.None => 0,
                Spacing.XS => spacing.xs,
                Spacing.SM => spacing.sm,
                Spacing.MD => spacing.md,
                Spacing.LG => spacing.lg,
                Spacing.XL => spacing.xl,
                Spacing.XXL => spacing.xxl,
                _ => spacing.md
            };

            return DpToUnityUnits(dpValue);
        }

        /// <summary>
        /// Gets size value converted to Unity units
        /// </summary>
        internal float GetSizeInUnityUnits(Sizing componentSize)
        {
            var sizes = CurrentSizes;
            float dpValue = componentSize switch
            {
                Sizing.IconSm => sizes.iconSm,
                Sizing.IconMd => sizes.iconMd,
                Sizing.IconLg => sizes.iconLg,
                Sizing.ButtonHeight => sizes.buttonHeight,
                Sizing.InputHeight => sizes.inputHeight,
                Sizing.ToolbarHeight => sizes.toolbarHeight,
                Sizing.TouchTarget => GetTouchTargetSize(),
                _ => sizes.buttonHeight
            };

            return DpToUnityUnits(dpValue);
        }

        internal TextStyle getTextStyle(TextRole role)
        { 
            // Use a switch to find the correct style from the theme asset
            switch (role)
            {
                case TextRole.DisplayLarge:   return _typography.displayLarge;
                case TextRole.DisplayMedium:  return _typography.displayMedium;
                case TextRole.DisplaySmall:   return _typography.displaySmall;
                case TextRole.HeadlineLarge:  return _typography.headlineLarge;
                case TextRole.HeadlineMedium: return _typography.headlineMedium;
                case TextRole.HeadlineSmall:  return _typography.headlineSmall;
                case TextRole.TitleLarge:     return _typography.titleLarge;
                case TextRole.TitleMedium:    return _typography.titleMedium;
                case TextRole.TitleSmall:     return _typography.titleSmall;
                case TextRole.BodyLarge:      return _typography.bodyLarge;
                case TextRole.BodyMedium:     return _typography.bodyMedium;
                case TextRole.BodySmall:      return _typography.bodySmall;
                case TextRole.LabelLarge:     return _typography.labelLarge;
                case TextRole.LabelMedium:    return _typography.labelMedium;
                case TextRole.LabelSmall:     return _typography.labelSmall;
                default:
                    Debug.LogError($"UISettings.TextRole {role} not handled.");
                    return _typography.bodyMedium;
            }
        }

        internal Color getColor(ColorRole role)
        { 
            Scheme scheme = _useDarkTheme ? _colors.DarkScheme : _colors.LightScheme;

            switch (role)
            {
                case ColorRole.Primary: return scheme.Primary;
                case ColorRole.OnPrimary: return scheme.OnPrimary;
                case ColorRole.PrimaryContainer: return scheme.PrimaryContainer;
                case ColorRole.OnPrimaryContainer: return scheme.OnPrimaryContainer;
                case ColorRole.Secondary: return scheme.Secondary;
                case ColorRole.OnSecondary: return scheme.OnSecondary;
                case ColorRole.SecondaryContainer: return scheme.SecondaryContainer;
                case ColorRole.OnSecondaryContainer: return scheme.OnSecondaryContainer;
                case ColorRole.Tertiary: return scheme.Tertiary;
                case ColorRole.OnTertiary: return scheme.OnTertiary;
                case ColorRole.TertiaryContainer: return scheme.TertiaryContainer;
                case ColorRole.OnTertiaryContainer: return scheme.OnTertiaryContainer;
                case ColorRole.Error: return scheme.Error;
                case ColorRole.OnError: return scheme.OnError;
                case ColorRole.ErrorContainer: return scheme.ErrorContainer;
                case ColorRole.OnErrorContainer: return scheme.OnErrorContainer;
                case ColorRole.Background: return scheme.Background;
                case ColorRole.OnBackground: return scheme.OnBackground;
                case ColorRole.Surface: return scheme.Surface;
                case ColorRole.Surface1: return scheme.Surface1;
                case ColorRole.Surface2: return scheme.Surface2;
                case ColorRole.Surface3: return scheme.Surface3;
                case ColorRole.Surface4: return scheme.Surface4;
                case ColorRole.Surface5: return scheme.Surface5;
                case ColorRole.OnSurface: return scheme.OnSurface;
                case ColorRole.SurfaceVariant: return scheme.SurfaceVariant;
                case ColorRole.OnSurfaceVariant: return scheme.OnSurfaceVariant;
                case ColorRole.Outline: return scheme.Outline;
                case ColorRole.Shadow: return scheme.Shadow;
                case ColorRole.InverseSurface: return scheme.InverseSurface;
                case ColorRole.InverseOnSurface: return scheme.InverseOnSurface;
                case ColorRole.InversePrimary: return scheme.InversePrimary;
                case ColorRole.OutlineVariant: return scheme.OutlineVariant;
                case ColorRole.SurfaceDim: return scheme.SurfaceDim;
                case ColorRole.SurfaceBright: return scheme.SurfaceBright;
                case ColorRole.SurfaceContainer: return scheme.SurfaceContainer;
                case ColorRole.SurfaceContainerLow: return scheme.SurfaceContainerLow;
                case ColorRole.SurfaceContainerLowest: return scheme.SurfaceContainerLowest;
                case ColorRole.SurfaceContainerHigh: return scheme.SurfaceContainerHigh;
                case ColorRole.SurfaceContainerHighest: return scheme.SurfaceContainerHighest;
                default:
                    Debug.LogWarning($"Color role {role} not found!");
                    return Color.magenta; // Return a noticeable color for debugging
            }
        }

        /// <summary>
        /// Force refresh of cached device type (useful after screen orientation changes)
        /// </summary>
        public void RefreshDeviceType()
        {
            cachedDeviceType = null;
        }

        /// <summary>
        /// Converts dp values to Unity units based on reference DPI
        /// </summary>
        /// <param name="dpValue">Value in density-independent pixels</param>
        /// <param name="referenceDpi">Reference DPI (default 160 for Android)</param>
        /// <returns>Value in Unity units</returns>
        public static float DpToUnityUnits(float dpValue, float referenceDpi = 160f)
        {
            return dpValue;// * (Screen.dpi > 0 ? Screen.dpi / referenceDpi : 1f);
        }
    }

    public static class UISettingsExtensions
    {
        public static void applySize(this RectTransform rectTransform, UISettings uISettings, UISettings.Sizing size)
        {
            float _size = uISettings.GetSizeInUnityUnits(size);
            rectTransform.sizeDelta = new Vector2(_size, _size);
        }

        public static void applySpacing(this RectTransform rectTransform, UISettings uISettings, UISettings.Spacing spacing, Vector2 direction)
        {
            float spacingValue = uISettings.GetSpacingInUnityUnits(spacing);
            rectTransform.anchoredPosition = direction * spacingValue;
        }

        public static void applyFont(this TMP_Text text, UISettings uISettings, UISettings.TextRole role)
        {
            TextStyle styleToApply = uISettings.getTextStyle(role);

            // Apply all properties from the style to the text component
            text.font = styleToApply.font;
            text.fontSize = styleToApply.fontSize;
            text.fontWeight = styleToApply.fontWeight;
            text.fontStyle = styleToApply.fontStyle;
            text.characterSpacing = styleToApply.characterSpacing;
            text.lineSpacing = styleToApply.lineSpacing;

            // Ensure the component updates its visual representation
            text.SetAllDirty();
        }

        public static void applyColor(this TMP_Text text, UISettings uISettings, UISettings.ColorRole role)
        {
            text.color = uISettings.getColor(role);
            // Ensure the component updates its visual representation
            text.SetAllDirty();
        }
        
        public static void applyColor(this UnityEngine.UI.Image image, UISettings uISettings, UISettings.ColorRole role)
        {
            image.color = uISettings.getColor(role);
            // Ensure the component updates its visual representation
            image.SetAllDirty();
        }
    }
}