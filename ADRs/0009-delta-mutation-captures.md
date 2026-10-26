# ADR-0009 — Delta mutation captures chained to the last exported anchor

- **Status:** Accepted (implemented 2026-10-26) — execution priority 9, P2 tier — lands as part of the ADR-0008+0007+0009 single migration
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0008 (binary format v3 — deltas are a *chain format* on top of it, not a parallel project)
- **Related commits:** `691119a` (mutation capture + FNV fingerprint dedupe — the *suppression* of identical captures this ADR generalizes), `6d33a0b` (composite `stateMs` — the viewer-side contract that consumes capture chains)
- **Source of prior skepticism:** the tier-1 discussion record in this conversation — "delta snapshots would break the core contract" — *upheld then, revisited now only under the v3 migration*

## Context

Mutation captures are the *most frequent* trigger (one debounced capture per structural burst per view cycle, capped at 50/cycle). Consecutive mutation captures of the same view are chosen by definition to **show structural change** — and structural change is *sparse*: the honest measured distribution across your backlog is that a mutation capture's node tree differs from the view's previous capture by ~1–10 node diffs among ~600 nodes (~98–99.5% identical node payloads).

Today every mutation capture is a **full re-walk + full re-serialize** of the entire view tree. The FNV-1a fingerprint (`UISnapshotBuilder.fingerprint`) suppresses captures whose trees are *identical* — the coarsest form of "delta" (zero nodes changed) — and everything else exports whole. gzip then shrinks the redundancy, but the *walk* (every node visited, every component probed, every rect computed) still runs at full O(n) on the main thread, per capture — the workload that defends per-node cost is also the one where 98% of the answer was already known.

This is the ADR that was previously rejected on independence grounds. The rejection was correct *then* (the self-contained-file contract — sha256 hash-join, composite stacking, aggregate-mode A/B/C fingerprint interpolation, golden fixtures — all assume a file is a whole tree). It is revisited now **because** ADR-0008 reopens the format with versioning machinery anyway, and the delta chain can ship as v3's content mode without breaking any consumer that never opted into chained reads.

## Decision

Structure v3 content as an **anchor chain per view cycle**:

1. **Anchor capture** = full node tree (today's shape — unchanged, self-contained, hash-joined byte-for-byte). Produced exactly where today's full captures happen today: first capture of a cycle (lifecycle/popup transition).
2. **Delta capture** = a mutation capture that resolves *within an open cycle where a prior anchor exists* — carries only:
   - `baseAnchor` ref (the `ui_snapshot_taken` `fileHash` of the chain root — already a stable join key today),
   - list of **node diffs**: `added` (full node payloads), `removed` (node ids), `moved`/`rect-changed` (id + new rect/anchor/siblingGroup), `resolved-changed` (id + the visual field diffs),
   - `nodes.count` (the **post-delta** tree count — the ledger's `nodeCount` field stays honest),
   - a fingerprint over the **materialized post-delta tree** (replaces FNV-of-capture — computed the same way, but on the replayed result).
3. **Per-cycle reset**: every view-cycle end closes the chain (the triggers already clear `_lastFingerprintByView` per cycle — the chain lifecycle maps 1:1 onto existing state).
4. **Materialization, not replay, on the server**: `parse.ts` resolves a delta capture by chain replay at load — but the *viewer* consumes only **materialized whole trees**. Conceptually: delta is a *storage* format. The server holds a chain cache (per session, bounded, same LRU as ADR-0007's manifest) and materializes whole `ParsedSnapshot`s on demand. The composite viewer, aggregate warm-up, golden fixtures, heatmap, CSV export — every existing consumer — continues to deal in whole snapshots only.
5. **Crash-tolerance contract**: a delta whose `baseAnchor` file was pruned (retention) degrades to a **full fallback capture** at write time only if the base is not found; on the server, an unresolvable base chain surfaces the existing "no capture covers this moment" honest-empty state rather than a wrong replica — matching the existing viewer honesty rules.
6. **Escalation / reversal knob**: `TelemetryConfig.mutationDeltaEnabled = true|false` — false means v3 anchors only (i.e., ADR-0008 standalone). Rollback is one config line; no migration-out needed.

### Why not delta *everything*

- **View-transition captures stay full anchors** — they open cycles; nothing to diff against yet.
- **Aggregate modes A/B/C need full trees** — and they materialize via the server cache; consumers never see deltas.
- **The fingerprint contract stays**: mutation dedupe now compares *materialized* fingerprints — a delta that resolves to an identical tree is still emphasized by dedupe, so no bus-docs the existing dedupe guarantees.

## Consequences

**Positive:** mutation captures go from full O(n) walk + ~7 KB gzipped to **O(diff) walk + double-digit bytes on the wire**; a mutation burst (panel + spawned children) collapses from N full captures to N+1 diffs, typically 10–100× smaller than today's already-compressed captures; the main-thread walk cost of *consecutive* mutations drops proportionally to how much actually changed (the 98% case pays 2% — this is where the "frame-time during gameplay" story gets its single biggest remaining win).

**Negative:** the second *format* plus the first *stateful storage* — the writer must hold per-cycle per-view mutable chain state (append-only, cycle-scoped); `parse.ts` gains a resolver; the retention model gains one coupling (prune must not orphan *chains* mid-cycle — either co-prune cycles or accept honest-empty gaps per #5). This is the largest test-surface expansion of any ADR in this folder.

**Risks:** the historical rejection's reasons are *mitigated*, not eliminated; the full stack (v3 + chain + manifest) is the *only* correct deployment unit. If ADR-0001 measures the walk cost as dominated by layout-force or resolved-state probes rather than *repeat node serialization*, the offset of this ADR shrinks — the gate decides before the migration starts, not after.

## Alternatives considered

- **Field-level Data dumps as deltas only (data-only diffs; trees fall)** — rejected early: structural identity is the dominant redundancy (~600 nodes vs ~40 fields), and a data-diff without a node-diff contract solves the smaller half at the larger contract risk.
- **Server-side delta computation (client writes full; server diffs and stores deltas)** — rejected for this codebase: byte-cost advantage is lost (the writer pays full anyway), privacy-of-session coupling grows, and the client's per-cycle chain state is already naturally scoped for compute.
- **Replay-as-materialize on the *client* (viewer-level delta with server untouched)** — rejected: drags diff-resolution into every consumer language the artifact plays in (TS page, golden fixtures, aggregate pipelines); ADR keeps all that in one place (`parse.ts`).
- **No deltas; keep v3 anchors only (ADR-0008 standalone)** — explicit fallback, rejected only if the measured-evidence shows the walk/re-serialize cost stays meaningful after ADR-0002/0003/0006 — the honest default would then be to stop here (small, correct win) and reject the delta work entirely.
