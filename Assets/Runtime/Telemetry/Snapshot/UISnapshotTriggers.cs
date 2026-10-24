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
    ///  - runtime mutations (<see cref="UIInteractions.onUIElementCreated"/> /
    ///    <see cref="UIInteractions.onUIElementRemoved"/> — UI created or removed
    ///    while a view is open, debounced per view)
    /// Ticked by the hidden Telemetry host; all capture work is fire-and-forget
    /// and never throws into the app.
    /// </summary>
    public class UISnapshotTriggers
    {
        private bool _viewHooked;
        private bool _popupHooked;
        private bool _mutationHooked;
        private bool _viewEndHooked;
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

        /// <summary>Capture source of every runtime-mutation capture (paced ones
        /// append the existing ":queued" suffix, matched by prefix below).</summary>
        private const string MutationSource = "mutation";

        /// <summary>
        /// One create-raise under a view. The create raise happens on the same
        /// frame as the element attaches; the capture is deferred until the view's
        /// debounce window has stayed quiet for <see cref="TelemetryConfig.mutationDebounce"/>
        /// (served by the tick loop), so a burst — a panel plus the elements it
        /// spawns during its open animation — coalesces into one snapshot.
        /// </summary>
        private readonly struct PendingMutation
        {
            public readonly IView View;
            public readonly float DueTime;
            public PendingMutation(IView view, float dueTime) { View = view; DueTime = dueTime; }
        }

        /// <summary>Active debounce windows keyed by view key (id, else runtime instance id).</summary>
        private readonly Dictionary<string, PendingMutation> _pendingMutations = new();

        /// <summary>Mutation captures already served in the current visibility cycle
        /// (same key). Capped by <see cref="TelemetryConfig.mutationMaxCapturesPerCycle"/>;
        /// reset per view when the view's cycle ends or a lifecycle capture exports.</summary>
        private readonly Dictionary<string, int> _mutationCapturesPerCycle = new();

        /// <summary>View keys already warned about the per-cycle cap this cycle —
        /// the refusal repeats on every settle otherwise, so it warns once per
        /// view per cycle (cleared wherever the cap resets).</summary>
        private readonly HashSet<string> _capWarnedViews = new();

        /// <summary>Fingerprint (<see cref="UISnapshotBuilder.fingerprint"/>) of the last
        /// exported snapshot per view — the content-identity check behind
        /// mutation dedupe. Scoped to the cycle (cleared on view end) and to the
        /// dedupe being enabled; lifecycle captures always overwrite it.</summary>
        private readonly Dictionary<string, string> _lastFingerprintByView = new();

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
            ensureMutationHook();
            ensureViewEndHook();
            processDeferredCaptures(config);
            processPendingMutations(config);

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

            // Stamp pacing now rather than when the settled capture actually
            // builds: the delay keeps later mutation firings (mutationDebounce
            // is shorter than the settle window) queued behind this cycle's
            // transition capture instead of racing it with mid-animation content.
            _lastCaptureTime = Time.unscaledTime;
            captureViewTransitionSettledAsync(view, config).Forget();
        }

        /// <summary>
        /// Takes the transition snapshot after a short settle window so views that
        /// populate or animate themselves while opening (panels sliding in, async
        /// content creation) are captured settled instead of mid-animation. The
        /// view must still be live and active when the window elapses — a view
        /// closed inside the window captures nothing (its lifecycle events are
        /// recorded regardless; its next activation captures normally).
        /// </summary>
        private async UniTask captureViewTransitionSettledAsync(IView view, TelemetryConfig config)
        {
            var settle = Mathf.Max(0f, config.viewTransitionSettle);
            if (settle > 0f)
            {
                try
                {
                    await UniTask.Delay(
                        TimeSpan.FromSeconds(settle),
                        DelayType.Realtime,
                        PlayerLoopTiming.Update);
                }
                catch (OperationCanceledException)
                {
                    return; // app/player teardown
                }
                catch (Exception ex)
                {
                    Debug.LogException(ex);
                    return;
                }
            }

            // The view may have closed (or been destroyed) inside the settle window.
            if (view == null || view.rectTransform == null ||
                (view is UnityEngine.Object destroyed && destroyed == null) ||
                !view.rectTransform.gameObject.activeInHierarchy)
            {
                return;
            }

            // Respect-rate-limit is false on purpose: pacing was already booked
            // at raise time (see onViewActivated) — going through the paced
            // queue here would re-order this capture behind the mutations it
            // itself displaced.
            captureAsync(view, false, "view-transition").Forget();
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

        /// <summary>
        /// Runtime-mutation capture: every <see cref="UIInteractions.onUIElementCreated"/>
        /// and <see cref="UIInteractions.onUIElementRemoved"/> raise (UI appearing or
        /// disappearing while a view is open) refreshes that view's debounce window; a
        /// snapshot fires once the window stays quiet for
        /// <see cref="TelemetryConfig.mutationDebounce"/>, so a burst of changes
        /// (panel + the elements it spawns during its open animation) coalesces into
        /// one snapshot that shows the settled state. This also closes the gap left
        /// by the view-transition capture when a view populates itself
        /// asynchronously right after activation: that extra create-raise schedules
        /// exactly the follow-up capture the initial snapshot was too early for.
        /// </summary>
        private void ensureMutationHook()
        {
            if (_mutationHooked)
            {
                return;
            }

            UIInteractions.onUIElementCreated += onUIElementCreated;
            UIInteractions.onUIElementRemoved += onUIElementRemoved;
            _mutationHooked = true;
        }

        private void onUIElementCreated(IUI element, IView ownerView) => scheduleMutationCapture(ownerView, "creation");

        private void onUIElementRemoved(IUI element, IView ownerView) => scheduleMutationCapture(ownerView, "removal");

        /// <summary>
        /// Schedules/refreshes the owner view's debounced mutation capture. Called
        /// for both creations and removals — a structural change of either kind
        /// (panel spawning, panel closing, elements vanishing from a list) is one
        /// settle-and-capture cycle.
        /// </summary>
        private void scheduleMutationCapture(IView ownerView, string reason)
        {
            try
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

                if (!config.enabled || !config.runtimeCaptureEnabled)
                {
                    return;
                }

                // Element without an owner (unparented staging) never reaches a
                // snapshot; views themselves capture via view transitions.
                // rectTransform may legitimately still be null here: elements
                // created while the owning view is mid-construct (e.g. during
                // Awake-raised content) — the debounce serve re-checks and
                // resolves the view by then, so don't drop on it.
                if (ownerView == null)
                {
                    return;
                }
                if (ownerView is UnityEngine.Object destroyedView && destroyedView == null)
                {
                    return;
                }

                // Popups only mutate-capture while popup tracking covers them —
                // the same gate as the popup-shown trigger.
                if (ownerView.layer == CanvasLayer.POPUP &&
                    (!config.popupTrackingEnabled || config.isExcludedPopup(ownerView)))
                {
                    return;
                }

                // Refresh, never extend: the window always sits mutationDebounce
                // after the newest structural change, so a continuous stream
                // settles into one capture for its duration.
                var key = viewKeyOf(ownerView);
                _pendingMutations[key] = new PendingMutation(
                    ownerView,
                    Time.unscaledTime + Mathf.Max(0f, config.mutationDebounce));
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        /// <summary>Serves due debounce windows: one capture per settled view per
        /// tick, respecting the usual pacing (excess goes through the deferred
        /// queue) and the per-cycle mutation cap. A view that died or closed
        /// inside the settle window is dropped — its next activation captures
        /// normally.</summary>
        private void processPendingMutations(TelemetryConfig config)
        {
            if (_pendingMutations.Count == 0 || !config.runtimeCaptureEnabled)
            {
                return;
            }

            var now = Time.unscaledTime;
            List<string> due = null;
            foreach (var pair in _pendingMutations)
            {
                if (now >= pair.Value.DueTime)
                {
                    (due ??= new List<string>()).Add(pair.Key);
                }
            }
            if (due == null)
            {
                return;
            }

            foreach (var key in due)
            {
                if (!_pendingMutations.TryGetValue(key, out var pending))
                {
                    continue; // settled again by a newer raise in the meantime
                }
                _pendingMutations.Remove(key);

                var view = pending.View;
                if (view == null || view.rectTransform == null ||
                    (view is UnityEngine.Object destroyed && destroyed == null))
                {
                    continue; // view died inside the debounce window
                }
                if (!view.rectTransform.gameObject.activeInHierarchy)
                {
                    continue; // hidden (closed/on to the pool) by the time the window settled
                }
                var count = 0;
                if (config.mutationMaxCapturesPerCycle > 0)
                {
                    _mutationCapturesPerCycle.TryGetValue(key, out count);
                    if (count >= config.mutationMaxCapturesPerCycle)
                    {
                        // Cap reached for this cycle. Refused loudly (once per view
                        // and cycle, otherwise every settle spams) so a hit is
                        // never confused with "mutations are not captured" — the
                        // lifecycle capture of the next cycle resets it.
                        if (_capWarnedViews.Add(key))
                        {
                            Debug.LogWarning(
                                $"[Telemetry] mutation capture cap ({config.mutationMaxCapturesPerCycle}) " +
                                $"reached for '{view.id}' this cycle — further structural changes " +
                                "are not captured until its next visibility cycle " +
                                $"(TelemetryConfig.mutationMaxCapturesPerCycle).");
                        }
                        continue;
                    }
                }

                _mutationCapturesPerCycle[key] = count + 1;
                // respectRateLimit: paced, not dropped — the deferred queue serves
                // it when the pacing interval elapses, exactly like transitions.
                captureAsync(view, true, MutationSource).Forget();
            }
        }

        /// <summary>Cycle-boundary cleanup: a view that stopped being visible drops
        /// its pending debounce window, its mutation cap and its dedupe
        /// fingerprint — the next cycle starts fresh (pooled views re-open with
        /// the same key and must capture again even if the tree looks identical).</summary>
        private void ensureViewEndHook()
        {
            if (_viewEndHooked)
            {
                return;
            }

            UIInteractions.onViewEnded += onViewEndedForMutations;
            _viewEndHooked = true;
        }

        private void onViewEndedForMutations(IView view)
        {
            if (view == null)
            {
                return;
            }

            var key = viewKeyOf(view);
            _pendingMutations.Remove(key);
            _mutationCapturesPerCycle.Remove(key);
            _lastFingerprintByView.Remove(key);
            _capWarnedViews.Remove(key);
        }

        /// <summary>Stable per-view key: the view's id when set, else its transform
        /// instance id — same convention as <see cref="raiseGuardAllows"/>' guard.</summary>
        private static string viewKeyOf(IView view)
        {
            var id = view.id;
            return !string.IsNullOrEmpty(id) ? id
                : view.rectTransform != null ? view.rectTransform.GetInstanceID().ToString()
                : view is UnityEngine.Object unityView ? unityView.GetInstanceID().ToString()
                : null;
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
            var snapshot = UISnapshotBuilder.build(root, source);
            if (snapshot == null)
            {
                return;
            }

            var config = Telemetry.config;
            var view = root as IView;
            var key = view != null ? viewKeyOf(view) : null;
            var isMutation = !string.IsNullOrEmpty(source) &&
                             source.StartsWith(MutationSource, StringComparison.Ordinal);

            string previousFingerprint = null;
            var hadStoredFingerprint = key != null &&
                _lastFingerprintByView.TryGetValue(key, out previousFingerprint);

            if (config.enabled && config.mutationDedupe && key != null)
            {
                var fingerprint = UISnapshotBuilder.fingerprint(snapshot);
                if (isMutation && hadStoredFingerprint && previousFingerprint == fingerprint)
                {
                    // Mutation captures exist to document change; nothing changed
                    // (e.g. a created element settled into an identical layout, or
                    // the creation burst was undone inside the debounce window).
                    Debug.Log($"[Telemetry] mutation capture skipped — '{snapshot.view?.name}' unchanged since last export ({snapshot.nodes.Count} nodes)");
                    return;
                }
                _lastFingerprintByView[key] = fingerprint;
            }

            if (!isMutation && key != null)
            {
                // A lifecycle capture is the opening shot of a visibility cycle —
                // the mutation cap (and its warning latch) restart with it.
                _mutationCapturesPerCycle.Remove(key);
                _capWarnedViews.Remove(key);
            }

            // One capture per visibility cycle is guaranteed by the transitions /
            // popup triggers themselves — no cross-cycle content dedupe here (the
            // mutation-only dedupe above is scoped to a cycle exactly so the old
            // 'view id + node count' starvation can't come back).
            var path = await UISnapshotExporter.exportToFileAsync(snapshot);
            if (path == null)
            {
                // The write failed — forget the just-stored fingerprint so the
                // never-exported content is not deduped away on a later identical
                // mutation capture.
                if (config.enabled && config.mutationDedupe && key != null)
                {
                    if (hadStoredFingerprint)
                    {
                        _lastFingerprintByView[key] = previousFingerprint;
                    }
                    else
                    {
                        _lastFingerprintByView.Remove(key);
                    }
                }
                return;
            }

            Debug.Log($"[Telemetry] snapshot ({source}) saved: {path} [{snapshot.nodes.Count} nodes]");
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
