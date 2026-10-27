// Type alias instead of `using System.Diagnostics;` — that namespace carries its own
// Debug class, which would make UnityEngine.Debug ambiguous in this file.
using Stopwatch = System.Diagnostics.Stopwatch;
using System.Globalization;
using UnityEngine;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// Per-capture timing accumulator (ADR-0001 — the measurement gate for every
    /// telemetry-performance ADR below this one). One instance per exported capture,
    /// created by the capture entry point only while
    /// <see cref="TelemetryConfig.captureTimingEnabled"/> is on, then threaded through
    /// build → dedupe → export: <see cref="UISnapshotBuilder.build"/> fills the
    /// main-thread phases (and the ADR-0010 GC gate markers), <see cref="UISnapshotExporter"/> fills the pool-thread
    /// phases (serialize / encode+hash / write / file bytes) and emits the single
    /// aggregate log line on the main-thread continuation after the write succeeded.
    /// Diagnostics only — nothing here enters the snapshot, the YAML, the ledger or
    /// the InfluxDB schema. When the kill-switch is off this object is never
    /// allocated; the disabled cost is one null check per phase, not a divergent path.
    /// </summary>
    public sealed class CaptureTiming
    {
        /// <summary>Capture source as reported in the log line (null for manual captures → "manual").</summary>
        public string source;

        /// <summary>
        /// Unscaled time of the first raise that opened this capture's mutation
        /// debounce window (NaN for non-mutation captures). Settle latency is read at
        /// emit time, so the whole wait — debounce window *and* any pacing in the
        /// deferred queue — lands in the settle number, not just the debounce part.
        /// </summary>
        public float firstRaiseTime = float.NaN;

        public int nodeCount;
        public float buildMs;

        /// <summary>Tree-visit wall time — excludes the layout force that precedes it (ADR-0006 gate).</summary>
        public float walkMs;

        /// <summary>
        /// ADR-0006: whether this capture ran the layout force (config
        /// escape-hatch, fresh dirt or recovery latch) or was gated off. Purely
        /// diagnostic — the gate hit-rate the ADR's decision criteria read from
        /// the session log.
        /// </summary>
        public bool layoutForced;

        public float serializeMs;
        public float encodeHashMs;
        public float writeMs;
        public long fileBytes;

        /// <summary>
        /// ADR-0010 gate markers, taken by <see cref="UISnapshotBuilder.build"/> on
        /// the main thread at build start: <see cref="System.GC.CollectionCount"/>
        /// of gen 0 (process-wide — collections are triggered by allocation from
        /// any thread) and <see cref="UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong"/>
        /// (process-wide Mono/Boehm allocated heap — Boehm's heap has no per-thread
        /// accounting; the delta still lands exactly where capture allocations
        /// land, and the CollectionCount delta is the pause-proven part).
        /// Deltas are computed at emit time on the same main-thread continuation.
        /// (Superseded probe: <c>GC.GetAllocatedBytesForCurrentThread</c> measured
        /// literally 0 under Unity's runtime — it does not track under Boehm.)
        /// The gate asks whether GC pressure is first-order, not for a phase
        /// attribution.
        /// </summary>
        public int gcGen0From;
        public long gcBytesFrom;

        /// <summary>Sum of the measured pipeline phases (build + serialize + encode+hash + write).</summary>
        public float TotalMs => buildMs + serializeMs + encodeHashMs + writeMs;

        /// <summary>
        /// ADR-0008/0009: what this export serialized — "anchor" (full v3 or legacy
        /// YAML tree) or "delta" (sparse chain member). Part of the timing line so
        /// the format-migration gate numbers (serialize-ms especially) stay
        /// attributable to the actual workload, per ADR-0001's source= convention.
        /// </summary>
        public string contentMode = "anchor";

        /// <summary>Cumulative elapsed milliseconds of a running stopwatch (allocation-free).</summary>
        public static float ElapsedMs(Stopwatch stopwatch)
        {
            return (float)((double)stopwatch.ElapsedTicks / Stopwatch.Frequency * 1000.0);
        }

        /// <summary>
        /// Emits the single aggregate capture-timing log line — once per exported
        /// capture, at the natural completion point (write returned, main thread),
        /// bounded by the existing pacing/debounce to never per-frame volume.
        /// </summary>
        public void emit()
        {
            var settle = float.IsNaN(firstRaiseTime)
                ? ""
                : $" settle={format((Time.unscaledTime - firstRaiseTime) * 1000f)}ms";

            Debug.Log(
                $"[Telemetry] capture timing: source={source ?? "manual"} " +
                $"content={contentMode ?? "anchor"} " +
                $"nodes={nodeCount} " +
                $"force={(layoutForced ? "forced" : "gated")} " +
                $"build={format(buildMs)}ms walk={format(walkMs)}ms serialize={format(serializeMs)}ms " +
                $"encode={format(encodeHashMs)}ms write={format(writeMs)}ms total={format(TotalMs)}ms " +
                $"file={format(fileBytes / 1024f)}KB " +
                $"gc=+{System.GC.CollectionCount(0) - gcGen0From}col/" +
                $"+{format((UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong() - gcBytesFrom) / 1024f)}KB{settle}");
        }

        private static string format(float value)
        {
            return value.ToString("0.0", CultureInfo.InvariantCulture);
        }
    }
}
