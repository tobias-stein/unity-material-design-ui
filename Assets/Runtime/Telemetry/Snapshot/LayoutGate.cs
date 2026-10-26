using System.Collections.Generic;
using UnityEngine;

namespace mdu.ui.telemetry.snapshot
{
    /// <summary>
    /// ADR-0006 — the dirt-gated layout force and its escalation safety rope.
    ///
    /// Capture points are settle-anchored (view transitions 0.5 s, mutations a
    /// 0.25 s quiet window), so Unity has almost always applied layout naturally
    /// by the time a capture runs, and the unconditional pre-walk
    /// <c>UILayout.forceNow</c> mostly paid its full <c>LayoutRebuilder</c> sweep
    /// for nothing. The gate instead consults the package-wide dirt flag
    /// (<see cref="UILayout.isDirty"/>, marked by the same signals telemetry
    /// already subscribes to) and skips the force when layout is current.
    ///
    /// Because UGUI's rebuild queue is internal (no public "is anything queued"
    /// API), a wrong "not dirty" is possible (UGUI/TMP-internal dirt is outside
    /// the flag's reach) — the escalation rope below turns that from broken
    /// captures into a self-healing fallback: a gate-skipped capture is verified
    /// against the exact check the viewer's <c>geometryWarning</c> (parse.ts)
    /// makes, and a violation arms a one-force recovery latch so the *next*
    /// capture for that view runs with the force unconditionally (and logs the
    /// latch via the usual <c>[Telemetry]</c> convention — the trigger itself is
    /// the observable signal, not a silent correctness rot).
    /// </summary>
    internal static class UILayoutGate
    {
        /// <summary>
        /// View keys whose next capture must force unconditionally (ADR-0006
        /// recovery latch — one-force: consumed by the capture that runs it, so
        /// recovery re-arms only if the recovered capture is broken again).
        /// Same key convention as UISnapshotTriggers' per-view state: the view
        /// id, else the transform instance id string.
        /// </summary>
        private static readonly HashSet<string> _recoveryLatch = new HashSet<string>();

        /// <summary>
        /// Capture-time gate: whether this capture must run the layout force.
        /// True when the config escape-hatch asks for it
        /// (<see cref="TelemetryConfig.forceRebuildLayout"/> = force *unconditionally*,
        /// ignoring the gate), when layout became dirty since the last consumed
        /// state, or when the view's recovery latch is armed (consumed here). The
        /// dirt flag itself is consumed by <see cref="UILayout.forceNow"/>, so a
        /// forced capture leaves the flag fresh for the next decision.
        /// </summary>
        public static bool shouldForce(IUI root)
        {
            if (Telemetry.config.forceRebuildLayout)
            {
                return true; // debug escape-hatch: gate off, pre-ADR-0006 behavior
            }

            if (UILayout.isDirty)
            {
                return true;
            }

            var key = keyOf(root);
            return key != null && _recoveryLatch.Remove(key);
        }

        /// <summary>
        /// Verifies a capture that *skipped* the force (forced captures have
        /// current rects by construction). Runs the exact check the viewer's
        /// <c>geometryWarning</c> makes — root rect exists and is non-degenerate,
        /// then >20% of active nodes outside the root bounds — and on violation
        /// arms the one-force recovery latch for the view, logging it once per
        /// recovery event. Cheap: one pass over the already-built node list, no
        /// Unity API calls, no allocation.
        /// </summary>
        public static void verify(UISnapshot snapshot, IUI root)
        {
            if (snapshot == null || snapshot.nodes == null || snapshot.nodes.Count == 0 ||
                root == null || root.rectTransform == null)
            {
                return;
            }

            if (!hasGeometryViolation(snapshot))
            {
                return;
            }

            var key = keyOf(root);
            if (key == null || !_recoveryLatch.Add(key))
            {
                return; // already latched (a duplicate raise within one cycle)
            }

            Debug.LogWarning(
                $"[Telemetry] layout gate missed stale layout — '{snapshot.view?.name ?? key}' captured with rects " +
                "outside the root (view may have changed between the last layout state and the capture). " +
                "Next capture for this view forces the layout rebuild (ADR-0006 one-force recovery latch).");
        }

        /// <summary>
        /// Bitwise port of the viewer's <c>geometryWarning</c> (server parse.ts /
        /// standalone normalize.ts — both copies inhabit the same thresholds) so
        /// a snapshot the capture-layer latch flags is exactly the one every
        /// viewer surfaces a geometry warning for. Reads the serialized rounded
        /// values, not live transforms, so verdicts agree with what was exported.
        /// </summary>
        private static bool hasGeometryViolation(UISnapshot snapshot)
        {
            var nodes = snapshot.nodes;

            // parse.ts: root rect missing or zero-sized → no warning (an empty
            // capture has nothing geometry-aligned to compare against).
            var rootRect = nodes[0]?.rect;
            if (rootRect == null || rootRect.width == 0f || rootRect.height == 0f)
            {
                return false;
            }

            int active = 0;
            int outside = 0;
            for (int i = 0; i < nodes.Count; i++)
            {
                var node = nodes[i];
                if (!node.active || node.rect == null)
                {
                    continue;
                }

                var rect = node.rect;
                active++;
                if (rect.x >= rootRect.width || rect.y >= rootRect.height ||
                    rect.x + rect.width <= 0f || rect.y + rect.height <= 0f)
                {
                    outside++;
                }
            }

            return active > 0 && outside / (float)active > 0.2f;
        }

        /// <summary>Per-view gating key — the view's id, else its transform
        /// instance id string (same convention as suppressors/dedupe in
        /// UISnapshotTriggers). Null for a non-IView root (manual captures take
        /// the global gate only, no per-view latch).</summary>
        private static string keyOf(IUI root)
        {
            return root is IView view
                ? !string.IsNullOrEmpty(view.id) ? view.id
                    : view.rectTransform != null ? view.rectTransform.GetInstanceID().ToString()
                    : null
                : null;
        }
    }
}
