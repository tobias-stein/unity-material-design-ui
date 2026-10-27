# Telemetry Performance ADRs

Architecture Decision Records for pushing telemetry capture/viewer performance past the
tier-1+2 baseline (`a601dfe`: gzip default — measured 5.7–11×, mutation captures up to 21×;
main-thread serialize move; theme caching; Data-reflection caching).

**Numbering = execution priority.** ADR-0001 is the measurement gate — every subsequent
ADR must be justified by its numbers before advancing to implementation.

| ADR | Title | Tier | Gate / dependency |
|-----|-------|------|-------------------|
| [0001](0001-capture-performance-instrumentation.md) | Capture-side performance instrumentation | P0 — **do first, gates everything** | — |
| [0002](0002-fillresolved-single-component-sweep.md) | Single component sweep in `fillResolved` | P0 | 0001 (profiler share of `fillResolved`) |
| [0003](0003-per-type-string-interning.md) | Per-Type string caching in the walk | P0 | 0001 (string alloc share) |
| [0004](0004-outbox-request-coalescing.md) | Coalesced pending-file delivery in the outbox | P0 | none (transport only) |
| [0005](0005-data-dump-default-suppression.md) | Default suppression for Data dumps | P1 | 0001 (serialize-ms + bytes) |
| [0006](0006-layout-force-gating.md) | Gate `UILayout.forceNow` on layout dirt | P1 | 0001 (`forceNow` ms + desync check) |
| [0007](0007-session-theme-manifest.md) | Session-scoped theme manifest | P2 | contingent on 0008 |
| [0008](0008-binary-snapshot-format-v3.md) | Binary snapshot format v3 (varint + string table) | P2 | 0001 (prototype deltas) |
| [0009](0009-delta-mutation-captures.md) | Delta mutation captures on the anchor chain | P2 | lands **with** 0008 as one migration |
| [0010](0010-walk-node-pooling.md) | Walk-level node/data pooling | P2 | **Declined 2026-10-27** — 2 sessions / 64 timed captures: gen-0 collections never landed in a capture window (`+0col` ×63; one `+1col` whose pause fell in the pool-thread serialize phase). Re-opens on Profiler-proven capture-correlated main-thread GC spikes |
| [0011](0011-composite-resolution-cache.md) | Memoized composite resolution index (viewer) | P2 | **Declined 2026-10-26** — session had 76 events / 32 anchors; the thousands-of-anchors trigger is ≥2 orders of magnitude away |

## The one rule these records encode

A601dfe's lesson (and the historical reverts — cross-cycle dedupe starvation, pacing-as-dropper):
decide on measured numbers, not folklore. The P0 instrumentation ADR exists so that the
format-migration cluster (0007/0008/0009 — the only multi-order-of-magnitude project left)
is either **justified by the session data** or **explicitly declined with a number attached**.

## Deployment unit

ADRs 0007 + 0008 + 0009 form **one** migration (single versioned format change), never a
sequence of three. 0002/0003/0006 are independent code-path optimizations with no schema
coupling and can ship individually.

## Session evidence (2026-10-26 — session `fab6c430…`, 69 s, first v3 session)

From 50 timed captures (Editor.log `capture timing` lines) + the on-disk `.mds` backlog:

- **Delta captures (0009) collapsed serialize+bytes for quiescent trees**: anchors
  avg ~13 KB / serialize 2–19 ms; quiescent deltas 1.4–3 KB, serialize 0.0–0.6 ms,
  total ≤6 ms; delta-heavy bursts 12–63 KB (per-node patches under actual churn).
- **The walk is the first-order main-thread cost**: per mutation capture avg 4.5 ms
  walk (worst 14.2 ms); anchors serialize comparably to their walk (up to 19 ms).
  With serialize no longer the dominant phase, the remaining question is GC
  pressure from the walk's fresh POCO tree → 0010's gate.
- **GC gate armed**: per-capture `gc=+Ncol/+XKB` (gen-0 collections process-wide +
  main-thread allocated bytes) now rides every timing line to answer 0010 on the
  next session's data.
- **0011 declined on the numbers** (76 events / 32 anchors vs its thousands-of-anchors
  trigger); **0010 stays Proposed** pending one more instrumented session.

## Session evidence (2026-10-27 — session `b11f0639…`, 64 s; the 0010 verdict)

From the gc-instrumented timing lines (32 captures) + the direct session API:

- **0010's gate is NOT met — declined**: gen-0 collections inside capture windows
  0×31/32; the single `+1col` capture is the instructive outlier
  (`serialize=104.8ms` / `write=16.4ms` vs 3.8/0.3 ms medians — a global GC pause
  plus disk hiccup landing inside the *pool-thread* phase, which the tier-1
  serialize move exists to absorb). No main-thread build/walk phase ever
  coincided with a collection → the capture does not create its own GC spikes.
- **Delta captures keep paying off**: quiescent deltas 1.4–2.5 KB / total ≤8 ms
  at 278–301 nodes; anchors 10 KB–74 KB (74 KB at 738 nodes — the largest tree
  yet) with serialize ≤4.6 ms.
- **Probe correction**: `GC.GetAllocatedBytesForCurrentThread` measures a
  constant 0 under Unity's Boehm runtime (dead on arrival — even 738-node walks
  reported `+0.0KB`); the byte probe is now `Profiler.GetTotalAllocatedMemoryLong`
  (process-wide Mono heap). The collection counter was the decisive instrument
  and works.
- **Server-side stale-manifest cache found and fixed** (viewer): the compare
  view session showed `theme manifest ref … unresolved` from snapshot 17+ —
  manifest bytes *did* contain the appended entries; the decoded-manifest cache
  never re-probed, and a degraded parse was itself cached by snapshot hash.
  Both fixed: byte-keyed decode cache + manifest-degraded parses are not cached.
