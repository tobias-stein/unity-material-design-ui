using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityEngine;
// Type alias instead of `using System.Diagnostics;` — that namespace carries its own
// Debug class, which would make UnityEngine.Debug ambiguous in this file.
using Stopwatch = System.Diagnostics.Stopwatch;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Serializes <see cref="UISnapshot"/> to v3 binary (default, ADR-0008) or the
    /// legacy YAML escape hatch and writes it to disk (async on a thread-pool thread),
    /// applying retention limits so exports can never grow unbounded. All failures
    /// are logged, never thrown at call sites — capturing must never break the
    /// running app.
    ///
    /// Format fidelity of the file that lands on disk is what the whole chain in
    /// this directory pins yet keeps small: the exporter resolves the theme section
    /// mode (session manifest ref per ADR-0007 / inline for standalone captures) and
    /// emits the delta capture content (ADR-0009) it was handed, everything else is
    /// storage mechanics.
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

        /// <summary>What one successful export produced (main-thread visible after the pool write).</summary>
        public sealed class ExportResult
        {
            public string path;
            public string fileHash;
            public string themeHash;
            /// <summary>True when a delta capture ("MDS" contentMode=1) was exported.</summary>
            public bool delta;
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
            // ADR-0001: manual captures report the same timing line as trigger
            // captures — the carrier only exists while the kill-switch is on.
            var timing = Telemetry.config.captureTimingEnabled ? new CaptureTiming() : null;

            UISnapshot snapshot;
            try
            {
                snapshot = UISnapshotBuilder.build(root, null, timing);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return UniTask.FromResult<string>(null);
            }

            return exportToFileAsync(snapshot, timing).ContinueWith(result => result?.path);
        }

        /// <summary>
        /// Writes an already-built snapshot to disk; returns path + hash. A non-null
        /// <paramref name="timing"/> arms the ADR-0001 instrumentation (serialize /
        /// encode+hash / write ms and file bytes on the pool thread, one aggregate
        /// line emitted after the write succeeded). A non-null
        /// <paramref name="delta"/> serializes the ADR-0009 chain form instead of the
        /// full tree (binary format only).
        /// </summary>
        public static UniTask<ExportResult> exportToFileAsync(UISnapshot snapshot, CaptureTiming timing = null, SnapshotDelta delta = null)
        {
            if (snapshot == null)
            {
                return UniTask.FromResult<ExportResult>(null);
            }

            // Main thread: reserve the output path + collect ledger metadata — cheap,
            // collision-free, path ordering stays deterministic. The snapshot itself
            // is a plain POCO graph nobody mutates afterwards, so its serialization
            // rides the thread pool *with* the file write: the whole-tree serialize is
            // the expensive step of an export and no longer costs a frame during
            // gameplay (2026-10-24). Under v3 serialization is columnar-leaning and
            // (for deltas) sparse — the same pool contract applies unchanged.
            WritePlan plan;
            try
            {
                plan = prepareWrite(snapshot, delta);
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return UniTask.FromResult<ExportResult>(null);
            }

            return UniTask.RunOnThreadPool(() =>
            {
                try
                {
                    // ADR-0001: the pool-thread phases each get their own delta off
                    // one Stopwatch — serialize (the expensive step), encode+hash
                    // (gzip / SHA-256 for YAML; SHA-256 only for binary) and the file
                    // write — plus the exact byte size the file ends up with.
                    // Null Stopwatch when the kill-switch is off.
                    var stopwatch = timing != null ? Stopwatch.StartNew() : null;

                    // ADR-0007: write a dirty session theme manifest *before* the
                    // snapshot referencing it — a later loader must resolve
                    // themeHash → manifest → theme with both files on disk.
                    if (plan.format == SnapshotFormat.Binary && plan.themeManifestDirty)
                    {
                        ThemeManifestStore.writeIfDirty(plan.directory);
                    }

                    byte[] bytes;
                    if (plan.format == SnapshotFormat.Binary)
                    {
                        var serializeStart = stopwatch != null ? CaptureTiming.ElapsedMs(stopwatch) : 0f;
                        bytes = plan.delta != null
                            ? UISnapshotBinaryWriter.writeDelta(plan.delta, snapshot, plan.themeMode, plan.themeHashValue, snapshot.theme)
                            : UISnapshotBinaryWriter.writeAnchor(snapshot, plan.themeMode, plan.themeHashValue, snapshot.theme);
                        var encodeStart = stopwatch != null ? CaptureTiming.ElapsedMs(stopwatch) : 0f;
                        var hash = sha256Hex(bytes);
                        var writeStart = stopwatch != null ? CaptureTiming.ElapsedMs(stopwatch) : 0f;
                        File.WriteAllBytes(plan.path, bytes);

                        if (stopwatch != null)
                        {
                            timing.serializeMs = encodeStart;
                            timing.encodeHashMs = writeStart - encodeStart;
                            timing.writeMs = CaptureTiming.ElapsedMs(stopwatch) - writeStart;
                            timing.fileBytes = bytes.Length;
                        }

                        prune(Telemetry.config, plan.directory);
                        return new ExportResult { path = plan.path, fileHash = hash, themeHash = plan.themeHashHex, delta = plan.delta != null };
                    }

                    // Legacy YAML escape hatch — byte-for-byte the pre-v2 writer
                    // behavior, including the gzip signpost TelemetryConfig.gzip.
                    var yaml = serialize(snapshot);

                    var encodeStartYaml = stopwatch != null ? CaptureTiming.ElapsedMs(stopwatch) : 0f;
                    var yamlBytes = encodeFileBytes(yaml, plan.gzip);
                    var hashYaml = sha256Hex(yamlBytes);
                    var writeStartYaml = stopwatch != null ? CaptureTiming.ElapsedMs(stopwatch) : 0f;
                    File.WriteAllBytes(plan.path, yamlBytes);

                    if (stopwatch != null)
                    {
                        timing.serializeMs = encodeStartYaml;
                        timing.encodeHashMs = writeStartYaml - encodeStartYaml;
                        timing.writeMs = CaptureTiming.ElapsedMs(stopwatch) - writeStartYaml;
                        timing.fileBytes = yamlBytes.Length;
                    }

                    prune(Telemetry.config, plan.directory);
                    return new ExportResult { path = plan.path, fileHash = hashYaml, themeHash = null };
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
                    // The ledger fields (mode/theme/base/anchor) were all collected
                    // main-thread at prepareWrite; only the file hash arrives here.
                    Telemetry.events?.snapshotTaken(buildLedgerInfo(plan, result.fileHash));
                    // ADR-0001: one aggregate timing log line per exported capture,
                    // emitted here at the natural completion point — after the write
                    // succeeded, on the main thread, gated by the same carrier
                    // (captureTimingEnabled → non-null) the whole pipeline uses.
                    timing?.emit();
                }
                return result;
            });
        }

        private sealed class WritePlan
        {
            public string directory;
            public string path;
            public bool gzip;
            public SnapshotFormat format;
            public UISnapshotBinaryWriter.ThemeMode themeMode;
            public string themeHashHex;
            public uint themeHashValue;
            public bool themeManifestDirty;
            public SnapshotDelta delta;
            public events.SnapshotTakenInfo ledger;
        }

        /// <summary>
        /// Main-thread write preparation: reserves the output path and collects all
        /// metadata the <see cref="Measurements.UiSnapshotTaken"/> point will need
        /// (except the file hash, which is only knowable after the bytes are
        /// written). Serialization happens later, on the thread pool — see
        /// <see cref="exportToFileAsync"/>.
        /// </summary>
        private static WritePlan prepareWrite(UISnapshot snapshot, SnapshotDelta delta)
        {
            var config = Telemetry.config;
            var app = snapshot.app;
            var view = snapshot.view;

            var directory = resolveDirectory();
            Directory.CreateDirectory(directory);

            var utcNow = DateTime.UtcNow;
            var format = config.snapshotFormat;
            var path = reservePath(snapshot, directory, utcNow, format);
            var themeMode = UISnapshotBinaryWriter.ThemeMode.Absent;
            var themeHashHex = (string)null;
            var themeHashValue = 0u;
            var manifestDirty = false;

            if (format == SnapshotFormat.Binary && snapshot.theme != null)
            {
                // ADR-0007: session-scoped manifest by reference; anything that
                // breaks the session context (no events collector, externallly
                // built snapshot without a usable hash) degrades to the inline
                // encoding — the standalone-loadable fallback, never silence.
                themeHashHex = UISnapshotBuilder.currentThemeHashHex();
                var sessionId = app?.sessionId;
                if (!string.IsNullOrEmpty(sessionId) && !string.IsNullOrEmpty(themeHashHex))
                {
                    themeHashValue = FnvFromHex(themeHashHex);
                    manifestDirty = ThemeManifestStore.register(
                        sessionId, themeHashValue,
                        UISnapshotBuilder.currentTheme() ?? snapshot.theme);
                    if (manifestDirty)
                    {
                        themeMode = UISnapshotBinaryWriter.ThemeMode.ManifestRef;
                    }
                    else
                    {
                        themeMode = UISnapshotBinaryWriter.ThemeMode.Inline; // guard: registry refused → self-contained bytes
                    }
                }
                else
                {
                    themeMode = UISnapshotBinaryWriter.ThemeMode.Inline;
                }
            }

            return new WritePlan
            {
                directory = directory,
                path = path,
                gzip = config.gzip,
                format = format,
                themeMode = themeMode,
                themeHashHex = themeHashHex,
                themeHashValue = themeHashValue,
                themeManifestDirty = manifestDirty,
                delta = delta,
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
                    source = snapshot.source,
                    themeHash = themeHashHex,
                    contentMode = delta != null ? "delta" : "anchor",
                    baseHash = delta?.baseHash,
                    anchorHash = delta?.bases != null && delta.bases.Count > 0 ? delta.bases[0] : null
                }
            };
        }

        internal static uint FnvFromHex(string hashHex)
        {
            // The hash travels as "x8" hex; recover the u32 without a new scheme —
            // one parsing rule, guarded (a null/short hex never yields a bogus key).
            if (string.IsNullOrEmpty(hashHex))
            {
                return 0;
            }
            return uint.TryParse(hashHex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value)
                ? value
                : 0u;
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
        /// YAML path only; v3 binary is written byte-for-byte (no gzip needed).
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
        private static string reservePath(UISnapshot snapshot, string directory, DateTime utcNow, SnapshotFormat format)
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

            var extension = format == SnapshotFormat.Binary ? ".mds" : (config.gzip ? ".yaml.gz" : ".yaml");
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
        /// The glob covers every format version this project wrote (YAML schema
        /// v1/v2 both lived under .yaml[.gz], v3 is .mds) *and* the session theme
        /// manifests — which ships with the acknowledged ADR-0007 consequence
        /// that pruning can unresolve a hash → manifest → theme pair; the viewer
        /// degrades with a warning instead of a wrong replica (retention stays
        /// on the session root, never files individually).
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
                foreach (var pattern in new[] { "*.yaml", "*.yaml.gz", "*.mds" })
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
