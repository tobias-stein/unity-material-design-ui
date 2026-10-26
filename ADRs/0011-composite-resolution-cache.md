# ADR-0011 — Cache the composite resolution index in the viewer (memoized + incremental)

- **Status:** Proposed (execution priority 11, P2 tier)
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0001's session-end evidence only indirectly — gated by a *viewer-side* threshold (large backlogs), not by Unity-runtime cost
- **Related commits:** `6d33a0b` (composite `stateMs` — the playhead contract the index serves), `1b9ee7a` (P7 composite replica), `ae81079`/`ceb64cd` (aggregate modes whose index requirements stay simpler)

## Context

`resolveComposite` (`composite.ts`) is pure and stateless — exactly why it was written that way — and every playhead move or live-poll tick rebuilds its working state from the raw inputs:

1. **`anchorsByView`** is re-derived by walking the full ledger list and bucketing per view (`O(anchors)`).
2. **Each per-view bucket is re-sorted** (time-ordered anchors — `O(anchors log anchors)` across buckets).
3. **The global legacy fallback re-sorts the full list** (line 134–137) before reducing to "latest ≤ resolveMs".
4. The per-span `activeAnchorOf` scan is bisect-free linear — fine per-span, but multiplied per playhead-tick × per-live-poll tick (a 1 s cadence, plus every pixel-drag of the timeline scrubber which re-resolves *continuously*).

Today's sessions stay comfortably under the cost floor: hundreds of anchors → sub-millisecond per resolution, invisible next to DOM composite rendering. The failure mode is a **scale change**: the documented design targets ("viewer should handle a multi-thousand-anchor session, live-polling indefinitely") turn `anchors log anchors` per tick × every tick of continuous live mode into a *per-second* workload that competes for the same thread as the replica render and the server fetch round-trip.

The reason this is last in priority: unlike every other ADR in this folder, the cost here is *client-imposed* and *bounded by one well-factored pure function* — it has no main-thread Unity implication, and the fix pattern is textbook (memoize per-session, invalidate incrementally), not architecture-real-space reshaping.

## Decision

Make `resolveComposite` **index-cached** behind a stable functional façade:

1. **A `CompositeIndex` cache type** holds, per session: `anchorsByView` bucket map (already sorted), the sorted global anchor list, and `spans` in layer-rank order. Built once per session load, then **appended incrementally** on new data (live mode produces appended anchors/spans — a new anchor appends to its bucket's sorted tail — `O(live arrival)` not `O(session re-sort)`).
2. **Cache key/validity**: session id + a cheap generation counter from the server (each timeline payload returning fresh data bumps it). The existing session-fetch path (`server/src/core/sessionProjection`, catalog cache at 1 s TTL) already knows when it re-fetched — the cache invalidation point is *that boundary*, not scattered state.
3. **API shape preserved**: `resolveComposite(spans, anchors, tMs, stateMs)` stays a pure call, and a module-level cache keyed by the *structural identity* of its inputs gives app code the same ergonomics (or an explicit `withCompositeIndex(...)` wrapper for the two call sites that care — timeline scrub + live auto-step; there are roughly two, found once in `replica.ts` usage).
4. **The fallback/reason and canvas-rank logic stay untouched** — only *where the inputs get their sorted/map state* changes.
5. **Tests own the contract**: existing `test/composite.spec.ts` cases must run unchanged (fail-closed contract: if a cache entry shapes differently from a fresh build, tests catch it — the whole cache is *presentation performance only*).

## Consequences

**Positive:** per-playhead-move cost becomes `O(log k)` instead of `O(n + n log n)` on a session of `n` anchors; live mode's anchors-per-second append costs stay flat; large-session timeline responsiveness survives scaling; the pure-function contract → cache purity relationship is the *easy-to-reason-about* kind of cache.

**Negative:** one more session-scoped cache alongside the server's `snapshotStore` LRU and aggregate caches — needs the same invalidation discipline (generation counter, leak check per session teardown); two call-site idioms (cached vs uncached path) for the same resolver.

**Risks:** the risk of *cache-correctness* bugs are the ordinary ones (stale generation, mutated array shapes mid-resolution) — mitigations are the memoization tests that already exist as the rule-set; the *behavioral* risk (cache serving wrong anchors) is fully covered by asserting content-equality against cache-off in the same runs.

## Alternatives considered

- **Bisect-full-anchor-chain per resolution (no cache)** — improves the linear scan in `activeAnchorOf` but keeps resolving *sorted/mapped per call*; shores the weakest half of the cost profile while skipping the actual wins.
- **Push composite resolution to the server (server resolves `stateMs` and returns the selected anchors)** — rejected: the composite must stay resolvable *on the client during scrubbing* without a per-move round trip (the whole pattern was built for 60fps-ish direct interaction), and a server-resolve variant ports the cache problem onto a multi-runtime surface instead of one.
- **Do nothing until backlogs actually grow** — the *default* position until a `make-big-session-lp` replay shows measurable UI feed-lag / rendered-frame drop; this ADR's explicit scale triggers (thousands of anchors, live mode) match the projections in `scripts/perf-check.mjs` only for stretching-out sessions.
