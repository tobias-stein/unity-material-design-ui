using System;
using System.Collections.Generic;
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

            string yaml;
            string directory;
            string path;
            try
            {
                yaml = serialize(snapshot);
                directory = resolveDirectory();
                Directory.CreateDirectory(directory);
                path = reservePath(snapshot, directory);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return UniTask.FromResult<string>(null);
            }

            var config = Telemetry.config;
            return UniTask.RunOnThreadPool(() =>
            {
                try
                {
                    if (config.gzip)
                    {
                        writeGzip(path, yaml);
                    }
                    else
                    {
                        File.WriteAllText(path, yaml, new UTF8Encoding(false));
                    }

                    prune(config, directory);
                    return path;
                }
                catch (Exception ex)
                {
                    Debug.LogException(ex);
                    return null;
                }
            }, cancellationToken: CancellationToken.None);
        }

        /// <summary>
        /// Builds a unique file path from the configured template
        /// ({viewName}, {timestamp}, {id}) with a "-n" suffix on collisions.
        /// </summary>
        private static string reservePath(UISnapshot snapshot, string directory)
        {
            var config = Telemetry.config;
            var timestamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");

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

        private static void writeGzip(string path, string yaml)
        {
            using (var file = File.Create(path))
            using (var gzip = new GZipStream(file, CompressionMode.Compress))
            using (var writer = new StreamWriter(gzip, new UTF8Encoding(false)))
            {
                writer.Write(yaml);
            }
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
