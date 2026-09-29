using System;
using TMPro;
using UnityEngine;

namespace mdu.ui
{
    /// <summary>
    /// A data container for all the properties of a single Material Design text style.
    /// Making this a struct ensures it's treated as a value type.
    /// </summary>
    [System.Serializable]
    public struct TextStyle
    {
        [Tooltip("The TMPro Font Asset to be used. All styles can share the same asset if it has linked weights.")]
        public TMP_FontAsset font;

        [Tooltip("The size of the font in points.")]
        public float fontSize;

        [Tooltip("The font weight (e.g., Regular, Medium, Bold). Requires linked font assets.")]
        public FontWeight fontWeight;

        [Tooltip("Additional font styles like Italic.")]
        public FontStyles fontStyle;

        [Tooltip("Tracking (the space between characters). Value is in thousandths of an em.")]
        public float characterSpacing;

        [Tooltip("Leading (the space between lines).")]
        public float lineSpacing;
    }

    [CreateAssetMenu(fileName = "TypographyTheme", menuName = "UMDUI/Typography Theme")]
    public class TypographyTheme : ScriptableObject
    {
        public event Action onChanged;

        public TMP_FontAsset font;

        // The existing fields remain unchanged
        [Header("Display Styles")]
        public TextStyle displayLarge;
        public TextStyle displayMedium;
        public TextStyle displaySmall;

        [Header("Headline Styles")]
        public TextStyle headlineLarge;
        public TextStyle headlineMedium;
        public TextStyle headlineSmall;

        [Header("Title Styles")]
        public TextStyle titleLarge;
        public TextStyle titleMedium;
        public TextStyle titleSmall;

        [Header("Body Styles")]
        public TextStyle bodyLarge;
        public TextStyle bodyMedium;
        public TextStyle bodySmall;

        [Header("Label Styles")]
        public TextStyle labelLarge;
        public TextStyle labelMedium;
        public TextStyle labelSmall;

        public TypographyTheme()
        {
            // Display
            displayLarge = new TextStyle { font = font, fontSize = 57, fontWeight = FontWeight.Regular, characterSpacing = -0.25f };
            displayMedium = new TextStyle { font = font, fontSize = 45, fontWeight = FontWeight.Regular };
            displaySmall = new TextStyle { font = font, fontSize = 36, fontWeight = FontWeight.Regular };

            // Headline
            headlineLarge = new TextStyle { font = font, fontSize = 32, fontWeight = FontWeight.Regular };
            headlineMedium = new TextStyle { font = font, fontSize = 28, fontWeight = FontWeight.Regular };
            headlineSmall = new TextStyle { font = font, fontSize = 24, fontWeight = FontWeight.Regular };

            // Title
            titleLarge = new TextStyle { font = font, fontSize = 22, fontWeight = FontWeight.Regular };
            titleMedium = new TextStyle { font = font, fontSize = 16, fontWeight = FontWeight.Medium, characterSpacing = 0.15f };
            titleSmall = new TextStyle { font = font, fontSize = 14, fontWeight = FontWeight.Medium, characterSpacing = 0.1f };

            // Body
            bodyLarge = new TextStyle { font = font, fontSize = 16, fontWeight = FontWeight.Regular, characterSpacing = 0.5f };
            bodyMedium = new TextStyle { font = font, fontSize = 14, fontWeight = FontWeight.Regular, characterSpacing = 0.25f };
            bodySmall = new TextStyle { font = font, fontSize = 12, fontWeight = FontWeight.Regular, characterSpacing = 0.4f };

            // Label
            labelLarge = new TextStyle { font = font, fontSize = 14, fontWeight = FontWeight.Medium, characterSpacing = 0.1f };
            labelMedium = new TextStyle { font = font, fontSize = 12, fontWeight = FontWeight.Medium, characterSpacing = 0.5f };
            labelSmall = new TextStyle { font = font, fontSize = 11, fontWeight = FontWeight.Medium, characterSpacing = 0.5f };
        }

        public void OnValidate()
        {
            onChanged?.Invoke();
        }

        public TypographyTheme clone()
        {
            var clone = ScriptableObject.CreateInstance<TypographyTheme>();
            clone.displayLarge = this.displayLarge;
            clone.displayMedium = this.displayMedium;
            clone.displaySmall = this.displaySmall;
            clone.headlineLarge = this.headlineLarge;
            clone.headlineMedium = this.headlineMedium;
            clone.headlineSmall = this.headlineSmall;
            clone.titleLarge = this.titleLarge;
            clone.titleMedium = this.titleMedium;
            clone.titleSmall = this.titleSmall;
            clone.bodyLarge = this.bodyLarge;
            clone.bodyMedium = this.bodyMedium;
            clone.bodySmall = this.bodySmall;
            clone.labelLarge = this.labelLarge;
            clone.labelMedium = this.labelMedium;
            clone.labelSmall = this.labelSmall;
            return clone;
        }
    }
}