using System;
using Cysharp.Threading.Tasks;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Snapshot trigger feature, registered by <see cref="Telemetry"/> at bootstrap:
    ///  - hotkey (default F9, editor/dev builds only)
    ///  - view transitions (<see cref="ViewManager.onViewActivated"/>)
    /// Ticked by the hidden Telemetry host; all capture work is fire-and-forget
    /// and never throws into the app.
    /// </summary>
    public class UISnapshotTriggers
    {
        private bool _viewHooked;
        private bool _disabled;
        private float _lastCaptureTime = float.NegativeInfinity;
        private string _lastViewId;
        private int _lastNodeCount;

        public void tick()
        {
            if (_disabled)
            {
                return;
            }

            TelemetryConfig config;
            try
            {
                config = Telemetry.config;
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                _disabled = true;
                return;
            }

            if (!config.enabled)
            {
                return;
            }

            ensureViewHook();

            if (config.hotkeyEnabled && hotkeyAllowed(config) && isHotkeyPressed(config.hotkey))
            {
                captureAsync(UI.views?.currentContext?.mainView, false, "hotkey").Forget();
            }
        }

        private void ensureViewHook()
        {
            if (_viewHooked)
            {
                return;
            }

            var views = UI.views;
            if (views == null)
            {
                return; // UI not bootstrapped yet — try again next frame
            }

            views.onViewActivated += onViewActivated;
            _viewHooked = true;
        }

        private void onViewActivated(IView view)
        {
            TelemetryConfig config;
            try
            {
                config = Telemetry.config;
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return;
            }

            if (!config.enabled || !config.viewTransitionEnabled)
            {
                return;
            }

            captureAsync(view, true, "view-transition").Forget();
        }

        private async UniTask captureAsync(IUI root, bool respectRateLimit, string source)
        {
            var config = Telemetry.config;

            if (respectRateLimit && Time.unscaledTime - _lastCaptureTime < config.viewTransitionMinInterval)
            {
                return;
            }
            _lastCaptureTime = Time.unscaledTime;

            try
            {
                var snapshot = UISnapshotBuilder.build(root);
                if (snapshot == null)
                {
                    return;
                }

                if (config.viewTransitionDedupe
                    && snapshot.view != null
                    && snapshot.view.id == _lastViewId
                    && snapshot.nodes.Count == _lastNodeCount)
                {
                    return;
                }

                var path = await UISnapshotExporter.exportToFileAsync(snapshot);
                if (path != null)
                {
                    _lastViewId = snapshot.view?.id;
                    _lastNodeCount = snapshot.nodes.Count;
                    Debug.Log($"[Telemetry] snapshot ({source}) saved: {path} [{snapshot.nodes.Count} nodes]");
                }
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        private static bool hotkeyAllowed(TelemetryConfig config)
        {
            return !config.hotkeyDevOnly || Application.isEditor || Debug.isDebugBuild;
        }

        private static bool isHotkeyPressed(KeyCode keyCode)
        {
#if ENABLE_INPUT_SYSTEM
            var keyboard = Keyboard.current;
            if (keyboard == null)
            {
                return false;
            }

            var key = toInputKey(keyCode);
            return key != Key.None && keyboard[key].wasPressedThisFrame;
#elif ENABLE_LEGACY_INPUT_MANAGER
            return Input.GetKeyDown(keyCode);
#else
            return false;
#endif
        }

#if ENABLE_INPUT_SYSTEM
        private static Key toInputKey(KeyCode keyCode)
        {
            switch (keyCode)
            {
                case KeyCode.F1: return Key.F1;
                case KeyCode.F2: return Key.F2;
                case KeyCode.F3: return Key.F3;
                case KeyCode.F4: return Key.F4;
                case KeyCode.F5: return Key.F5;
                case KeyCode.F6: return Key.F6;
                case KeyCode.F7: return Key.F7;
                case KeyCode.F8: return Key.F8;
                case KeyCode.F9: return Key.F9;
                case KeyCode.F10: return Key.F10;
                case KeyCode.F11: return Key.F11;
                case KeyCode.F12: return Key.F12;
                case KeyCode.Alpha0: return Key.Digit0;
                case KeyCode.Alpha1: return Key.Digit1;
                case KeyCode.Alpha2: return Key.Digit2;
                case KeyCode.Alpha3: return Key.Digit3;
                case KeyCode.Alpha4: return Key.Digit4;
                case KeyCode.Alpha5: return Key.Digit5;
                case KeyCode.Alpha6: return Key.Digit6;
                case KeyCode.Alpha7: return Key.Digit7;
                case KeyCode.Alpha8: return Key.Digit8;
                case KeyCode.Alpha9: return Key.Digit9;
                default:
                    // A..Z are contiguous in both KeyCode and InputSystem Key.
                    if (keyCode >= KeyCode.A && keyCode <= KeyCode.Z)
                    {
                        return (Key)((int)Key.A + (keyCode - KeyCode.A));
                    }
                    return Key.None;
            }
        }
#endif
    }
}
