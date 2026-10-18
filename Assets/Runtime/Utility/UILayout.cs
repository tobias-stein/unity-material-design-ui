using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace mdu.ui
{
    /// <summary>
    /// Synchronous layout flush helpers.
    ///
    /// <see cref="LayoutRebuilder.ForceRebuildLayoutImmediate"/> only walks
    /// subtrees whose RectTransforms carry an enabled ILayoutController (its
    /// internal PerformLayoutControl/PerformLayoutCalculation bail out on nodes
    /// without one). Calling it on a plain root — e.g. a view's RectTransform —
    /// therefore silently does nothing. These helpers instead (1) drain Unity's
    /// canvas update queues and (2) rebuild every real layout root inside the
    /// subtree, parents before children.
    /// </summary>
    public static class UILayout
    {
        /// <summary>
        /// Makes the layout of <paramref name="root"/>'s subtree current
        /// immediately, without waiting for the next canvas update.
        /// </summary>
        public static void forceNow(RectTransform root)
        {
            if (root == null)
            {
                return;
            }

            // Drains everything layout groups / ContentSizeFitters / text
            // components registered via MarkLayoutForRebuild (enable, dirty,
            // text change, ...), so queued work is applied before we read rects.
            Canvas.ForceUpdateCanvases();

            var layoutRoots = new List<RectTransform>();
            var componentBuffer = new List<Component>();
            collectLayoutRoots(root, false, layoutRoots, componentBuffer);

            foreach (var layoutRoot in layoutRoots)
            {
                LayoutRebuilder.ForceRebuildLayoutImmediate(layoutRoot);
            }
        }

        /// <summary>
        /// Collects every RectTransform at or below <paramref name="root"/> that has
        /// an enabled ILayoutController and whose ancestors up to root have none.
        /// Those are exactly the entry points ForceRebuildLayoutImmediate needs;
        /// branches separated by controller-less nodes get their own entry so
        /// nested layout roots are never skipped.
        /// </summary>
        private static void collectLayoutRoots(
            RectTransform rect,
            bool parentHasController,
            List<RectTransform> result,
            List<Component> componentBuffer)
        {
            var hasController = hasActiveLayoutController(rect, componentBuffer);
            if (hasController && !parentHasController)
            {
                result.Add(rect);
            }

            for (int i = 0; i < rect.childCount; i++)
            {
                if (rect.GetChild(i) is RectTransform child)
                {
                    collectLayoutRoots(child, hasController, result, componentBuffer);
                }
            }
        }

        private static bool hasActiveLayoutController(RectTransform rect, List<Component> componentBuffer)
        {
            componentBuffer.Clear();
            rect.GetComponents(typeof(ILayoutController), componentBuffer);

            for (int i = 0; i < componentBuffer.Count; i++)
            {
                if (componentBuffer[i] is Behaviour behaviour)
                {
                    if (behaviour.isActiveAndEnabled)
                    {
                        return true;
                    }
                }
                else if (componentBuffer[i] != null)
                {
                    return true; // non-Behaviour controller (e.g. ScriptableObject) — treat as active
                }
            }

            return false;
        }
    }
}
