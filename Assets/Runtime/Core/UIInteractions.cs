using System;

namespace mdu.ui
{
    public enum UIInteractionType
    {
        Click,
        Toggle,
        Close,
        BackdropClick
    }

    /// <summary>
    /// A single user interaction with a UI element. <see cref="flag"/> carries
    /// the new state for toggles; it is meaningless for other types.
    /// </summary>
    public readonly struct UIInteraction
    {
        public readonly UIInteractionType type;
        public readonly IUI element;
        public readonly bool flag;

        public UIInteraction(UIInteractionType type, IUI element, bool flag = false)
        {
            this.type = type;
            this.element = element;
            this.flag = flag;
        }
    }

    /// <summary>
    /// Static hub components use to report user interactions without depending
    /// on telemetry code. Telemetry subscribes on bootstrap; with no listener
    /// every raise is a no-op.
    /// </summary>
    public static class UIInteractions
    {
        public static event Action<UIInteraction> onInteraction;

        /// <summary>
        /// Raised when a view became visible (from <see cref="UIView{TView,TData}.show"/>,
        /// covering every view class including popups). Telemetry opens the view's
        /// timeline span here.
        /// </summary>
        public static event Action<IView> onViewShown;

        /// <summary>
        /// Raised once per show-cycle when the view is no longer visible — from
        /// <c>hide()</c> (covered) or <c>close()</c> (dismissed/destroyed), whichever
        /// fires first. Telemetry closes the view's timeline span here.
        /// </summary>
        public static event Action<IView> onViewEnded;

        /// <summary>
        /// Raised when a UI element was newly created and is now part of the live
        /// hierarchy (from <see cref="UIBase{TUI,TData}.create"/> after the instance
        /// is parented, activated and data-bound). <see cref="ownerView"/> is the
        /// nearest IView ancestor resolved right after parenting (so an element is
        /// attributed to the view it was created *under* — not to the top-of-stack
        /// context), or a view under which the element anchors by default when no
        /// explicit parent was given. Never raised for IView instances themselves
        /// (views capture through view-transition hooks) nor for unparented
        /// elements. Telemetry debounces mutations per owner view into snapshot
        /// captures; with no listener raising is a no-op.
        /// </summary>
        public static event Action<IUI, IView> onUIElementCreated;

        /// <summary>
        /// Raised when a live UI element left the visible hierarchy through one of
        /// the two central release paths: pooled/release (<see cref="UIBase{TUI,TData}.Dispose"/>)
        /// or destruction without a prior release (direct Destroy, e.g. a stack
        /// panel closing, or scene teardown — pooled instances already released
        /// are excluded so their destruction cannot double-fire). Attributed to
        /// the nearest IView ancestor, exactly like <see cref="onUIElementCreated"/>;
        /// skipped when the owner view is inactive (view already hidden — its
        /// lifecycle capture covers that state). Telemetry treats a removal the
        /// same as a creation: it refreshes the owner view's debounced mutation
        /// capture, so structural removals (a panel closing) show up in the
        /// timeline as well.
        /// </summary>
        public static event Action<IUI, IView> onUIElementRemoved;

        public static bool hasListeners => onInteraction != null;

        public static void raise(UIInteraction interaction) => onInteraction?.Invoke(interaction);

        public static void raiseViewShown(IView view) => onViewShown?.Invoke(view);

        public static void raiseViewEnded(IView view) => onViewEnded?.Invoke(view);

        /// <summary>
        /// Notifies a new live hierarchy element. Subscriber exceptions (including
        /// the owner-view resolution the caller does) must never break element
        /// creation — callers wrap in try/catch too, this is the last line of defense.
        /// </summary>
        public static void raiseUIElementCreated(IUI element, IView ownerView) =>
            onUIElementCreated?.Invoke(element, ownerView);

        public static void raiseUIElementRemoved(IUI element, IView ownerView) =>
            onUIElementRemoved?.Invoke(element, ownerView);

        public static void click(IUI element) =>
            onInteraction?.Invoke(new UIInteraction(UIInteractionType.Click, element));

        public static void toggle(IUI element, bool isOn) =>
            onInteraction?.Invoke(new UIInteraction(UIInteractionType.Toggle, element, isOn));

        public static void close(IUI element) =>
            onInteraction?.Invoke(new UIInteraction(UIInteractionType.Close, element));

        public static void backdropClick(IUI element) =>
            onInteraction?.Invoke(new UIInteraction(UIInteractionType.BackdropClick, element));
    }
}
