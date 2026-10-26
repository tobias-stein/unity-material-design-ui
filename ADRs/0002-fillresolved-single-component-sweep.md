# ADR-0002 — Single component sweep replacing per-type GetComponent calls in `fillResolved`

- **Status:** Accepted (implemented 2026-10-24) — execution priority 2, P0 tier
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0001 (profiler share of `fillResolved` in total build cost)
- **Related commits:** `a601dfe` (theme caching moved the theme block out of the per-capture path; this is the next-largest per-node cost)

## Context

`UISnapshotBuilder.fillResolved` resolves the *applied visual state* of every captured node via five independent component probes:

```csharp
go.GetComponent<TMP_Text>();      // text, font, textWidth, color
go.GetComponent<Image>();          // backgroundColor
go.GetComponent<CanvasGroup>();    // opacity
go.GetComponent<SDFQuad>();        // cornerRadius, fill/outline colors
go.GetComponent<SDFCircle>();      // fill/outline colors
```

Each `GetComponent<T>()` call is a separate native traversal of the GameObject's component array with its own filtering logic. On the measured backlog this is the largest remaining per-node main-thread cost: the CompareView captures have ~600 nodes (~187 KB raw). At five probes per node that is ~3,000 traversals per capture *of the same component list*, executed on the Unity main thread during gameplay — exactly where frame budget is scarcest.

This call pattern predates the telemetry feature itself (it mirrors the legacy snapshot viewer's builder) and was carried forward unchanged.

## Decision

Replace the five probes with **one** pooled native sweep per node, then dispatch on the swept component list:

```csharp
// pooled once per builder (no per-capture allocation)
private static readonly List<Component> _componentBuffer = new();

rect.GetComponents(_componentBuffer); // UnityEngine.Component.GetComponents(Type, List<Component>)
foreach (var component in _componentBuffer) { /* switch on type */ }
```

### Rules that preserve current semantics exactly

1. **At most one component of each kind is honored per node** — the switch must consume the *first* hit per type, not the last (the current sequential probes effectively do this; a cone of two SDF quads on one node resolves the first, and that contract is what the viewer's replica expects).
2. **The `any` flag logic is preserved**: a node with none of the probed components drops its `resolved` object unless `colorRoles`/`textRole` were already set by `fillDataAndRoles` (existing behavior, untouched).
3. **MonoBehaviours are not swept** — the buffer sweep only visits exactly the five types of interest via the same probe set; no behavioral expansion is smuggled in.
4. **Pooled buffer discipline**: the `List<Component>` is reused; if a reentrant call (or future threading) occurs, the buffer must be re-cleared per probe, not just reused.

### What this does NOT change

- Node identity, ids, fingerprints, and dedupe (fingerprints exclude resolved visuals by design).
- The exported schema — the YAML payload is byte-for-byte identical for a given live tree.
- `fillDataAndRoles`'s reflection path is *separately* covered by ADR-0003.

## Consequences

**Positive:** ~5× fewer native component lookups per node; the win scales with tree size (visible on the CompareView mutations, invisible on dialogs — that is fine, they are rare); zero allocations after warm-up; no schema or viewer change.

**Negative:** the `switch` dispatch adds a small managed branch cost per swept component; the code becomes slightly less obvious than five straight `GetComponent<T>` lines — the switch must be kept to a flat one-level mapping, no helper-soup.

**Risks:** order-of-types semantics (`first wins`) must match the prior probe order for mixed nodes; covered by the golden fixtures run in `Extra/telemetry-viewer/packages/snapshot-render/test/standaloneParity.spec.ts` — if the fixture parity thread goes green unchanged, semantics hold.

## Alternatives considered

- **Cache component presence per element between captures** — rejected: component graphs mutate at runtime (elements add remove Graphic/SDF layers), and a stale presence cache corrupts the *reliable* property of this exporter: every capture is a full snapshot of what is true *now*.
- **`TryGetComponent<T>` per candidate (same cost, different syntax)** — rejected outright: same per-probe traversal, only shorter code.
- **Probe only when the node is an `IUI`** — rejected: layout-only nodes carry Image/CanvasGroup state that the replica renders (background fills, opacity), so the sweep must stay unconditional.
