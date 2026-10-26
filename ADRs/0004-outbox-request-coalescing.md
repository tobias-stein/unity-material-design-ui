# ADR-0004 — Coalesced delivery of pending event files in the InfluxDB outbox

- **Status:** Accepted (implemented 2026-10-25) — execution priority 4, P0 tier
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** none (behavioral, thread-safe transport change only)
- **Related commits:** `9681b1b` (outbox WAL), `7df3bb0` (eventFlushInterval 1s for live viewing), `2e3f01e` (ledger semantics)

## Context

The event side of telemetry uses a write-ahead outbox (`InfluxOutboxSink`): events batch in memory → 1 s / 64-point cadence → persisted to `pending-*.lp` *before* the first send attempt → POSTed as line protocol → file deleted on 2xx. Backoff is capped at 60 s and one request is always in flight.

Two properties of this design push operational costs that grow with the very scenario the outbox is designed for (InfluxDB unreachable → long backlog):

1. **One request per file, strictly oldest-first.** Draining a backlog of *N* files costs *N* sequential HTTP round trips. Each `pending-*.lp` file at the 1 s live cadence holds ~1–5 points (~100–700 bytes), so a two-hour offline session accumulates thousands of tiny files, and recovery drains at one-second-ish intervals instead of seconds.
2. **Per-file directory accounting on every batch** — `persistBatch()` re-enumerates `pending-*.lp` (startup scan) and then prunes + re-validates (`_pendingFiles.RemoveAll(p => !File.Exists(p))`). This is fine per batch, but multiplies into noticeable IO churn precisely while backlogged (each *new* batch is created by pruning the queue that already holds thousands of files).

Both matter most in the live-viewer workflow (`CATALOG_CACHE_MS` 1 s), where the *goal* is near-realtime small interesting deltas — the cadence must stay loose enough that batching more aggressively does not delay newness. The right fix is therefore neither "flush less often" (hurts live mode) nor "bigger files" (same thing) — it is decoupling *file granularity* from *delivery granularity*.

## Decision

Extend `InfluxOutboxSink.sendOldestAsync` to coalesce a bounded batch of pending files per request:

1. **Accumulate up to `pendingCoalesce` files** (new config field on `TelemetryConfig`, default `16`), or up to a byte budget (default 512 KB — same default InfluxDB write limits assumed in the runtime docs), whichever is exhausted first, starting from the oldest file in queue order.
2. **Concatenate file contents into one request body.** Line protocol is line-delimited, so joining files with `\n` requires no re-serialization: byte-for-byte safe, already-escaped, already timestamp-ordered per file (filenames and contents are monotonic).
3. **Delete only on 2xx, atomically**: all coalesced files are deleted *after* a successful response (delete-loop is the existing pattern; in-order one file at a time). Failure keeps *all* coalesced files, and the backoff timer applies once per attempt — the retry unit is intentionally coarse.
4. **Cap remains one request in flight.** No parallelism; the goal is head-of-queue drain speed per round trip, not throughput concurrency (matching the current design's fail-safe profile: at-least-once, idempotent by timestamp).
5. **File write cadence stays 1 s** — file size still grows on the live-cadence path only when the pending queue is large enough to flush coalescing; otherwise the immediate 1-point POST behavior is unchanged.

## Consequences

**Positive:** backlog drain goes from *N round trips* to ~(*N/coalesce*) — a two-hour offline session drains in seconds, not minutes. Fewer HTTP transactions per live session (assuming fewer than 16 points per second). No schema change; no change to the 1 s live-cadence contract; no change to `ui_snapshot_taken` ledger delivery (rides the same sink unchanged).

**Negative:** slightly larger worst-case retry units during a flaky connection — a file that would have succeeded standalone is now retried as part of a coalesced batch; the coalescing block (files displaced out of order) exists in the existing in-order queue, so failure ordering is *improved*, not worsened, except for latency to the *later* files in a failed batch (bounded by backoff, same as before).

**Risks:** request body size spikes (bounded by the byte budget; the config field exists to tune). Duplicate delivery windows on partial-success are unchanged (at-least-once semantics are already the contract — InfluxDB idempotency via measurement+tags+timestamp makes duplicates harmless).

## Alternatives considered

- **Raise `eventFlushInterval` to amortize file counts** — rejected: it would delay live-viewer newness, whose near-realtime property a recent commit (`8ce5a31`, live 1 s poll) was built to amplify. The file cadence isn't the problem — the *request* cadence is.
- **Append-to-single-file WAL (one live in-progress `pending` file, acked-prefix tracking)** — stronger: fewer files, fewer prunes. Rejected *for now*: it changes the file format to require byte-offset ack tracking (breaks crash-recovery simplicity), which is a bigger behavioral change than the runtime team has agreed to take on without the P0 measurement first (ADR-0001). Revisit only if coalescing proves insufficient.
- **Retain multiple in-flight requests (send files concurrently)** — rejected: keeps failure semantics complex for zero gain in a world where the bottleneck is round-trip count, not per-file latency; also the at-least-once idempotency window stays smaller with strict one-in-flight.
- **Do nothing (N round-trip drain is tolerable)** — rejected after reviewing the operational profile: the second worst impression the tool can leave on a stakeholder (after any capture/consolidation loss) is a multi-minute "recovery tail" after an InfluxDB hiccup.
