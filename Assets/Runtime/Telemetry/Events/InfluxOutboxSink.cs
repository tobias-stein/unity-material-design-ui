using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Cysharp.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace mdu.ui.telemetry.events
{
    /// <summary>
    /// Write-ahead outbox delivering events to an InfluxDB v2 HTTP API
    /// (<c>POST /api/v2/write?precision=ns</c>): events are batched in memory,
    /// persisted to a <c>pending-*.lp</c> file *before* the first send attempt,
    /// POSTed as one line-protocol body, and the file is deleted only on a 2xx
    /// acknowledgement. Failed files stay on disk and are retried — one request
    /// in flight, backed off up to 60 s — including files left by a previous
    /// run (startup directory scan), so an unreachable InfluxDB never loses
    /// events and the queue drains automatically when it comes back.
    ///
    /// Re-sending an already-acknowledged file (crash between 204 and delete) is
    /// harmless: identical measurement + tags + timestamp points overwrite in
    /// InfluxDB (at-least-once, effectively idempotent).
    ///
    /// Never throws — telemetry must not break the app. The first failure is
    /// logged, repeats are suppressed until recovery is logged.
    /// </summary>
    public class InfluxOutboxSink : ITelemetryEventSink
    {
        private const float MaxBackoffSeconds = 60f;

        private readonly StringBuilder _batch = new StringBuilder(4096);
        private readonly List<string> _pendingFiles = new List<string>();

        private int _batchedEvents;
        private float _batchStartRealtime;
        private bool _scanned;
        private bool _inFlight;
        private bool _failureLogged;
        private float _nextAttemptRealtime;
        private float _backoffSeconds;
        private int _fileSeq;

        /// <summary> Files persisted but not yet acknowledged by InfluxDB. </summary>
        public int pendingFileCount => _pendingFiles.Count;

        public void write(TelemetryEvent e)
        {
            if (e == null || string.IsNullOrEmpty(e.sessionId))
            {
                return;
            }

            if (_batchedEvents == 0)
            {
                _batchStartRealtime = Time.realtimeSinceStartup;
            }

            _batch.Append(LineProtocolSerializer.serialize(e)).Append('\n');
            _batchedEvents++;
        }

        /// <summary> Persists aged/full batches and drives sends/retries (called every frame). </summary>
        public void tick()
        {
            var config = Telemetry.config;

            if (!_scanned)
            {
                scanPendingFiles(); // recover files from a previous run first, in order
                _scanned = true;
            }

            if (_batchedEvents > 0 &&
                (_batchedEvents >= config.eventFlushCount ||
                 Time.realtimeSinceStartup - _batchStartRealtime >= config.eventFlushInterval))
            {
                persistBatch();
            }

            if (_inFlight || _pendingFiles.Count == 0 || Time.realtimeSinceStartup < _nextAttemptRealtime)
            {
                return;
            }

            sendOldestAsync().Forget();
        }

        /// <summary> Force-persists the current batch without waiting for cadence (session end / quit). </summary>
        public void flush()
        {
            persistBatch();
        }

        public void dispose()
        {
            persistBatch();
        }

        private void persistBatch()
        {
            if (_batchedEvents == 0)
            {
                return;
            }

            string path;
            try
            {
                var directory = EventFileStore.resolveDirectory();
                Directory.CreateDirectory(directory);
                path = reservePath(directory);
                File.WriteAllText(path, _batch.ToString(), new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                // Keep the lines buffered — a disk hiccup must not lose events.
                // Reset the age so we retry after a full interval, not every frame.
                Debug.LogException(ex);
                _batchStartRealtime = Time.realtimeSinceStartup;
                return;
            }

            _pendingFiles.Add(path); // write-ahead: queued for delivery until InfluxDB acks it
            _batch.Clear();
            _batchedEvents = 0;
            _batchStartRealtime = Time.realtimeSinceStartup;
            EventFileStore.prune(EventFileStore.resolveDirectory());
            // Pruning (or anything else) may have removed queued files — drop
            // them from the queue instead of retrying a path that is gone.
            _pendingFiles.RemoveAll(p => !File.Exists(p));
        }

        private async UniTaskVoid sendOldestAsync()
        {
            var path = _pendingFiles[0];
            if (!File.Exists(path))
            {
                _pendingFiles.RemoveAt(0);
                return;
            }

            _inFlight = true;
            try
            {
                var config = Telemetry.config;
                var payload = File.ReadAllText(path, Encoding.UTF8);

                if (string.IsNullOrWhiteSpace(payload))
                {
                    File.Delete(path);
                    _pendingFiles.RemoveAt(0);
                    return;
                }

                var url = $"{config.influxUrl.TrimEnd('/')}/api/v2/write" +
                          $"?org={Uri.EscapeDataString(config.influxOrg)}" +
                          $"&bucket={Uri.EscapeDataString(config.influxBucket)}" +
                          "&precision=ns";

                using (var request = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPOST))
                {
                    request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(payload));
                    request.downloadHandler = new DownloadHandlerBuffer();
                    request.SetRequestHeader("Authorization", "Token " + config.influxToken);
                    request.SetRequestHeader("Content-Type", "text/plain; charset=utf-8");
                    request.timeout = Mathf.Max(1, Mathf.CeilToInt(config.influxTimeoutSeconds));

                    // Throws UnityWebRequestException on network/protocol errors.
                    await request.SendWebRequest().ToUniTask();

                    if (request.responseCode < 200 || request.responseCode > 299)
                    {
                        onFailure($"{request.responseCode} {request.error}");
                        return;
                    }
                }

                // Acknowledged — remove the offline copy.
                File.Delete(path);
                _pendingFiles.RemoveAt(0);

                _backoffSeconds = 0f;
                _nextAttemptRealtime = 0f;
                if (_failureLogged)
                {
                    _failureLogged = false;
                    Debug.Log($"[Telemetry] InfluxDB recovered — {_pendingFiles.Count} event file(s) still pending.");
                }
            }
            catch (Exception ex)
            {
                onFailure(ex.Message);
            }
            finally
            {
                _inFlight = false;
            }
        }

        private void onFailure(string reason)
        {
            _backoffSeconds = _backoffSeconds <= 0f
                ? Telemetry.config.eventFlushInterval
                : Mathf.Min(_backoffSeconds * 2f, MaxBackoffSeconds);
            _nextAttemptRealtime = Time.realtimeSinceStartup + _backoffSeconds;

            if (!_failureLogged)
            {
                _failureLogged = true;
                Debug.LogWarning($"[Telemetry] InfluxDB write failed ({reason}) — {_pendingFiles.Count} event " +
                                 $"file(s) pending on disk; retrying (next in {_backoffSeconds:0.#}s, then backing off).");
            }
        }

        /// <summary> Enqueues pending files already on disk (previous run / failed sends). </summary>
        private void scanPendingFiles()
        {
            try
            {
                var directory = EventFileStore.resolveDirectory();
                if (!Directory.Exists(directory))
                {
                    return;
                }

                var files = new List<string>(Directory.GetFiles(directory, "pending-*.lp"));
                files.Sort(StringComparer.Ordinal); // timestamp-stamped names sort chronologically
                foreach (var file in files)
                {
                    if (!_pendingFiles.Contains(file))
                    {
                        _pendingFiles.Add(file);
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        /// <summary> Collision-free path for one pending batch; timestamp keeps names sortable. </summary>
        private string reservePath(string directory)
        {
            var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
            string path;
            do
            {
                path = Path.Combine(directory, $"pending-{stamp}-{_fileSeq}.lp");
                _fileSeq++;
            }
            while (File.Exists(path));

            return path;
        }
    }
}
