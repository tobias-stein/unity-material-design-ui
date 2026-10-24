using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityEngine;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Serializes <see cref="UISnapshot"/> to YAML and writes it to disk
    /// (async on a thread-pool thread), applying retention limits so exports
    /// can never grow unbounded. All failures are logged, never thrown at
    /// call sites — capturing must never break the running app.
    /// </summary>
    public static class UISnapshotExporter
    {
        private static ISerializer _serializer;

        private static ISerializer serializer
        {
            get
            {
                if (_serializer == null)
                {
                    _serializer = new SerializerBuilder()
                        .WithNamingConvention(CamelCaseNamingConvention.Instance)
                        .DisableAliases()
                        .ConfigureDefaultValuesHandling(
                            DefaultValuesHandling.OmitNull | DefaultValuesHandling.OmitEmptyCollections)
                        .Build();
                }
                return _serializer;
            }
        }

        /// <summary> YAML text for the given snapshot (e.g. to ship over the network). </summary>
        public static string serialize(UISnapshot snapshot)
        {
            if (snapshot == null)
            {
                return null;
            }
            return serializer.Serialize(snapshot);
        }

        /// <summary> Active directory snapshots are written to (per Telemetry.config). </summary>
        public static string resolveDirectory()
        {
            var config = Telemetry.config;
            var baseDir = config.outputLocation == TelemetryOutputLocation.Custom
                          && !string.IsNullOrWhiteSpace(config.customOutputPath)
                ? config.customOutputPath
                : Application.persistentDataPath;

            return string.IsNullOrWhiteSpace(config.outputSubfolder)
                ? baseDir
                : Path.Combine(baseDir, config.outputSubfolder);
        }

        /// <summary> Captures the active view (or a given root) and writes a snapshot file. </summary>
        public static UniTask<string> captureToFileAsync(IUI root = null)
        {
            UISnapshot snapshot;
            try
            {
                snapshot = UISnapshotBuilder.build(root);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return UniTask.FromResult<string>(null);
            }

            return exportToFileAsync(snapshot);
        }

        /// <summary> Writes an already-built snapshot to disk; returns the file path or null on failure. </summary>
        public static UniTask<string> exportToFileAsync(UISnapshot snapshot)
        {
            if (snapshot == null)
            {
                return UniTask.FromResult<string>(null);
            }

            // Main thread: serialize + resolve paths + collect ledger metadata
            // (everything below rides along even when the ledger is disabled —
            // building the info object alone costs nothing).
            WritePlan plan;
            try
            {
                plan = prepareWrite(snapshot);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return UniTask.FromResult<string>(null);
            }

            return UniTask.RunOnThreadPool(() =>
            {
                try
                {
                    var bytes = encodeFileBytes(plan.yaml, plan.gzip);
                    var hash = sha256Hex(bytes);
                    File.WriteAllBytes(plan.path, bytes);

                    prune(Telemetry.config, plan.directory);
                    return new WriteResult { path = plan.path, fileHash = hash };
                }
                catch (Exception ex)
                {
                    Debug.LogException(ex);
                    return null;
                }
            }, cancellationToken: CancellationToken.None)
            .ContinueWith(result =>
            {
                // Main thread (main-thread await continuation; the sinks touch
                // Unity APIs). Runs strictly after the file write returned, so a
                // ledger point always references bytes that exist on disk and
                // failed writes emit no point at all.
                if (result != null)
                {
                    Telemetry.events?.snapshotTaken(buildLedgerInfo(plan, result.fileHash));
                }
                return result?.path;
            });
        }

        private sealed class WritePlan
        {
            public string yaml;
            public string directory;
            public string path;
            public bool gzip;
            public events.SnapshotTakenInfo ledger;
        }

        private sealed class WriteResult
        {
            public string path;
            public string fileHash;
        }

        /// <summary>
        /// Main-thread write preparation: serializes the snapshot, reserves the
        /// output path and collects all metadata the
        /// <see cref="Measurements.UiSnapshotTaken"/> point will need (except the
        /// file hash, which is only knowable after the bytes are written).
        /// </summary>
        private static WritePlan prepareWrite(UISnapshot snapshot)
        {
            var yaml = serialize(snapshot);
            var directory = resolveDirectory();
            Directory.CreateDirectory(directory);

            var utcNow = DateTime.UtcNow;
            var path = reservePath(snapshot, directory, utcNow);

            var app = snapshot.app;
            var view = snapshot.view;

            return new WritePlan
            {
                yaml = yaml,
                directory = directory,
                path = path,
                gzip = Telemetry.config.gzip,
                ledger = new events.SnapshotTakenInfo
                {
                    sessionId = app?.sessionId,
                    viewId = view?.id,
                    viewName = view?.name,
                    storageKey = SnapshotStorageKey.build(utcNow, Path.GetFileName(path)),
                    nodeCount = snapshot.nodes?.Count ?? 0,
                    screenWidth = app != null ? app.screenWidth : 0f,
                    screenHeight = app != null ? app.screenHeight : 0f,
                    owner = string.IsNullOrEmpty(app?.productName) ? null : app.productName,
                    platform = app?.platform,
                    source = snapshot.source
                }
            };
        }

        private static events.SnapshotTakenInfo buildLedgerInfo(WritePlan plan, string fileHash)
        {
            var info = plan.ledger;
            info.fileHash = fileHash;
            return info;
        }

        /// <summary>
        /// Encodes the exact bytes the file will contain — plain UTF-8 or gzip of
        /// it — so the file content can be known (and hashed) before writing.
        /// </summary>
        private static byte[] encodeFileBytes(string yaml, bool gzip)
        {
            var plain = new UTF8Encoding(false).GetBytes(yaml);
            if (!gzip)
            {
                return plain;
            }

            using (var compressed = new MemoryStream(plain.Length / 4 + 64))
            {
                using (var gzipStream = new GZipStream(compressed, CompressionMode.Compress))
                {
                    gzipStream.Write(plain, 0, plain.Length);
                }
                return compressed.ToArray();
            }
        }

        /// <summary> Lowercase hexadecimal SHA-256 of the given bytes. </summary>
        private static string sha256Hex(byte[] bytes)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                var digest = sha.ComputeHash(bytes);
                var hex = new StringBuilder(digest.Length * 2);
                foreach (var b in digest)
                {
                    hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                }
                return hex.ToString();
            }
        }

        /// <summary>
        /// Builds a unique file path from the configured template
        /// ({viewName}, {timestamp}, {id}) with a "-n" suffix on collisions.
        /// The capture timestamp is passed in so the caller can derive the
        /// matching storage key from the very same instant.
        /// </summary>
        private static string reservePath(UISnapshot snapshot, string directory, DateTime utcNow)
        {
            var config = Telemetry.config;
            var timestamp = utcNow.ToString("yyyyMMdd-HHmmss");

            var template = string.IsNullOrWhiteSpace(config.fileNameTemplate)
                ? "{viewName}-{timestamp}"
                : config.fileNameTemplate;

            var baseName = template
                .Replace("{viewName}", sanitize(snapshot.view?.name ?? "view"))
                .Replace("{timestamp}", timestamp)
                .Replace("{id}", sanitize(snapshot.view?.id ?? ""));

            if (string.IsNullOrWhiteSpace(baseName))
            {
                baseName = "snapshot-" + timestamp;
            }

            var extension = config.gzip ? ".yaml.gz" : ".yaml";
            var path = Path.Combine(directory, baseName + extension);

            var suffix = 1;
            while (File.Exists(path))
            {
                path = Path.Combine(directory, $"{baseName}-{suffix}{extension}");
                suffix++;
            }

            return path;
        }

        /// <summary>
        /// Deletes oldest snapshots until both the file-count and total-size
        /// limits (when &gt; 0) are respected. The just-written file is newest,
        /// so it survives unless limits are set to 0 (unlimited).
        /// </summary>
        private static void prune(TelemetryConfig config, string directory)
        {
            if (config.maxFiles <= 0 && config.maxTotalMB <= 0)
            {
                return;
            }

            var files = new List<FileInfo>();
            try
            {
                var dirInfo = new DirectoryInfo(directory);
                foreach (var pattern in new[] { "*.yaml", "*.yaml.gz" })
                {
                    files.AddRange(dirInfo.GetFiles(pattern));
                }
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return;
            }

            files.Sort((a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc)); // oldest first

            long totalBytes = 0;
            foreach (var file in files)
            {
                totalBytes += file.Length;
            }

            var maxBytes = (long)(config.maxTotalMB * 1024f * 1024f);

            var index = 0;
            while (index < files.Count)
            {
                var overCount = config.maxFiles > 0 && files.Count > config.maxFiles;
                var overSize = config.maxTotalMB > 0 && totalBytes > maxBytes;
                if (!overCount && !overSize)
                {
                    break;
                }

                try
                {
                    totalBytes -= files[index].Length;
                    File.Delete(files[index].FullName);
                    files.RemoveAt(index);
                }
                catch (Exception ex)
                {
                    Debug.LogException(ex);
                    break; // avoid retrying the same file forever
                }
            }
        }

        private static string sanitize(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return value;
            }

            var invalid = Path.GetInvalidFileNameChars();
            var builder = new StringBuilder(value.Length);
            foreach (var c in value)
            {
                builder.Append(Array.IndexOf(invalid, c) >= 0 ? '_' : c);
            }
            return builder.ToString();
        }
    }
}
