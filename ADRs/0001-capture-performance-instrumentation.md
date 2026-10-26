# ADR-0001 — Capture-side performance instrumentation before further optimization

- **Status:** Accepted (implemented 2026-10-24) — execution priority 1, gate for every ADR below
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Related commits:** `a601dfe` (tier 1+2: gzip default, main-thread serialize move, theme caching, reflection caching), `691119a` (runtime mutation capture)

## Context

Telemetry tier 1+2 removed the two largest known costs: snapshot files dropped to 5.7–11× smaller (mutation captures up to 21×) and the YAML serialization no longer runs on the main thread. What *remains* hot is unmeasured folklore:

- the `UISnapshotBuilder.walk()` main-thread tree visit (`GetComponent<IUI>` per transform, `GetWorldCorners` + `InverseTransformPoint` per node, per-node POCO allocations),
- `fillResolved`'s up to five `GetComponent` calls per node,
- `UILayout.forceNow` executed unconditionally when `forceRebuildLayout = true`,
- the encode/hash/write block on the worker thread,
- the viewer's server-side parse (`js-yaml`) at session load.

Every candidate below (ADRs 0002–0011) is plausible but none is currently justified *by data*. Two earlier optimizations in this codebase (the cross-cycle content dedupe, the pacing-as-dropper) were later reverted precisely because they were decided without measurement. Repeating that pattern is unacceptable — especially before investing in the structural ADR-0008/0009 (format migration + delta captures), whose cost can only be justified if the measurements show the residual cost sits where those ADRs operate.

## Decision

Add a permanent, always-on, zero-allocation-impact (one `Stopwatch`) timing layer around the capture pipeline, and use it to produce the numbers that gate every subsequent ADR.

### Instrumentation points

1. **`UISnapshotBuilder.build(root, source)`** — total build milliseconds (covers layout force, walk, theme hash walk, app info).
2. **`UISnapshotBuilder.walk()`** — node count, walk milliseconds (excluding layout force) — isolates the tree visit from the layout pass.
3. **`UISnapshotExporter.exportToFileAsync`** — serialize milliseconds (taken on the pool thread inside `RunOnThreadPool`), encode+hash milliseconds, file-write milliseconds, and result file size in bytes.
4. **`UITelelemetry` trigger layer (optional, same shape)** — debounce settle latency: raises → exported capture, so "coalescing quality" (`mutationDebounce` = 0.25 s producing one capture per burst) is visible.

### Output sink

Log lines follow the existing convention and ride the normal Unity console, e.g.:

```
[Telemetry] capture timing: source=mutation content=anchor nodes=612 build=7.3ms serialize=2.1ms encode=0.6ms write=1.2ms total=11.8ms file=8.4KB
```

(The `content=anchor|delta` segment was added by the ADR-0008/0009 format migration — 2026-10-26 — so the serialize/hashes numbers stay attributable to the actual workload; every phase above is unchanged.)

No inflow into InfluxDB and no schema change (this is diagnostics, not telemetry-of-telemetry). A config kill-switch (`captureTimingEnabled = true` by default) exists so shipping builds can silence the lines cheaply — the cost when disabled is one `if`, not a code path divergence.

### Gate criteria (each must have a number before its ADR advances)

| ADR below | Gate question | Data source |
|---|---|---|
| 0002 component sweep | What share of `build` is `fillResolved`? | Deep-profiler child spans during a CompareView session |
| 0003 string interning | GC bytes + string allocs per capture | Profiler allocation timeline; `nodes` × `total` correlation |
| 0005 default suppression | Serialize-ms and file bytes attributable to default-valued `data` fields | Serialize-ms delta on a synthetic dump of defaults |
| 0006 layout gating | `forceNow` ms, and does skipping it desync rects? | Build-ms with/without flag across a full demo playthrough |
| 0008 binary format v3 | Serialize-ms YamlDotNet vs BinaryWriter prototype; file-size delta beyond gzip | Prototype branch, same synthetic session |
| 0009 delta captures | Byte size of mutation capture payloads vs full captures after gzip | Zoom into the existing `.yaml.gz` backlog distribution |

## Consequences

**Positive:** every later decision is made on a measured number; regressions to the capture pipeline become visible immediately at ordinary `Debug.Log` granularity; matches the project's existing discipline of honest, self-documenting logs.

**Negative:** one more config knob; log lines during capture bursts (bounded by the existing pacing/debounce, so never per-frame volume).

**Risks:** trivially low — a `Stopwatch` around existing calls. There is no behavioral change to capture, dedupe, or export.

## Alternatives considered

- **Unity Profiler only (no permanent timing layer)** — rejected as *complement*, not substitute: the Profiler requires an attach + human, whereas this feeds the gate criteria from ordinary sessions and stays on for contributors.
- **Telemetry-of-telemetry (timing points into InfluxDB)** — rejected for now: would add schema + series cardinality to answer questions answerable with logs; revisit only if timing must be compared across sessions in the viewer.
- **Skip instrumentation and take ADR-0008/#0009 straightaway** — rejected: the format migration's cost is only defensible with measurements, and those ADRs are exactly the ones most likely to be *unnecessary* given gzip's already strong position.
