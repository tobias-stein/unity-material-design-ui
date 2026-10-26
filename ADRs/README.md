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
| [0010](0010-walk-node-pooling.md) | Walk-level node/data pooling | P2 | narrowed by 0009 (delta exports skip full serialization, the walk still allocates the fresh diff tree) — only advances on ADR-0001 evidence |
| [0011](0011-composite-resolution-cache.md) | Memoized composite resolution index (viewer) | P2 | viewer-scale trigger only |

## The one rule these records encode

A601dfe's lesson (and the historical reverts — cross-cycle dedupe starvation, pacing-as-dropper):
decide on measured numbers, not folklore. The P0 instrumentation ADR exists so that the
format-migration cluster (0007/0008/0009 — the only multi-order-of-magnitude project left)
is either **justified by the session data** or **explicitly declined with a number attached**.

## Deployment unit

ADRs 0007 + 0008 + 0009 form **one** migration (single versioned format change), never a
sequence of three. 0002/0003/0006 are independent code-path optimizations with no schema
coupling and can ship individually.
