using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;

namespace mdu
{
    public static class GizmosExtensions
    {
        public static void DrawWireCircle(Vector3 center, float radius)
        {
            const int steps = 64;
            const float angleStep = 360.0f / steps;

            // Find the first point on the circle.
            Vector3 previousPoint = center + new Vector3(radius, 0, 0);

            for (int i = 1; i <= steps; i++)
            {
                float angle = i * angleStep;

                // Calculate the next point's position on the circle using trigonometry.
                // We use Cosine for the X-axis and Sine for the Y-axis to draw on the XY plane.
                Vector3 nextPoint;
                nextPoint.x = center.x + radius * Mathf.Cos(angle * Mathf.Deg2Rad);
                nextPoint.y = center.y + radius * Mathf.Sin(angle * Mathf.Deg2Rad);
                nextPoint.z = center.z; // Keep the Z coordinate constant.

                // Draw a line from the previous point to the new point.
                Gizmos.DrawLine(previousPoint, nextPoint);

                // The current point becomes the previous point for the next iteration.
                previousPoint = nextPoint;
            }
        }
    }
}

#endif // UNITY_EDITOR