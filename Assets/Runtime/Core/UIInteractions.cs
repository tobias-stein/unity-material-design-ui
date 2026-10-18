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

        public static bool hasListeners => onInteraction != null;

        public static void raise(UIInteraction interaction) => onInteraction?.Invoke(interaction);

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
