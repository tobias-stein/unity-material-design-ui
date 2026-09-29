using System;
using MaterialColorUtilities.Palettes;
using MaterialColorUtilities.Schemes;
using UnityEngine;

namespace mdu.ui
{
    [System.Serializable]
    public struct Scheme
    {
        public Color Primary;
        public Color OnPrimary;
        public Color PrimaryContainer;
        public Color OnPrimaryContainer;
        public Color Secondary;
        public Color OnSecondary;
        public Color SecondaryContainer;
        public Color OnSecondaryContainer;
        public Color Tertiary;
        public Color OnTertiary;
        public Color TertiaryContainer;
        public Color OnTertiaryContainer;
        public Color Error;
        public Color OnError;
        public Color ErrorContainer;
        public Color OnErrorContainer;
        public Color Background;
        public Color OnBackground;
        public Color Surface;
        public Color OnSurface;
        public Color SurfaceVariant;
        public Color OnSurfaceVariant;
        public Color Outline;
        public Color Shadow;
        public Color InverseSurface;
        public Color InverseOnSurface;
        public Color InversePrimary;
        public Color Surface1;
        public Color Surface2;
        public Color Surface3;
        public Color Surface4;
        public Color Surface5;
        public Color SurfaceDim;
        public Color SurfaceBright;
        public Color SurfaceContainerLowest;
        public Color SurfaceContainerLow;
        public Color SurfaceContainer;
        public Color SurfaceContainerHigh;
        public Color SurfaceContainerHighest;
        public Color OutlineVariant;

        public Scheme(CorePalette corePalette, bool isDark = false)
        {
            Scheme<uint> scheme = isDark ? new DarkSchemeMapper().Map(corePalette) : new LightSchemeMapper().Map(corePalette);
            Scheme<Color> schemeUnityColor = scheme.Convert(x => x.ToColor());

            Primary = schemeUnityColor.Primary;
            OnPrimary = schemeUnityColor.OnPrimary;
            PrimaryContainer = schemeUnityColor.PrimaryContainer;
            OnPrimaryContainer = schemeUnityColor.OnPrimaryContainer;
            Secondary = schemeUnityColor.Secondary;
            OnSecondary = schemeUnityColor.OnSecondary;
            SecondaryContainer = schemeUnityColor.SecondaryContainer;
            OnSecondaryContainer = schemeUnityColor.OnSecondaryContainer;
            Tertiary = schemeUnityColor.Tertiary;
            OnTertiary = schemeUnityColor.OnTertiary;
            TertiaryContainer = schemeUnityColor.TertiaryContainer;
            OnTertiaryContainer = schemeUnityColor.OnTertiaryContainer;
            Error = schemeUnityColor.Error;
            OnError = schemeUnityColor.OnError;
            ErrorContainer = schemeUnityColor.ErrorContainer;
            OnErrorContainer = schemeUnityColor.OnErrorContainer;
            Background = schemeUnityColor.Background;
            OnBackground = schemeUnityColor.OnBackground;
            Surface = schemeUnityColor.Surface;
            Surface1 = schemeUnityColor.Surface1;
            Surface2 = schemeUnityColor.Surface2;
            Surface3 = schemeUnityColor.Surface3;
            Surface4 = schemeUnityColor.Surface4;
            Surface5 = schemeUnityColor.Surface5;
            SurfaceDim = schemeUnityColor.SurfaceDim;
            SurfaceBright = schemeUnityColor.SurfaceBright;
            SurfaceContainerLow = schemeUnityColor.SurfaceContainerLow;
            SurfaceContainerLowest = schemeUnityColor.SurfaceContainerLowest;
            SurfaceContainer = schemeUnityColor.SurfaceContainer;
            SurfaceContainerHigh = schemeUnityColor.SurfaceContainerHigh;
            SurfaceContainerHighest = schemeUnityColor.SurfaceContainerHighest;
            OnSurface = schemeUnityColor.OnSurface;
            SurfaceVariant = schemeUnityColor.SurfaceVariant;
            OnSurfaceVariant = schemeUnityColor.OnSurfaceVariant;
            Outline = schemeUnityColor.Outline;
            Shadow = schemeUnityColor.Shadow;
            InverseSurface = schemeUnityColor.InverseSurface;
            InverseOnSurface = schemeUnityColor.InverseOnSurface;
            InversePrimary = schemeUnityColor.InversePrimary;
            OutlineVariant = schemeUnityColor.OutlineVariant;
        }
    }

    [CreateAssetMenu(fileName = "Colors", menuName = "UMDUI/Color Theme")]
    public class ColorTheme : ScriptableObject
    {
        public event Action onChanged;

        public Color SeedColor = Color.red;
        private Color _oldSeedColor = Color.red;

        public Style style = Style.Vibrant;

        public Scheme LightScheme;
        public Scheme DarkScheme;

        public void Generate()
        {
            CorePalette corePalette = CorePalette.Of(SeedColor.ToInt(), style);

            LightScheme = new Scheme(corePalette);
            DarkScheme = new Scheme(corePalette, true);

            _oldSeedColor = SeedColor;
        }

        public ColorTheme()
        {
            Generate();
        }

        public void OnEnable()
        {
            _oldSeedColor = SeedColor;
        }

        public void OnValidate()
        {
            if (_oldSeedColor != SeedColor)
            {
                Generate();
            }

            onChanged?.Invoke();
        }

        public ColorTheme clone()
        {
            var clone = ScriptableObject.CreateInstance<ColorTheme>();
            clone.SeedColor = this.SeedColor;
            clone.LightScheme = this.LightScheme;
            clone.DarkScheme = this.DarkScheme;
            return clone;
        }
    }
}