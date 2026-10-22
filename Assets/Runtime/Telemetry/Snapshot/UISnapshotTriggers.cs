using System;
using System.Collections.Generic;
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
        private bool _popupHooked;
        private bool _disabled;
        private float _lastCaptureTime = float.NegativeInfinity;
        /// <summary>
        /// Activations paced out by <see cref="TelemetryConfig.viewTransitionMinInterval"/>
        /// queue here instead of being dropped and capture when the interval elapses
        /// (see <see cref="processDeferredCaptures"/>) — the interval paces captures,
        /// it never cancels one: every view cycle yields exactly one snapshot.
        /// </summary>
        private readonly Queue<DeferredCapture> _deferredCaptures = new();

        private readonly struct DeferredCapture
        {
            public readonly IView View;
            public readonly string Source;
            public DeferredCapture(IView view, string source) { View = view; Source = source; }
        }

        /// <summary>
        /// Near-simultaneous duplicate-raise guard (per view id). Replaces the old
        /// cross-cycle content dedupe (`view id + node count` vs. the last capture
        /// ever): every view is pooled, so a re-opened cycle reuses the same runtime
        /// id with an unchanged layout — that check suppressed the capture of every
        /// open cycle after the first (timeline filmstrip/replica starved per view,
        /// consecutive snackbars never captured).
        /// </summary>
        private string _lastGuardViewId;
        private float _lastGuardTime = float.NegativeInfinity;

        /// <summary>Two raises for the same view closer than this (unscaled seconds)
        /// are one lifecycle boundary; normal UI raises exactly once per cycle, this
        /// only defends against accidental double-fires on the same frame.</summary>
        private const float DuplicateRaiseWindow = 0.1f;

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
            ensurePopupHook();
            processDeferredCaptures(config);

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
            if (!raiseGuardAllows(view))
            {
                return;
            }

            captureAsync(view, true, "view-transition").Forget();
        }

        /// <summary>
        /// Popup-layer capture: every popup view (Dialog, Snackbar, …) that becomes
        /// visible gets its own snapshot, so the timeline can build a filmstrip row
        /// for it. A popup show raise is the start of a visibility cycle — one
        /// capture per raise (only the near-simultaneous guard applies), so every
        /// popup cycle gets at least its opening capture.
        /// </summary>
        private void ensurePopupHook()
        {
            if (_popupHooked)
            {
                return;
            }

            UIInteractions.onViewShown += onPopupShown;
            _popupHooked = true;
        }

        private void onPopupShown(IView view)
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

            if (!config.enabled || !config.popupTrackingEnabled)
            {
                return;
            }
            if (view == null || view.layer != CanvasLayer.POPUP || config.isExcludedPopup(view))
            {
                return;
            }
            if (!raiseGuardAllows(view))
            {
                return;
            }

            captureAsync(view, false, "popup-shown").Forget();
        }

        /// <summary>Suppresses only near-simultaneous duplicate raises of the same
        /// view (see <see cref="DuplicateRaiseWindow"/>); every further raise is a
        /// new visibility cycle and must capture.</summary>
        private bool raiseGuardAllows(IView view)
        {
            var viewId = string.IsNullOrEmpty(view.id) ? view.rectTransform?.GetInstanceID().ToString() : view.id;
            if (!string.IsNullOrEmpty(viewId) && viewId == _lastGuardViewId &&
                Time.unscaledTime - _lastGuardTime < DuplicateRaiseWindow)
            {
                return false;
            }
            _lastGuardViewId = viewId;
            _lastGuardTime = Time.unscaledTime;
            return true;
        }

        private async UniTask captureAsync(IUI root, bool respectRateLimit, string source)
        {
            var config = Telemetry.config;

            if (respectRateLimit)
            {
                var interval = config.viewTransitionMinInterval;
                if (interval > 0f && Time.unscaledTime - _lastCaptureTime < interval)
                {
                    // Paced, not dropped: the cycle waits for its slot and captures
                    // when the interval elapses (processDeferredCaptures, ticked).
                    _deferredCaptures.Enqueue(new DeferredCapture(view: root as IView, source));
                    return;
                }
            }
            _lastCaptureTime = Time.unscaledTime;

            try
            {
                await buildAndExportAsync(root, source);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        /// <summary>Serves the deferred capture queue: one entry per tick, the oldest
        /// first, as soon as <see cref="TelemetryConfig.viewTransitionMinInterval"/>
        /// elapsed since the last capture start. A view closed while it was waiting
        /// cannot produce a live capture any more — skipped loudly; its next
        /// activation captures normally.</summary>
        private void processDeferredCaptures(TelemetryConfig config)
        {
            if (_disabled || _deferredCaptures.Count == 0)
            {
                return;
            }
            if (Time.unscaledTime - _lastCaptureTime < config.viewTransitionMinInterval)
            {
                return;
            }

            var entry = _deferredCaptures.Dequeue();
            var view = entry.View;
            if (view == null || view.rectTransform == null)
            {
                Debug.LogWarning("[Telemetry] deferred capture skipped — view destroyed while paced (captures on its next activation).");
                return;
            }
            if (!view.rectTransform.gameObject.activeInHierarchy)
            {
                Debug.LogWarning($"[Telemetry] deferred capture skipped — view '{view.id}' closed before its capture slot (captures on its next activation).");
                return;
            }

            _lastCaptureTime = Time.unscaledTime;
            captureAsync(view, false, entry.Source + ":queued").Forget();
        }

        private async UniTask buildAndExportAsync(IUI root, string source)
        {
            var snapshot = UISnapshotBuilder.build(root);
            if (snapshot == null)
            {
                return;
            }

            // One capture per visibility cycle — no cross-cycle content dedupe.
            // (Pooled views re-open with the same runtime id and an unchanged
            // node count, which the previous 'last view + node count' check
            // turned into exactly one capture per view id, ever.)
            var path = await UISnapshotExporter.exportToFileAsync(snapshot);
            if (path != null)
            {
                Debug.Log($"[Telemetry] snapshot ({source}) saved: {path} [{snapshot.nodes.Count} nodes]");
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
