# ADR-0003 — Per-Type caching of string-built identity fields in the snapshot walk

- **Status:** Accepted (implemented 2026-10-25) — execution priority 3, P0 tier
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0001 (confirms string allocations are a real share of capture cost)
- **Related commits:** `a601dfe` (already caches binder MemberInfo, data-struct FieldInfo tables, and the theme block; this ADR covers the remaining per-*Type*-stable string work)

## Context

Three identity/label strings in `UISnapshotBuilder` are *recomputed from the same inputs on every node, on every capture*, although each is a pure function of the element's CLR type or already-known keys:

1. **`friendlyTypeName(Type)`** — `walk`/`fillNode` builds `"{type.Namespace}.{type.Name}"` per node per capture (`string.Concat` + substrings), for both `IUI` elements and plain RectTransforms (`"UnityEngine.RectTransform"` as a literal, still re-boxed through the same code path).
2. **`SnapshotNode.resolvedId` anon ids** — `resolveId` composes `anon:{parentId}/{siblingIndex}` per anonymous node; the capture of one *view cycle* produces dozens of identical `parentId` fragments for pool-reused layouts (the CompareView is almost entirely `anon`-keyed).
3. **`SnapshotNode.kind`** — the `iui != null ? "ui" : "layout"` ternary allocates nothing but is mentioned here only to document that the *real* remaining strings are #1 and #2.

Cost shape: these are pure managed GC allocations (strings) on the main thread during a capture. On the client profiler timeline they show up as capture-correlated GC spikes that contribute more to perceived STW-style stutter than to total GPU/CPU ms on large views. Unlike the theme block (ADR `a601dfe`), they cannot be hoisted per-*session* — they are per-*node* keys — but they *are* per-`Type`-interned: the set of distinct type-name strings in a real app is bounded (~30–50 for the C# package's components) and the set of distinct parent fragments is bounded by tree shape (and typically shrinks to pool reuse).

## Decision

Cache the per-`Type` work; intern parent fragments per *walk*:

1. **`friendlyTypeName` results are cached forever per `Type`** in `Dictionary<Type, string>`. Types are compile-time stable, and the string is a pure function of the type; the cache is write-once and never evicted (bounded by the app's component set). This mirrors the existing `_binderMembers` and `_dataMembers` caches structurally — same pattern, same lifetime, one more table.
2. **`resolveId`'s `parentId` fragment is interned per walk** via a single dictionary lookup in the `takenIds` pass (the walk already threads `takenIds`), so `anon:{parentId}/...` strings are constructed once per `(parentId, siblingIndex)` pair rather than once per node *capture*.
3. **No change to serialized output** — all caches return the exact strings that current code would build; the YAML payload remains byte-identical for a given tree. Golden fixtures in `snapshot-render` must stay green untouched.

## Consequences

**Positive:** kills the dominant per-capture string allocation class on the main thread; visibly shrinks GC spike magnitude for mutation bursts (the *frequent* trigger, unlike single cycle captures); matches the existing caching idioms so the code stays readable; zero schema/viewer coupling.

**Negative:** two more static caches whose lifetime must be documented ("Type-keyed, write-once, never evicted; safe in statics for the editor domain reload model because Unity reloads the domain in the editor and rebuilds them lazily").

**Risks:** low. Stale-cache correctness is the only hazard class — and it does not apply here because both cached values are pure functions of immutable inputs (a `Type`; a parent fragment inside one walk). There is *no* dependency on Unity object lifetime, so the Unity-null-becomes-Csharp-null trap used elsewhere in this codebase does not apply.

## Alternatives considered

- **Inter across captures (per view, like `_lastFingerprintByView`)** — rejected: cross-capture string lifetimes would need invalidation on view-cycle end (the triggers already cycle-reset three per-view dictionaries); the marginal gain over per-walk interning is bytes-per-cycle, not allocations *captured* (per-walk already eliminates the repeat), and cycle-scoped caches were already the source of the historical dedupe starvation bug.
- **Emit numeric/compact type ids in a string table (move schema)** — rejected here because that is the *format* decision (ADR-0008 owns string tables as a byte-format feature); sneaking it into the managed layer would muddy the two concerns.
- **Do nothing; rely on gzip for size** — correct for file size (strings deflate well), but these allocations are a *main-thread GC* cost during gameplay, not a file-size problem — gzip cannot help there.
