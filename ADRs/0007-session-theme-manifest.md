# ADR-0007 — Session-scoped theme manifest instead of a per-snapshot theme block

- **Status:** Accepted (implemented 2026-10-26) — execution priority 7, P2 tier; contingent on ADR-0008
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0008 (binary schema v3) — only carries its own weight as part of a format migration
- **Related commits:** `a601dfe` (theme caching moved the *CPU* cost out of the per-capture path; this ADR is purely about bytes)

## Context

Every snapshot serializes a complete `SnapshotTheme` block — seed color, dark flag, device type, the full ~45-entry palette map, spacing table, sizing table, and the 15-entry typography table. Two facts have changed since this shape was chosen:

1. **The theme is now cached on the runtime side** (`a601dfe`'s content-hash invalidation), so the *runtime* cost of producing it is ~zero; only the *bytes* remain.
2. **gzip default-on demonstrated how poorly this block trades**: the theme block is the *most* compressible part of every file (identical across captures), measured at ~4.2 KB raw per file (~17% of a median capture) but *nearly zero* post-gzip. ADR-0001's session showed the CompareView mutation captures compress to 6.8 KB median — the theme block's byte weight is effectively gone from storage.

What remains is real only in specific sequels: (a) server-side `parse.ts` spends `js-yaml` cycles walking thousands of constant theme lines per snapshot per session load; (b) any future consumer reading *many* snapshots deserializes the same theme N times; (c) the ADR-0008 binary format will need *some* decision about the theme block, and "serialize it per capture" is the one decision it would inherit by default.

## Decision

Introduce a **session-scoped theme manifest** as part of (and only as part of) the ADR-0008 format work:

1. Snapshots carry `theme: {id: <hash>}` — the *same* FNV hash the runtime already computes for theme invalidation (`computeThemeHash`, `a601dfe`), not a new scheme.
2. A **manifest artifact per session** carries the full `SnapshotTheme` for each distinct hash used during that session: written on first use, appended if a theme switch appears mid-session (dark toggle, device reparenting, font reload — these are exactly the invalidation cases the hash already detects).
3. **Self-containment preserved by reference, not by repetition**: the existing `ui_snapshot_taken` ledger point gains one field (`theme` hash), and the server's snapshot loader resolves `themeHash → manifest → theme` before handing the ParsedSnapshot downstream. Snapshots remain self-contained in the *session* sense, not the *file* sense — which the composite viewer already models (it never inspects a snapshot without its session).
4. **Standalone legacy compatibility**: files produced while the manifest is not reachable (drag-and-drop a single `.yaml`/`.yaml.gz` artifact without its session) carry their full theme inline — detection is trivial (`theme.id` present vs. theme map present), and the exporter emits inline themes for manual/hotkey captures outside a session context.
5. **Server cache**: one LRU per session root in `snapshotStore` — the Simplest shape consistent with the existing snapshot/aggregate caching architecture (P6's coalescing already caches session-projection level).

## Consequences

**Positive:** per-snapshot parse cost drops by the theme map size; N snapshots of a session stop duplicating a constant; the ADR-0008 format gains a clean seam (every per-file *constant* block shares one write path).

**Negative:** the byte-size win is honestly *small post-gzip*; the win only matters for parse/load time. The manifest adds one more piece of session state — a snapshot that references a manifest hash that is *not resolvable* (manifest deleted/pruned independently) fails downstream; mitigation: retention bounds apply to the session root, not files individually, which the retention model already does *approximately well* today (prune `Telemetry/snapshots` counts files across both format extensions).

**Risks:** two-tier artifact addressing (file + manifest) breaks the drag-and-drop single-artifact model unless the inline-theme fallback is shipped *with* the format change. The fallback IS part of this decision, not follow-up.

## Alternatives considered

- **Do it now, YAML-only (before any format decision)** — rejected honestly: the runtime-side CPU cost was already fixed by `a601dfe`'s theme cache, so this would only trim gzip-compressible bytes — worth nearly nothing for the pain required (server lookup, cache, fallback, retention interlock).
- **Keep per-file themes, drop the idea** — reasonable and explicitly on the table until ADR-0008 is *initiated*; this ADR documents that the theme block is the *first* thing the format migration should restructure, because it is the highest-redundancy, lowest-information-density block in every file.
- **Delta theme—only carry deviations per snapshot** — rejected as design soup: it turns a constant block into per-capture bleed and forces a merge lattice into the parse layer. The session versioned-whole is cleaner.
