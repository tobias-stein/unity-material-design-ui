# ADR-0008 — Binary snapshot format v3 (varint + string table), replacing per-file YAML

- **Status:** Accepted (implemented 2026-10-26) — execution priority 8, P2 tier — the "one deliberate format-migration" project
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0001 (gate: measured serialize-ms and file-size deltas)
- **Contingent:** ADR-0007 (theme manifest) lands as part of this migration, not separately
- **Related commits:** `a601dfe` (gzip default — the interpolation point this format must beat), `e6e91cdd` (YAML schema-v2 contract)

## Context

Snapshot files are currently YAML (`schemaVersion = 2`), gzip-compressed by default since `a601dfe`. Compared against plain YAML this is near-optimal *post-compression* (measured 5.7–11×, mutation captures up to 21×). Three residual costs the deflate stage structurally cannot remove:

1. **Runtime serialize cost** — YamlDotNet reflection-serializes the POCO graph per capture. `a601dfe` moved it off the main thread, which protects frame time but keeps the thread-side cost; it is still the slowest step of an export.
2. **Server parse cost** — `js-yaml` is one of the slowest general-purpose text parsers in the Node ecosystem; every viewer page load and every `importedFiles` pass pays full text re-parse per snapshot per session.
3. **Ceiling on compression** — deflate exploits *statistical repetition*, not *structural identity*. The CompareView's ~600 nodes repeat the same ~30 component-type names and ~15 resolved-color strings thousands of times as independently Huffman/table-coded tokens. A string-table format stores each *once*, then references it — post-gzip sizes still carry this redundancy because the table-coded tokens do not align with deflate's window.

An honest earlier position recorded in this project's history: *"plain binary loses to compressed YAML most of the time."* That remains true for naive binary (MessagePack-with-map-keys, protobuf) — both preserve per-node field-name overhead. What can beat gzip **and** be IL2CPP-safe with zero dependencies is a *columnar-leaning* hand-rolled layout with explicit string interning.

## Decision

Migrate snapshot storage to a self-contained, versioned binary format (schema **v3**), keeping YAML as the legacy read path (never removed) and remaining the default *debug* control under one config knob.

### Format sketch (the load-bearing parts)

```
Header:   magic 'MDS\n' (3B) | formatVersion=3 (1B) | schemaVersion=3 (u8) | flags (u8)
String    section: sequential length-prefixed UTF-8 entries (interned: types, names,
Table:    role names, hex colors, anon-fragment seeds, data field names)
Theme:    a session-writable manifest hash ref (ADR-0007) or inline fallback (u8 flag)
App/View: per-snapshot small POD (ints as zigzag varints, floats as IEEE-754 or
          quantized i16/i32 where the existing `round(to 0.01)` already quantizes)
Nodes:    columnar-leaning per-node stream:
          - id: u16 string-table ref (or anon-seed varint)
          - kind: u2 (ui|layout) packed
          - siblingIndex, active, isView, layer: 1 varint, packed
          - rect (4×i32 quantized, 0.01 precision — the round() contract already
            quantizes to 0.01 today, so this is *lossless* relative to current YAML)
          - layout/layoutElement/CSF/resolved: tag byte, then field stream
          - data: string-table-referenced field-name keys + toPlain-coded values
Children: the parent chain as a stack/manitou sequence — NOT a u-sibling parent-id
          string (the one place v2 carried redundancy that v3 should also drop;
          `parse.ts` already derives `childrenOf` from parentIds)
```

### Encoding principles

1. **All `float` fields quantize at the same round-points the runtime already applies** (`round()` = 0.01; colors = 8-bit channel) — the migration is *byte-exact* equivalent of v2 content, not a fidelity change.
2. **Strings interned via table** — including anon-id fragments; explicit, versioned means *anything* that might need uniqueness later (type full names for aggregate-mode matching) corresponds to a table slot.
3. **sha256 of the file bytes stays on the byte range** — the `ui_snapshot_taken` ledger and hash-join contract don't care about format.
4. **`.yaml.gz` never read-only**: `parse.ts` gains a magic sniff (`'MDS'`) → binary path → same `ParsedSnapshot` coming out — the whole mapping layer (`id` normalization, `childrenOf`, geometry warnings) is untouched. Old YAML files continue to parse by the existing sniff.

### Migration plan

1. Write-side: new `UISnapshotBinaryWriter` (C#, one file, `BinaryWriter`-familiar, IL2CPP-safe — no reflection, no dynamic emit). Reader-side: `parse.ts` binary branch (~200 lines; plain `DataView`).
2. Config knob `snapshotFormat = Yaml | Binary` — default **Binary** after a validation session, Yaml as the escape hatch (and the golden-fixture generator runs on both).
3. Golden parity: `extras/telemetry-viewer` — the same live session captured in both formats must produce **identical** `ParsedSnapshot` after parse. This is the *actual* acceptance test, run in CI-equivalent (`fixtures/golden` default sample regenerated for v3 with a `.mds` golden).
4. Retention/prune/`storageKey`/fileHash: existing `.yaml/.yaml.gz` prune glob gains the new extension; nothing else moves.

## Consequences

**Positive:** serialize ~10× faster (plain BinaryWriter vs YamlDotNet reflection); post-gzip? — **no gzip needed** (size ≈ 2× smaller than raw YAML and roughly on par with gzipped YAML; *delta* encoding inside v3 [see ADR-0009] is what delivers the next order); server parse drops to ~an order faster (`DataView` vs `js-yaml`); IL2CPP-safe with zero new deps (this is the design point that ruled out MessagePack/protobuf for this codebase).

**Negative:** bind-bytes-and-version file discipline is a **permanent commitment**: every future field needs an encoding decision in *two* languages (C# writer + TS decode). The migration refusal requires golden fixtures + a dual-writer prototype session. Debugging shifts to "open the tool" rather than "grep the text file" — tunneled through the existing viewer import (which is a good tool, but it's no longer `grep`).

**Risks:** writing a *second* format's reader is one of the classic `.too much hassle` traps in project history — mitigated by (a) golden parity + byte-level regression fixtures locked into the repo, (b) framing the whole thing as ADR-0008+0009+0007 as ONE migration (not three projects), (c) the Yaml writer staying shippable forever as the verbose escape hatch.

## Alternatives considered

- **MessagePack** — rejected specifically here: Unity+IL2CPP requires AOT resolver codegen (`mpc`) or preserved-reflection `link.xml` for a package shipped inside the C# app; map-key form is barely smaller than YAML per node; defeats the "2× smaller than gzip" ceiling via per-node keys (the формате decision that needs to *actually* beat gzip).
- **protobuf** — rejected: protoc toolchain in the Unity project group; schema evolution tooling that this codebase's one-runtime-package assumption doesn't need; string interning absent (protobuf's Core strings are per-message out of the box).
- **FlatBuffers / Cap'n Proto (zero-copy)** — rejected outright: the fit is wrong (ordered tree with string ids; serial *inline* strings don't fit flat sequential layouts).
- **gzip-only (stay on YAML+gzip)** — the *default* until ADR-0001 proves serialization or parse cost still dominates the budget — but it cannot beat deflate's ceiling on *token-identity* work, which the actual crash-heavy session (`CompareView` × 600 nodes) will keep paying.
