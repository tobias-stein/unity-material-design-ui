using DG.Tweening;
using UnityEngine;

namespace mdu.ui
{
    public static class ViewTransitionEffects
    {
        #region FADE

        public static Tweener fadeIn(this IView view, float duration = 0.2f)
        {
            var target = view.canvasGroup;
            target.alpha = 0.0f;
            return DOTween
                .To(() => target.alpha, x => target.alpha = x, 1.0f, duration)
                .SetTarget(target);
        }

        public static Tweener fadeOut(this IView view, float duration = 0.2f)
        {
            var target = view.canvasGroup;
            target.alpha = 1.0f;
            return DOTween
                .To(() => target.alpha, x => target.alpha = x, 0.0f, duration)
                .SetTarget(target);
        }

        #endregion

        #region SLIDE

        public static Tweener slideXIn(this IView view, float duration = 0.2f)
        {
            var target = view.rectTransform;
            target.anchoredPosition = new Vector2(Screen.width, 0);
            return DOTween
                .To(() => target.anchoredPosition, x => target.anchoredPosition = x, new Vector2(0, 0), duration)
                .SetOptions(AxisConstraint.X, false)
                .SetTarget(target);
        }

        public static Tweener slideXOut(this IView view, float duration = 0.2f)
        {
            var target = view.rectTransform;
            target.anchoredPosition = new Vector2(0, 0);
            return DOTween
                .To(() => target.anchoredPosition, x => target.anchoredPosition = x, new Vector2(Screen.width, 0), duration)
                .SetOptions(AxisConstraint.X, false)
                .SetTarget(target);
        }

        public static Tweener slideYIn(this IView view, float duration = 0.2f)
        {
            var target = view.rectTransform;
            target.anchoredPosition = new Vector2(0, Screen.height);
            return DOTween
                .To(() => target.anchoredPosition, x => target.anchoredPosition = x, new Vector2(0, 0), duration)
                .SetOptions(AxisConstraint.Y, false)
                .SetTarget(target);
        }

        public static Tweener slideYOut(this IView view, float duration = 0.2f)
        {
            var target = view.rectTransform;
            target.anchoredPosition = new Vector2(0, 0);
            return DOTween
                .To(() => target.anchoredPosition, x => target.anchoredPosition = x, new Vector2(0, Screen.height), duration)
                .SetOptions(AxisConstraint.Y, false)
                .SetTarget(target);
        }

        #endregion

        #region ZOOM

        public static Tweener zoomIn(this IView view, float duration = 0.2f)
        {
            var target = view.rectTransform;
            target.localScale = Vector3.zero;
            return DOTween
                .To(() => target.localScale, x => target.localScale = x, Vector3.one, duration)
                .SetTarget(target);
        }

        public static Tweener zoomOut(this IView view, float duration = 0.2f)
        {
            var target = view.rectTransform;
            target.localScale = Vector3.one;
            return DOTween
                .To(() => target.localScale, x => target.localScale = x, Vector3.zero, duration)
                .SetTarget(target);
        }

        #endregion

        public static Sequence transitionIn(this IView view, float duration = 0.2f)
        {
            return null;

            // var sequence = DOTween.Sequence();

            // if ((view.viewTransition & ViewTransition.FADE) != 0)
            // {
            //     sequence.Join(view.fadeIn(duration));
            // }
            // if ((view.viewTransition & ViewTransition.SLIDE_X) != 0)
            // {
            //     sequence.Join(view.slideXIn(duration));
            // }
            // if ((view.viewTransition & ViewTransition.SLIDE_Y) != 0)
            // {
            //     sequence.Join(view.slideYIn(duration));
            // }
            // if ((view.viewTransition & ViewTransition.ZOOM) != 0)
            // {
            //     sequence.Join(view.zoomIn(duration));
            // }

            // return sequence;
        }

        public static Sequence transitionOut(this IView view, float duration = 0.2f)
        {
            return null;
            // var sequence = DOTween.Sequence();

            // if (view.isStick)
            // {
            //     return sequence;
            // }

            // if ((view.viewTransition & ViewTransition.FADE) != 0)
            // {
            //     sequence.Join(view.fadeOut(duration));
            // }
            // if ((view.viewTransition & ViewTransition.SLIDE_X) != 0)
            // {
            //     sequence.Join(view.slideXOut(duration));
            // }
            // if ((view.viewTransition & ViewTransition.SLIDE_Y) != 0)
            // {
            //     sequence.Join(view.slideYOut(duration));
            // }
            // if ((view.viewTransition & ViewTransition.ZOOM) != 0)
            // {
            //     sequence.Join(view.zoomOut(duration));
            // }

            // return sequence;
        }
    }
}