using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace mdu.ui.telemetry.events
{
    /// <summary>
    /// Telemetry event feature: owns the session id (generated at bootstrap,
    /// resettable at runtime via <c>Telemetry.newSession()</c>), converts
    /// <see cref="UIInteractions"/> raises and view lifecycle changes into
    /// timestamped, view-correlated points and hands them to the sink.
    /// Wired and ticked by <see cref="Telemetry"/>; failures must never escape.
    /// </summary>
    public class EventCollector
    {
        private readonly FileEventSink _fileSink = new FileEventSink();
        private readonly InfluxOutboxSink _outboxSink = new InfluxOutboxSink();

        private string _sessionId;
        private bool _sessionStartRecorded;

        private IView _activeView;
        private string _activeViewId;
        private string _activeViewName;

        /// <summary>
        /// Per-view lifecycle state: every view (main views and popup-layer views
        /// like Dialog/Snackbar) opens a span on show and closes it on the first
        /// of hide/close. Keyed by view reference; the runtime emits
        /// <c>view_open</c>/<c>view_close</c> with the view's canvas layer so the
        /// viewer can give popups their own timeline tracks.
        /// </summary>
        private sealed class OpenViewSpan
        {
            public IView view;
            public string viewId;
            public string viewName;
            public string layer;
            public DateTime openedUtc;
        }

        private readonly Dictionary<IView, OpenViewSpan> _openViewSpans = new Dictionary<IView, OpenViewSpan>();

        /// <summary>
        /// Events go to the InfluxDB outbox when <c>influxEnabled</c> (pending
        /// files, deleted on acknowledgement), otherwise to the session archive
        /// file. Flushing/ disposing always covers both so a runtime toggle
        /// never strands a half-filled buffer.
        /// </summary>
        private ITelemetryEventSink activeSink =>
            Telemetry.config.influxEnabled ? _outboxSink : _fileSink;

        /// <summary> Current session id (32-char hex GUID). Never null after construction. </summary>
        public string sessionId => _sessionId;

        public EventCollector()
        {
            UIInteractions.onInteraction += onInteraction;
            UIInteractions.onViewShown += onViewShown;
            UIInteractions.onViewEnded += onViewEnded;
            Application.quitting += onQuitting;

            _sessionId = Guid.NewGuid().ToString("N");
            if (Telemetry.config.eventsEnabled)
            {
                startSession(DateTime.UtcNow);
            }
        }

        /// <summary>
        /// Ends the current session (closing the open view's dwell under it),
        /// flushes everything to disk and starts a new session id. The currently
        /// active view is re-opened under the new session so timelines stay continuous.
        /// </summary>
        public void newSession()
        {
            var now = DateTime.UtcNow;
            var enabled = Telemetry.config.eventsEnabled;

            List<OpenViewSpan> reopened = null;
            if (enabled)
            {
                // Close every still-open view span under the old session (dwell
                // preserved), then re-open them under the new session id so
                // timelines stay continuous across the switch.
                reopened = endAllViewSpans(now);
                writeEvent(Measurements.Session, EventTypes.SessionEnd, now, null, null, null, null, null, null);
                flushAll();
            }

            _sessionId = Guid.NewGuid().ToString("N");
            _sessionStartRecorded = false;

            if (enabled)
            {
                startSession(now);
                reopenViewSpans(reopened, now); // re-open the visible views under the new session
            }
        }

        /// <summary> Per-frame: session lazy-start, active-view dwell tracking and buffered flushes. </summary>
        public void tick()
        {
            if (!Telemetry.config.eventsEnabled)
            {
                return;
            }

            var now = DateTime.UtcNow;
            if (!_sessionStartRecorded)
            {
                startSession(now);
            }

            trackActiveView(now);

            if (Telemetry.config.influxEnabled)
            {
                _outboxSink.tick();          // persist batches + send/retry pending files
            }
            else
            {
                _outboxSink.flush();         // persist a hold-over batch; nothing sends while disabled
            }
            _fileSink.tick();                // drains any archive-mode buffer (no-op when empty)
        }

        private void startSession(DateTime now)
        {
            writeEvent(Measurements.Session, EventTypes.SessionStart, now, null, null, null, null, null, null);
            _sessionStartRecorded = true;
        }

        private void onInteraction(UIInteraction interaction)
        {
            if (!Telemetry.config.eventsEnabled)
            {
                return;
            }

            string type;
            bool? flag = null;
            switch (interaction.type)
            {
                case UIInteractionType.Click:
                    type = EventTypes.Click;
                    break;
                case UIInteractionType.Toggle:
                    type = EventTypes.Toggle;
                    flag = interaction.flag;
                    break;
                case UIInteractionType.Close:
                    type = EventTypes.Close;
                    break;
                case UIInteractionType.BackdropClick:
                    type = EventTypes.BackdropClick;
                    break;
                default:
                    type = "unknown";
                    break;
            }

            var element = interaction.element;

            // Correlate with the view the element belongs to: the element itself
            // (view close/dismiss), then the innermost open view containing it
            // (popup elements are context-owned, not top-of-stack), then the
            // tracked / top-of-stack view.
            var view = resolveEventView(element);
            getViewInfo(view, out var viewId, out var viewName);

            writeEvent(Measurements.UiEvent, type, DateTime.UtcNow, viewId, viewName,
                element?.id, element?.GetType().FullName, flag, null);

            // A close interaction raised *by* a view (Dialog.close, a view's close
            // path) also ends that view's timeline span. raiseViewEnded may fire
            // for the same cycle too — the open-span bookkeeping dedupes.
            if (interaction.type == UIInteractionType.Close && element is IView closedView)
            {
                closeViewSpan(closedView, DateTime.UtcNow);
            }
        }

        /// <summary>
        /// The view an interaction belongs to. Popup views never become
        /// top-of-stack, so an element inside a dialog/snackbar must resolve to
        /// that popup — otherwise its events would land on the host view's track.
        /// </summary>
        private IView resolveEventView(IUI element)
        {
            if (element is IView asView && !(asView is UnityEngine.Object destroyed && destroyed == null))
            {
                return asView;
            }

            var transform = element?.rectTransform;
            if (transform != null)
            {
                foreach (var open in _openViewSpans.Values)
                {
                    var root = open.view != null ? open.view.rectTransform : null;
                    if (root != null && transform.IsChildOf(root))
                    {
                        return open.view;
                    }
                }
            }

            return _activeView ?? resolveTopView();
        }

        /// <summary>
        /// Keeps the interaction-attribution fallback pointed at the top-of-stack
        /// view. Lifecycle points are emitted per-view from the
        /// <see cref="UIInteractions.onViewShown"/>/<c>onViewEnded</c> raises, so
        /// this stays silent — every view gets exactly one open/close pair per
        /// visible cycle, popups included.
        /// </summary>
        private void trackActiveView(DateTime now)
        {
            var top = resolveTopView();
            if (ReferenceEquals(top, _activeView))
            {
                return;
            }

            _activeView = top;
            getViewInfo(top, out _activeViewId, out _activeViewName);
        }

        /// <summary> Opens the view's timeline span (type = view_open, layer tag attached). </summary>
        private void onViewShown(IView view)
        {
            if (!Telemetry.config.eventsEnabled || view == null)
            {
                return;
            }

            if (view.layer == CanvasLayer.POPUP && !popupTrackingAllowed(view))
            {
                return;
            }

            if (_openViewSpans.ContainsKey(view))
            {
                return; // defensive: already open (duplicate show raise)
            }

            var now = DateTime.UtcNow;
            getViewInfo(view, out var viewId, out var viewName);
            var span = new OpenViewSpan
            {
                view = view,
                viewId = viewId,
                viewName = viewName,
                layer = view.layer.ToString(),
                openedUtc = now
            };
            _openViewSpans[view] = span;

            writeEvent(Measurements.UiEvent, EventTypes.ViewOpen, now, viewId, viewName,
                null, null, null, null, span.layer);

            if (view.layer != CanvasLayer.POPUP)
            {
                // Non-popup views also refresh the attribution fallback.
                _activeView = view;
                _activeViewId = viewId;
                _activeViewName = viewName;
            }
        }

        /// <summary> Closes the view's timeline span (type = view_close + dwell). </summary>
        private void onViewEnded(IView view)
        {
            if (!Telemetry.config.eventsEnabled || view == null)
            {
                return;
            }

            closeViewSpan(view, DateTime.UtcNow);
        }

        private void closeViewSpan(IView view, DateTime now)
        {
            if (!_openViewSpans.TryGetValue(view, out var span))
            {
                return; // not open (already ended, or a legacy close raise)
            }

            _openViewSpans.Remove(view);
            var dwell = Math.Max(0, (now - span.openedUtc).TotalSeconds);
            writeEvent(Measurements.UiEvent, EventTypes.ViewClose, now, span.viewId, span.viewName,
                null, null, null, dwell, span.layer);
        }

        /// <summary> Closes every open span; returns the spans whose view is still alive (for session continuity). </summary>
        private List<OpenViewSpan> endAllViewSpans(DateTime now)
        {
            var alive = new List<OpenViewSpan>();
            foreach (var view in new List<IView>(_openViewSpans.Keys))
            {
                if (_openViewSpans.TryGetValue(view, out var span) &&
                    !(view is UnityEngine.Object destroyed && destroyed == null))
                {
                    alive.Add(span);
                }
                closeViewSpan(view, now);
            }
            return alive;
        }

        /// <summary> Re-opens previously open spans under the new session (after <c>newSession</c>). </summary>
        private void reopenViewSpans(List<OpenViewSpan> reopened, DateTime now)
        {
            if (reopened == null)
            {
                return;
            }

            foreach (var span in reopened)
            {
                if (span.view is UnityEngine.Object destroyed && destroyed == null)
                {
                    continue;
                }

                span.openedUtc = now;
                _openViewSpans[span.view] = span;
                writeEvent(Measurements.UiEvent, EventTypes.ViewOpen, now, span.viewId, span.viewName,
                    null, null, null, null, span.layer);
            }
        }

        private bool popupTrackingAllowed(IView view)
        {
            var config = Telemetry.config;
            return config.popupTrackingEnabled && !config.isExcludedPopup(view);
        }

        /// <summary>
        /// Play-mode exit / real quit: closes every open view span (their dwell
        /// reaches the export), writes the session end point and persists every
        /// buffered event to disk. Re-entry (play-mode exit followed by the
        /// real quit handler) stays harmless: the end point is only written
        /// while a session is actually armed.
        /// </summary>
        public void endForExit()
        {
            try
            {
                if (Telemetry.config.eventsEnabled)
                {
                    endAllViewSpans(DateTime.UtcNow);
                    if (_sessionStartRecorded)
                    {
                        writeEvent(Measurements.Session, EventTypes.SessionEnd, DateTime.UtcNow,
                            null, null, null, null, null, null);
                        _sessionStartRecorded = false;
                    }
                }

                flushAll();
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        private void onQuitting()
        {
            endForExit();
        }

        /// <summary>
        /// Records one <see cref="Measurements.UiSnapshotTaken"/> ledger point for a
        /// snapshot file that has been successfully written (the exporter calls this
        /// after the file write returned, so a recorded point always references
        /// bytes on disk). Rides the same sink as interaction events — it lands in
        /// <c>pending-*.lp</c> while InfluxDB is unreachable and in
        /// <c>session-&lt;id&gt;.lp</c> in file-archive mode. Gated by
        /// Telemetry.config.snapshotLedger. Never throws.
        /// Must be called on the main thread (Unity API in the sinks).
        /// </summary>
        public void snapshotTaken(SnapshotTakenInfo info)
        {
            try
            {
                var config = Telemetry.config;
                if (!config.eventsEnabled || !config.snapshotLedger)
                {
                    return;
                }

                if (info == null ||
                    string.IsNullOrEmpty(info.storageKey) ||
                    string.IsNullOrEmpty(info.fileHash) ||
                    info.nodeCount < 0)
                {
                    return;
                }

                activeSink.write(new TelemetryEvent
                {
                    measurement = Measurements.UiSnapshotTaken,
                    timestampNs = (DateTime.UtcNow - DateTime.UnixEpoch).Ticks * 100,
                    sessionId = string.IsNullOrEmpty(info.sessionId) ? _sessionId : info.sessionId,
                    viewId = info.viewId,
                    viewName = info.viewName,
                    storageKey = info.storageKey,
                    fileHash = info.fileHash,
                    nodeCount = info.nodeCount,
                    screenWidth = info.screenWidth,
                    screenHeight = info.screenHeight,
                    screen = formatScreen(info.screenWidth, info.screenHeight),
                    owner = info.owner,
                    platform = info.platform,
                    captureSource = info.source,
                    snapshotMode = info.contentMode,
                    snapshotThemeHash = info.themeHash,
                    snapshotBaseHash = info.baseHash,
                    snapshotAnchorHash = info.anchorHash
                });
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        private static string formatScreen(float width, float height)
        {
            if (width <= 0f || height <= 0f)
            {
                return null;
            }

            const string format = "0.#";
            return width.ToString(format, CultureInfo.InvariantCulture) + "x" +
                   height.ToString(format, CultureInfo.InvariantCulture);
        }

        private void writeEvent(string measurement, string type, DateTime now,
            string viewId, string viewName, string elementId, string elementTypeName,
            bool? flag, double? dwellSeconds, string layer = null)
        {
            activeSink.write(new TelemetryEvent
            {
                measurement = measurement,
                type = type,
                timestampNs = (now - DateTime.UnixEpoch).Ticks * 100,
                sessionId = _sessionId,
                viewId = viewId,
                viewName = viewName,
                elementId = elementId,
                elementTypeName = elementTypeName,
                flag = flag,
                dwellSeconds = dwellSeconds,
                layer = layer
            });
        }

        private void flushAll()
        {
            _fileSink.flush();
            _outboxSink.flush();
        }

        private static IView resolveTopView()
        {
            var top = UI.views?.currentContext?.mainView;
            // IView is an interface, so a destroyed MonoBehaviour still compares
            // non-null by reference — unwrap Unity's null check explicitly.
            if (top is UnityEngine.Object unityObject && unityObject == null)
            {
                return null;
            }
            return top;
        }

        private static void getViewInfo(IView view, out string id, out string name)
        {
            id = null;
            name = null;

            if (view == null)
            {
                return;
            }
            if (view is UnityEngine.Object unityObject && unityObject == null)
            {
                return;
            }

            id = string.IsNullOrEmpty(view.id) ? null : view.id;
            name = view.rectTransform != null ? cleanName(view.rectTransform.name) : view.GetType().Name;
        }

        /// <summary> Same convention as UISnapshotBuilder so event view names match snapshot view names. </summary>
        private static string cleanName(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }

            // Unity's own Object names carry " (Clone)" (with a leading space);
            // runtime views are instantiated from prefabs without it. Strip both
            // so every export reports the prefab name.
            const string spacedSuffix = " (Clone)";
            const string cloneSuffix = "(Clone)";
            if (name.EndsWith(spacedSuffix, StringComparison.Ordinal))
            {
                return name.Substring(0, name.Length - spacedSuffix.Length);
            }

            return name.EndsWith(cloneSuffix, StringComparison.Ordinal)
                ? name.Substring(0, name.Length - cloneSuffix.Length)
                : name;
        }
    }
}
