using System;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Builds the device-agnostic <em>storage keys</em> written into
    /// <see cref="events.Measurements.UiSnapshotTaken"/> ledger points.
    ///
    /// Snapshot files stay flat on disk (legacy layout, collision-suffixed
    /// names); a storage key maps a written file to its place under the
    /// convention root the telemetry viewer resolves it at:
    /// <c>snapshots/&lt;yyyy&gt;/&lt;mm&gt;/&lt;dd&gt;/&lt;fileName&gt;</c>, always forward
    /// slashes, so the same key space works verbatim for a future S3/object
    /// store target. Keys are derived from the same timestamp that names the
    /// file on disk, which keeps key ↔ file trivially verifiable (the leaf is
    /// exactly the on-disk file name); the content hash in the ledger point is
    /// the authoritative join key, not the key.
    /// </summary>
    public static class SnapshotStorageKey
    {
        /// <summary> Convention root all snapshot storage keys live under. </summary>
        public const string Root = "snapshots";

        /// <summary>
        /// Builds the storage key for a written snapshot file.
        /// Tolerates absolute or relative paths (the leaf file name wins), but
        /// day directories always come from <paramref name="utcCaptureTime"/>.
        /// Returns null for null/empty inputs so callers cannot emit a
        /// half-meant key.
        /// </summary>
        public static string build(DateTime utcCaptureTime, string fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName))
            {
                return null;
            }

            var leaf = fileName;
            var slash = Math.Max(leaf.LastIndexOf('/'), leaf.LastIndexOf('\\'));
            if (slash >= 0)
            {
                leaf = leaf.Substring(slash + 1);
            }

            return $"{Root}/{utcCaptureTime:yyyy}/{utcCaptureTime:MM}/{utcCaptureTime:dd}/{leaf}";
        }
    }
}
