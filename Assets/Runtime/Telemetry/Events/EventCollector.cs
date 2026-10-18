using System;
using UnityEngine;

namespace mdu.ui.telemetry.events
{
    /// <summary>
    /// Telemetry event feature: owns the session id (generated at bootstrap,
    /// resettable at runtime via <c>Telemetry.newSession()</c>), converts
    /// <see cref="UIInteractions"/> raises and active-view changes into
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
        private DateTime _activeViewOpenedUtc;

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

            if (enabled && _activeView != null)
            {
                closeActiveView(now);
            }

            if (enabled)
            {
                writeEvent(Measurements.Session, EventTypes.SessionEnd, now, null, null, null, null, null, null);
                flushAll();
            }

            _sessionId = Guid.NewGuid().ToString("N");
            _sessionStartRecorded = false;

            if (enabled)
            {
                startSession(now);
                trackActiveView(now); // re-open the current view under the new session
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

            // Correlate with the view the element belongs to; for non-view
            // elements fall back to the tracked / top-of-stack view.
            var view = element as IView ?? _activeView ?? resolveTopView();
            getViewInfo(view, out var viewId, out var viewName);

            writeEvent(Measurements.UiEvent, type, DateTime.UtcNow, viewId, viewName,
                element?.id, element?.GetType().FullName, flag, null);
        }

        /// <summary> Emits view_open/view_close points whenever the top-of-stack view changes. </summary>
        private void trackActiveView(DateTime now)
        {
            var top = resolveTopView();
            if (ReferenceEquals(top, _activeView))
            {
                return;
            }

            if (_activeView != null)
            {
                closeActiveView(now);
            }

            if (top != null)
            {
                openActiveView(top, now);
            }
        }

        private void openActiveView(IView view, DateTime now)
        {
            _activeView = view;
            getViewInfo(view, out _activeViewId, out _activeViewName);
            _activeViewOpenedUtc = now;

            writeEvent(Measurements.UiEvent, EventTypes.ViewOpen, now, _activeViewId, _activeViewName,
                null, null, null, null);
        }

        private void closeActiveView(DateTime now)
        {
            var dwell = Math.Max(0, (now - _activeViewOpenedUtc).TotalSeconds);

            writeEvent(Measurements.UiEvent, EventTypes.ViewClose, now, _activeViewId, _activeViewName,
                null, null, null, dwell);

            _activeView = null;
            _activeViewId = null;
            _activeViewName = null;
        }

        private void onQuitting()
        {
            try
            {
                if (_activeView != null && Telemetry.config.eventsEnabled)
                {
                    // Close the still-open view so its dwell reaches the export.
                    closeActiveView(DateTime.UtcNow);
                }

                flushAll();
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        private void writeEvent(string measurement, string type, DateTime now,
            string viewId, string viewName, string elementId, string elementTypeName,
            bool? flag, double? dwellSeconds)
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
                dwellSeconds = dwellSeconds
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
            const string cloneSuffix = " (Clone)";
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }
            return name.EndsWith(cloneSuffix, StringComparison.Ordinal)
                ? name.Substring(0, name.Length - cloneSuffix.Length)
                : name;
        }
    }
}
