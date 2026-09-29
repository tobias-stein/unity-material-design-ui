using System;
using TMPro;
using UnityEngine;

namespace mdu.ui
{
    [CreateAssetMenu(fileName = "SpacesSizes", menuName = "UMDUI/Space and Size Theme")]
    public class SpaceSizeTheme : ScriptableObject
    {
        public event Action onChanged;

        [System.Serializable]
        public struct SpacingSet
        {
            [Header("Base Spacing (8dp grid system)")]
            public float xs;      // Extra small
            public float sm;      // Small  
            public float md;      // Medium
            public float lg;      // Large
            public float xl;      // Extra large
            public float xxl;     // Extra extra large

            [Header("Component Spacing")]
            public float componentPadding;
            public float sectionMargin;
            public float screenMargin;

            public SpacingSet(float xsVal, float smVal, float mdVal, float lgVal, float xlVal, float xxlVal,
                            float compPadding, float sectMargin, float scrMargin)
            {
                xs = xsVal;
                sm = smVal;
                md = mdVal;
                lg = lgVal;
                xl = xlVal;
                xxl = xxlVal;
                componentPadding = compPadding;
                sectionMargin = sectMargin;
                screenMargin = scrMargin;
            }
        }

        [System.Serializable]
        public struct SizeSet
        {
            [Header("Touch/Click Targets")]
            public float minTouchTarget;
            public float minClickTarget;

            [Header("Icon Sizes")]
            public float iconSm;
            public float iconMd;
            public float iconLg;

            [Header("Component Heights")]
            public float buttonHeight;
            public float inputHeight;
            public float toolbarHeight;
            public float bottomNavHeight;
            public float navRailWidth;

            [Header("Content Constraints")]
            public float contentMaxWidth;
            public float cardMinWidth;

            public SizeSet(float touchTarget, float clickTarget, float icSm, float icMd, float icLg,
                          float btnHeight, float inHeight, float tbHeight, float bnHeight, float nrWidth,
                          float maxWidth, float cardWidth)
            {
                minTouchTarget = touchTarget;
                minClickTarget = clickTarget;
                iconSm = icSm;
                iconMd = icMd;
                iconLg = icLg;
                buttonHeight = btnHeight;
                inputHeight = inHeight;
                toolbarHeight = tbHeight;
                bottomNavHeight = bnHeight;
                navRailWidth = nrWidth;
                contentMaxWidth = maxWidth;
                cardMinWidth = cardWidth;
            }
        }

        [Header("Mobile Spacing & Sizing")]
        [SerializeField] private SpacingSet mobileSpacing = new SpacingSet(4f, 8f, 16f, 24f, 32f, 48f, 16f, 24f, 16f);
        [SerializeField] private SizeSet mobileSizes = new SizeSet(48f, 48f, 16f, 24f, 32f, 48f, 56f, 56f, 80f, 0f, 0f, 280f);

        [Header("Tablet Spacing & Sizing")]
        [SerializeField] private SpacingSet tabletSpacing = new SpacingSet(6f, 12f, 24f, 36f, 48f, 72f, 24f, 36f, 24f);
        [SerializeField] private SizeSet tabletSizes = new SizeSet(48f, 48f, 20f, 28f, 40f, 52f, 64f, 64f, 72f, 0f, 840f, 320f);

        [Header("Desktop Spacing & Sizing")]
        [SerializeField] private SpacingSet desktopSpacing = new SpacingSet(8f, 16f, 32f, 48f, 64f, 96f, 32f, 48f, 32f);
        [SerializeField] private SizeSet desktopSizes = new SizeSet(48f, 32f, 24f, 32f, 48f, 40f, 48f, 48f, 0f, 80f, 1200f, 360f);


        /// <summary>
        /// Gets spacing configuration for specific device type
        /// </summary>
        public SpacingSet GetSpacingForDevice(UISettings.DeviceType deviceType)
        {
            return deviceType switch
            {
                UISettings.DeviceType.Mobile => mobileSpacing,
                UISettings.DeviceType.Tablet => tabletSpacing,
                UISettings.DeviceType.Desktop => desktopSpacing,
                _ => mobileSpacing
            };
        }

        /// <summary>
        /// Gets size configuration for specific device type
        /// </summary>
        public SizeSet GetSizesForDevice(UISettings.DeviceType deviceType)
        {
            return deviceType switch
            {
                UISettings.DeviceType.Mobile => mobileSizes,
                UISettings.DeviceType.Tablet => tabletSizes,
                UISettings.DeviceType.Desktop => desktopSizes,
                _ => mobileSizes
            };
        }


        // Reset to default values
        [ContextMenu("Reset to Material Design Defaults")]
        private void ResetToDefaults()
        {
            mobileSpacing = new SpacingSet(4f, 8f, 16f, 24f, 32f, 48f, 16f, 24f, 16f);
            mobileSizes = new SizeSet(48f, 48f, 16f, 24f, 32f, 48f, 56f, 56f, 80f, 0f, 0f, 280f);
            tabletSpacing = new SpacingSet(6f, 12f, 24f, 36f, 48f, 72f, 24f, 36f, 24f);
            tabletSizes = new SizeSet(48f, 48f, 20f, 28f, 40f, 52f, 64f, 64f, 72f, 0f, 840f, 320f);
            desktopSpacing = new SpacingSet(8f, 16f, 32f, 48f, 64f, 96f, 32f, 48f, 32f);
            desktopSizes = new SizeSet(48f, 32f, 24f, 32f, 48f, 40f, 48f, 48f, 0f, 80f, 1200f, 360f);
        }

        public void OnValidate()
        {
            onChanged?.Invoke();
        }

        public SpaceSizeTheme clone()
        {
            var clone = ScriptableObject.CreateInstance<SpaceSizeTheme>();
            clone.mobileSizes = this.mobileSizes;
            clone.mobileSpacing = this.mobileSpacing;
            clone.tabletSizes = this.tabletSizes;
            clone.tabletSpacing = this.tabletSpacing;
            clone.desktopSizes = this.desktopSizes;
            clone.desktopSpacing = this.desktopSpacing;
            return clone;
        }
    }
}