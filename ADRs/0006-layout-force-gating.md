# ADR-0006 — Gate `UILayout.forceNow` on layout dirt rather than running it per capture

- **Status:** Accepted (implemented 2026-10-25) — execution priority 6, P1 tier
- **Date:** 2026-10-24
- **Deciders:** Tobias Stein
- **Depends on:** ADR-0001 (measures `forceNow` ms and whether skipping desyncs rects)
- **Related commits:** `a601dfe` (serialize off main thread — the layout force is now the biggest remaining unconditional main-thread block per capture)

## Context

`UISnapshotBuilder.build` starts with:

```csharp
if (Telemetry.config.forceRebuildLayout)
{
    UILayout.forceNow(root.rectTransform);
}
```

with the config tooltip documenting why: *Unity skips subtrees whose root has no `ILayoutController`, so the capture flushes the canvas queues and rebuilds the real layout roots instead.* Its purpose is correctness — capturing `rect`/`rectLocal`/anchor data before layout has run yields the classic "everything outside the root rect" snapshot that the viewer surfaces as a geometry warning (`parse.ts:73` `geometryWarning`).

But the force pays the full `LayoutRebuilder` cost — re-measuring text, recomputing layout groups, re-flowing ContentSizeFitters — **on the main thread, at capture time, with no question of whether layout is actually stale**. Two facts make it now mostly-preventable trauma:

1. **Trigger timing already anchors the capture at settle points.** View transitions capture after `viewTransitionSettle` (0.5 s); mutation captures fire after a 0.25 s quiet window. In both cases Unity has *very likely already* run layout naturally in the frames between the change and the settle — the force is a belt-and-suspenders against a case that mostly doesn't occur at these trigger points.
2. **The classic pathological snapshot ("capture before layout ran") is a *manual capture* story**: documented by the standalone viewer for hotkey captures that occur in the first frames after a transition. Automatic settle-anchored captures almost never hit it.

## Decision

Replace the unconditional force with a **dirt-gated force**:

1. **Subscribe (once, lazily on first capture) to the existing layout dirt signal.** UMDUI's layout system already knows when a rebuild became dirty; if `UILayout` exposes that state, reset it when `forceNow` consumes it. If not, add the flag to `UILayout` (the module is package-internal, one bool — not an API surface).
2. **At capture time: `if (layout dirty) → forceNow`**, else proceed directly. A capture runs `forceNow` only when something in the canvas actually became dirty since the last consumed dirty flag — which at settle-anchored capture points means: almost never.
3. **Escalation safety rope**: after an export, cheaply verify the root rect matches the live root rect (`rect.width/height != 0` and every active node's `rect` inside the root — the exact check `geometryWarning` makes). If the violation appears in a capture that skipped the force, the *next* capture for that view runs with the force *unconditionally* (one-force recovery latch, logged once via the existing `[Telemetry]` convention). This turns "the gate was wrong" from broken captures into a self-healing fallback, and its trigger becomes a *signal* (visible in logs) rather than a silent correctness rot.
4. **Config semantics unchanged**: `forceRebuildLayout` becomes "force *unconditionally*, ignoring the gate" — a debug escape-hatch, default `false` (previously `true` was the default *because* there was no gate; tomorrow the gate is the mechanism, which is precisely why the change is gated to be flagged off first → verify over a session → flip default → keep the knob).

## Consequences

**Positive:** the largest remaining unconditional per-capture main-thread operation stops paying cost when it has no work to do; automatic captures get cheaper precisely where they're most frequent (mutation bursts during interactive use); the geometry-warning class of snapshots disappears as *data* rather than as *noise* (they only occur when layout genuinely wasn't run, which the latch then re-fixes).

**Negative:** adds one cross-module coupling to read (UITelelemetry → UILayout internal state); adds one soft recovery path with state to reason about ("why did this session force on capture 3? there's a log"); requires one extra test path (gate rounds failing → latch → recovered capture) in the manual capture workflow.

**Risks:** the biggest is *staleness of the dirt signal itself* — UGUI's rebuild queue is_BGR_API (Canvas.willRenderCanvases timing) and the view may have changed between the capture frame's start and the force (frames timing). The escalation latch is the design's answer: worst case, slow by one capture, never wrong-silently. Second risk: **the flag currently defaults to "always force"** — the migration sequence (ship gated → observe one session's log → flip default) protects against simultaneously flipping a correctness knob AND asserting its necessity in one step.

## Alternatives considered

- **Remove `forceRebuildLayout` and rely on settle-anchored timing** — rejected first-order: cheap to try, but every failure has the classic "geometry warning" symptom, which the tool would then blame on the viewer, not the capture. The gate + latch is the same intent with an explicit self-healing path.
- **Keep unconditional force; accept the cost** — defensible if ADR-0001 shows `forceNow` is single-digit % of build ms; this ADR's gate criteria exist exactly to decide between this option and the gate.
- **Move layout validation to the *viewer* (server-side rematerial為)** — rejected: the snapshot is the *promise* of what the app rendered; making the viewer fix invalid captures inverts the contract, and any legacy state (e.g. `composite` overlay stacking on `rect`) then compounds multiple wrong captures instead of surfacing one.
