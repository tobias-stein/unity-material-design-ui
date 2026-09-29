using UnityEngine;

namespace mdu
{
    public static class ColorExtensions
    {
        public static Color withAlpha(this Color color, float alpha)
        {
            color.a = alpha;
            return color;
        }

        public static uint ToInt(this Color color)
        {
            var r = (uint)(color.r * 255);
            var g = (uint)(color.g * 255);
            var b = (uint)(color.b * 255);
            return (uint)((255 << 24) | (r << 16) | (g << 8) | b);
        }

        public static Color ToColor(this uint argb)
        {
            float a = ((argb >> 24) & 0xFF) / 255f;
            float r = ((argb >> 16) & 0xFF) / 255f;
            float g = ((argb >> 8)  & 0xFF) / 255f;
            float b = (argb & 0xFF) / 255f;
            return new Color(r, g, b, a);
        }
    }
}