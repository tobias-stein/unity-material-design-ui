# ADR-0010 — Walk-level node/data pooling targeted at GC spikes during mutation bursts

- **Status:** Declined (2026-10-27) — execution priority 10, P2 tier; evidence: two sessions (`fab6c430…`, `b11f0639…`, 64 gc-instrumented captures on the CompareView demo): gen-0 collections inside capture windows occurred **0×** except a single `+1col` on a 160 ms outlier capture — where the pause landed in the *pool-thread* serialize phase (`serialize=104.8ms` vs 3.8 ms median, plus a coincident 16.4 ms write), i.e. exactly the phase the tier-1 move positioned off the main thread to absorb it. No collection ever coincided with the main-thread build/walk. The gate ("GC pressure is first-order, not noise") is not met, and the pool's own Risk section classifies its bugs as "the worst kind" — not justified by the numbers. Byte-probe caveat: `GC.GetAllocatedBytesForCurrentThread` measures a constant 0 under Unity's Boehm runtime (superseded by `Profiler.GetTotalAllocatedMemoryLong` in the timing line); the collection counter is the pause-proof instrument. Re-opens only when a Unity Profiler attach shows capture-correlated main-thread GC spikes in the walk.
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0001 (must show GC pressure is a first-order cost, not noise), ADR-0009 (if deltas land, full-tree allocation mostly disappears and this ADR likely dies)
- **Related commits:** `a601dfe` (HOISTED the per-capture *constant* allocations: theme block, enum arrays, per-type member tables)

## Context

Every capture allocates the entire POCO object graph from scratch — `new SnapshotNode` per transform plus its nested `List<string> children`, `SnapshotRect`/`SnapshotAnchor` children, `Dictionary data`, `SnapshotResolved`, plus the enclosing `List<SnapshotNode> nodes` — and throws the whole graph away once the export's serialize has completed. Measure against the dominant workload shape:

- A **mutation burst** (panel + its spawned children) produces 1 debounced capture — ~600 allocations of composite node objects + ~600 lists + dictionaries, *per capture*, on the main thread per capture.
- A mutation-heavy interactive session (your captured backlog: 37 CompareView captures in one day) allocates roughly 20k+ node objects in one play session.
- The allocation is the classic **gen0-timer minefield**: Unity's Boehm GC makes per-frame garbage costlier than .NET-native projects anticipate — capture-correlated GC spikes are exactly the accident profile that tier-1 already moved *serialization* off the main thread to escape.

Tier 1 deliberately did NOT pool node objects (it could not without risk) — the serialize path had just moved to a worker thread and cross-referencing pooled structure would have introduced an allocation-lifetime hazard during capture.

## Decision

Introduce a **per-the-process node pool** for `SnapshotNode`-family POCOs with an explicit lifecycle that is robust to threading:

1. **Pool scope: per walk, sealed by the returning UniTask** — a `SnapshotPool` (static) carries node families keyed by their inner type (`SnapshotNode`, `SnapshotRect`, `SnapshotAnchor`, `SnapshotLayout`, `SnapshotLayoutElement`, `SnapshotContentSizeFitter`, `SnapshotResolved`), built from scratch (or expanded) lazily when a walk begins, freed decided by the exporter's return — *not* between captures (the pool simply grows to high-water and stays).
2. **The pool is only usable while `build` runs on main thread** — nodes are pushed to it during the walk and *pop on completion of export, only on the result back-channel* (the existing `ContinueWith` continuation that runs on main thread after serialization). The pool's reuse-pass is thus guaranteed single-threaded by the same main-thread continuation chain the exporter already uses for the ledger.
3. **Serialization consumes nodes read-only on the pool thread** (unchanged since `a601dfe`) — pooling never hands references back to another walk until that read is provably complete. **This is the invariant the pool's lifecycle must guarantee** — anything else reintroduces the `data-dump-was-overwritten-by-pooled-next-capture` class of bug.
4. **Zero-API-surface change**: `SnapshotNode`-family types unchanged, the schema unchanged, and the *viewer is untouched* — this is purely an allocation-lifetime decision inside `UISnapshotBuilder`/`UISnapshotExporter`.

### What does NOT change

- The YAML output (byte-identical for a given tree).
- The fingerprint/dedupe contract (still compares node-tree identities).
- The threading model established by `a601dfe` (main-thread build; pool-thread serialize; main-thread completion).

## Consequences

**Positive:** per-capture GC drops to near-zero steady state after the pool reaches capacity on the largest view shape; mutation bursts emit no capture-correlated GC spikes; the *writer* path keeps paying its costs on a background thread without allocating a fresh tree of nodes each time in the main-thread walk.

**Negative:** a deliberate complexity increase in allocation lifetime — the *third* kind of lifecycle discipline in the codebase (structure pool, node pool, and Yaml escapes-null serialization) and every future change to `SnapshotNode`'s shape must remember to account for eligible-but-dirty-in-pool objects; pooling is the classic place where a bug produces subtly corrupt snapshots rather than visible errors — the golden-fixture + byte-parity tests must run under both pool sizes (fresh and exhausted).

**Risks:** pool-lifetime bugs are the *worst kind* to debug in Unity (corrupted POCOs serialize validly). Mitigations: pool bound check (`maxFiles`/`node-count ceiling` walked into a config cap so an unbounded session cannot grow the pool indefinitely), reset-node discipline (`null`-out all fields during pool-return — never permissive about partial resets), and the fixed continuation-chain threading contract.

## Alternatives considered

- **Struct-of-arrays rewrite of the POCO graph (make nodes not an object at all)** — strongest version, but this converges with ADR-0008's columnar format: if the format work happens, the *allocation shape problem dissolves* rather than needing a pool. This ADR should be evaluated in the same session as 0008/0009 — and if the format work is planned anyway, prefer pooling to be delegated to it, not built as an independent layer.
- **GC tuning/config (Unity incremental GC enablement)** — orthogonal and probably valuable regardless; not rejected, just not *replacing* the walk's allocation profile.
- **Captures piggybacked onto the render thread (no allocation hot-loop framing)** — rejected: changes the *timing* guarantees the current debounce/pacing model is designed around (triggers anchored at settle windows).
