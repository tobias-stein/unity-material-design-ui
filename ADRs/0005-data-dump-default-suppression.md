# ADR-0005 — Default-value suppression for `Data`-struct dumps in snapshot nodes

- **Status:** Accepted (implemented 2026-10-25) — execution priority 5, P1 tier
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0001 (serialize-ms + file bytes attributable to default fields)
- **Related commits:** `a601dfe` (cached `_dataMembers` per Data type — this ADR extends the same cache)

## Context

Every `IUI` node in a snapshot carries a `data` map: `fillDataAndRoles` walks the element's bound `*Data` struct via reflection and serializes *every* public field through `toPlain(...)`. Three properties of these structs make a large fraction of those bytes predictable:

1. **Default values pervade the output.** Most Data structs are flat records modeled after Material specs (`SliderData.orientation = Horizontal`, `bool discrete = false`, `float value = 0`, enum fields at their `0` entry, `IconData.fill = false`). The meaured CompareView captures dump ~40 fields × ~600 nodes, where a typical node has 5–8 *interesting* values and the rest serialize as their defaults.
2. **Gemässler-list duplication.** Grid/list views repeat structurally identical per-row Data (same enum states, same unset strings) for every cell — the *same* default payload is emitted per instance rather than once.
3. **The fields that change are exactly why the node exists.** A snapshot's value as a debugging artifact is what *differs* from the Material default — the default is redundant with the code contract.

gzip already recovers the file size (which is why tier 1 didn't need this), but the parameters to optimize now are (a) main-thread walk/serialize CPU and GC (this ADR removes the `toPlain` calls and dictionary writes for default fields entirely), and (b) the *parse* cost on the server (`js-yaml` walks the same redundancy).

## Decision

Suppress fields whose value equals the Data struct's *construction default*, and keep the current dict-map shape unchanged.

### Mechanism

1. Per `Type` (same `_dataMembers` cache), additionally build a **default instance record**: `Activator.CreateInstance(dataType)` once, read its fields through the *same* cached `FieldInfo[]`.
2. At dump time, compare each field value against the default-record value:
    - structs/enums/primitives/strings: `value.Equals(defaultValue)` (boxed equality — bounded by ~40 fields × node count, still cheaper than serializing),
    - reference-typed Data payloads (UnityEvents etc.) are already reduced to `null` or names by `toPlain` — compare against their default-record counterpart with the same rule.
3. **Field with a non-default value → keep exactly as today.** No new schema, no new key semantics, no viewer change: the replica/fingerprints already tolerate sparse dicts (`fillDataAndRoles` currently skips `null` results — this only widens a skip rule that already exists).
4. **`colorRoles`/`textRole` extraction is NOT suppressed** — they are the *semantic* keys the mapping layer consumes and must remain complete even at default (matches the viewer's rendering table logic).
5. **Kill-switch**: `TelemetryConfig.dataDumpDefaults = true` fallback restores current behavior in one config line, so the change can be enabled instantly for diffing against production captures if a consumer complains.

### Correctness contract

- Two captures that *differ only in default-valued fields* must still produce different fingerprints if their *positional/structural* node identity differs (fingerprints are node-tree-based, not data-based — `UISnapshotBuilder.fingerprint` hashes ids/siblings/rects; visual `resolved` keys stay complete; no suppression in either).
- The suppression is **dump-layer only**: `UISnapshotBuilder.fingerprint` compares the same node trees, unaffected.
- The existing `SnapshotNode.resolved.colorRoles`/`textRole` mapping keys are untouched — they come from a separate extraction path (`getBinderData` field scan) that this ADR does not touch.

## Consequences

**Positive:** cuts the per-node `data` dict to the fields that define the node's *identity in context* (typically 5–8); reduces per-capture GC (fewer dicts/entries/`toPlain` recursions); smaller YAML *before* gzip means cheaper serialize+gzip; one less known class of "the snapshot shows the same 40 fields as default, everywhere" noise.

**Negative:** files stop being a *complete dump* of a Data struct's shape. Consumers that relied on reading default values directly from a snapshot must know the default is implied. Mitigations: the default is stable per Data *type* (compile-time contract), and the change is gated behind the existing camelCase schema so all consumers get the same suppression consistently through `parse.ts`.

**Risks:** value.Equals on a changed later-some-mutation instance (boxed `Data.Name` strings mutate) — but records are immutable in this codebase; **do not cache the default *instance's* values per capture across sessions** (the default is constructed once per Type per domain, which is the correct granularity — any suppression bug shows up as a missing/extra field, loud in the parity tool).

## Alternatives considered

- **Diff against last capture's Data per node (true per-node delta)** — rejected: that is a per-node *delta* format decision, not a per-field default-cleanup; reframe this as ADR-0009's job, where the entire capture chain gets a formal delta contract.
- **Suppress only a hardcoded noisy-field list** — rejected: per-field lists are a nightmare to maintain across dozens of Data structs and rot if defaults/fields change; the runtime default comparison is self-maintaining.
- **Do nothing; rely on gzip** — correct for storage bytes; rejected here because the CPU/GC and `js-yaml` parse reductions are the real targets after tier 1.
