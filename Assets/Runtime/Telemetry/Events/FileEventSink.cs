using System;
using System.IO;
using System.Text;
using UnityEngine;

namespace mdu.ui.telemetry.events
{
    /// <summary>
    /// Appends line-protocol events to one file per session
    /// (<c>session-{id}.lp</c> under the configured events subfolder), buffering
    /// writes so disk I/O stays negligible. Rotates to a new file when the
    /// session id changes (pending lines of the old session are flushed first),
    /// flushes on buffer count / max age (driven by <see cref="tick"/>) and on
    /// demand, and enforces the configured file-count retention.
    /// </summary>
    public class FileEventSink : ITelemetryEventSink
    {
        private readonly StringBuilder _buffer = new StringBuilder(4096);

        private int _bufferedCount;
        private string _currentSessionId;
        private string _currentPath;
        private bool _dirty;
        private float _lastFlushRealtime;

        public FileEventSink()
        {
            _lastFlushRealtime = Time.realtimeSinceStartup;
        }

        public void write(TelemetryEvent e)
        {
            if (e == null || string.IsNullOrEmpty(e.sessionId))
            {
                return;
            }

            ensureFile(e.sessionId);
            _buffer.Append(LineProtocolSerializer.serialize(e)).Append('\n');
            _bufferedCount++;
            _dirty = true;
        }

        /// <summary> Flushes when the buffer is full or has aged out (called every frame). </summary>
        public void tick()
        {
            if (!_dirty)
            {
                return;
            }

            var config = Telemetry.config;
            var byCount = _bufferedCount >= config.eventFlushCount;
            var byAge = Time.realtimeSinceStartup - _lastFlushRealtime >= config.eventFlushInterval;
            if (byCount || byAge)
            {
                flush();
            }
        }

        public void flush()
        {
            if (!_dirty || _currentPath == null)
            {
                return;
            }

            var path = _currentPath;
            var payload = _buffer.ToString();
            _buffer.Clear();
            _bufferedCount = 0;
            _dirty = false;
            _lastFlushRealtime = Time.realtimeSinceStartup;

            try
            {
                var directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.AppendAllText(path, payload, new UTF8Encoding(false));
                EventFileStore.prune(directory);
            }
            catch (Exception ex)
            {
                // Capturing must never break the running app.
                Debug.LogException(ex);
            }
        }

        public void dispose()
        {
            flush();
        }

        /// <summary> Points the sink at the session file, rotating (and flushing) when the session changed. </summary>
        private void ensureFile(string sessionId)
        {
            if (_currentPath != null && _currentSessionId == sessionId)
            {
                return;
            }

            flush(); // pending lines belong to the previous session file
            _currentSessionId = sessionId;
            _currentPath = Path.Combine(EventFileStore.resolveDirectory(), "session-" + EventFileStore.sanitize(sessionId) + ".lp");
        }
    }
}
