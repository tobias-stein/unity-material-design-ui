using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Session-scoped theme manifest (ADR-0007) — one artifact per telemetry session
    /// ("theme-manifest-&lt;sessionId&gt;.mds", next to the snapshot files) that carries
    /// the full <see cref="SnapshotTheme"/> for each distinct theme hash used during
    /// the session. Snapshot files carry <c>theme: {id: hash}</c>
    /// (<see cref="UISnapshotBinaryWriter.ThemeMode.ManifestRef"/>) instead of repeating
    /// the ~45-entry block per capture; the viewer's loader resolves
    /// themeHash → manifest → theme before handing anything downstream.
    ///
    /// Self-containment preserved by reference, not by repetition: the manifest is
    /// written on first use and rewritten whenever a theme switch appears mid-session
    /// (dark toggle, device reparenting, font reload — exactly the invalidation cases
    /// the content hash detects). Standalone legacy compatibility (point 4): captures
    /// outside a session context carry their full theme inline —
    /// <see cref="resolveMode"/> decides — never silently.
    /// </summary>
    public static class ThemeManifestStore
    {
        /// <summary>Distinct themes registered for the current session (bounded by the invalidation cases themselves — 1-3 entries in practice).</summary>
        private static readonly Dictionary<uint, SnapshotTheme> entries = new Dictionary<uint, SnapshotTheme>();
        /// <summary>Theme entries serialized content-first (payload prepared in the deterministic sorted order the writer uses).</summary>
        private static readonly List<(uint hash, SnapshotTheme theme)> ordered = new List<(uint, SnapshotTheme)>();

        private static string sessionId;
        private static int revision;
        private static int writtenRevision;
        private static object gate = new object();

        /// <summary>
        /// Registers the theme for the current session hash and marks the manifest dirty
        /// (it is written on the exporter's pool thread — ordered against revision so a
        /// concurrent export can never overwrite a newer manifest with an older one).
        /// Returns false when the storage is not usable this way (no session id) — the
        /// caller then falls back to the inline encoding.
        /// </summary>
        public static bool register(string activeSessionId, uint hash, SnapshotTheme theme)
        {
            if (string.IsNullOrEmpty(activeSessionId) || theme == null)
            {
                return false;
            }

            lock (gate)
            {
                // A new runtime session invalidates the previous in-memory set — a
                // fresh manifest file (new session id in the name) makes this safe.
                if (sessionId != activeSessionId)
                {
                    if (entries.Count > 0)
                    {
                        Debug.LogWarning("[Telemetry] theme manifest: session changed, resetting in-memory themes.");
                    }
                    entries.Clear();
                    ordered.Clear();
                    sessionId = activeSessionId;
                    revision = 0;
                    writtenRevision = 0;
                }

                if (entries.TryGetValue(hash, out var existing))
                {
                    if (!ReferenceEquals(existing, theme))
                    {
                        entries[hash] = theme; // same hash must mean same content; refresh defensively
                    }
                    return true;
                }

                entries.Add(hash, theme);
                ordered.Add((hash, theme));
                revision++;
                return true;
            }
        }

        /// <summary>
        /// Writes a dirty manifest (if any) on the exporter's pool thread, under the
        /// registry lock so revisions never regress. Never throws at call sites.
        /// </summary>
        /// <remarks>
        /// <paramref name="directory"/> must be resolved by the caller on the main
        /// thread (the exporter's <c>WritePlan</c> does this in
        /// <see cref="UISnapshotExporter"/>.prepareWrite) — Unity forbids touching
        /// <c>Application.persistentDataPath</c> off the main thread, and this write
        /// runs on the exporter's pool thread.
        /// </remarks>
        public static void writeIfDirty(string directory)
        {
            if (string.IsNullOrEmpty(directory))
            {
                return;
            }

            try
            {
                // Re-check dirty under the lock: the flip to this thread may overlap
                // a concurrent export that already wrote the newer revision.
                lock (gate)
                {
                    if (revision == writtenRevision)
                    {
                        return;
                    }
                }

                var bytes = serializeManifest();
                if (bytes == null)
                {
                    return;
                }

                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, fileName());
                // Atomic-ish enough: the write replaces the file wholesale and the
                // entries set never shrinks mid-session (retention keeps whole files).
                File.WriteAllBytes(path, bytes);

                lock (gate)
                {
                    writtenRevision = revision;
                }
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
            }
        }

        private static string fileName()
        {
            return $"theme-manifest-{sessionId}.mds";
        }

        /// <summary>
        /// Manifest bytes: same "MDS" v3 container, flags=0 (its content section is
        /// simply a list of (hash, theme) entries instead of a snapshot — every
        /// consumer parses it with the same header/table primitives).
        /// </summary>
        private static byte[] serializeManifest()
        {
            List<(uint hash, SnapshotTheme theme)> snapshotCopy;
            lock (gate)
            {
                snapshotCopy = new List<(uint, SnapshotTheme)>(ordered);
            }

            return UISnapshotBinaryWriter.writeManifest(snapshotCopy);
        }

        /// <summary>Test/diagnostics count of the current registry.</summary>
        public static int entryCount => entries.Count;
    }
}
