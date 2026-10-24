/**
 * Composite replica resolution — which snapshots stack on screen at a
 * playhead time t (used by the telemetry viewer's timeline replica panel,
 * 2026-10-21): every *view span* that covers t renders its own capture,
 * ordered by canvas layer so dialogs/snackbars overlay the main view.
 *
 * DOM-free on purpose: this module carries the layer-rank + pick rules;
 * `replica.ts` carries the rendering. The pick rules are:
 *
 * - **Canvas layer rank** (stacking order, from `UI.CanvasLayer` — the enum
 *   order *is* the render priority): BACKGROUND < DEFAULT < MENU < POPUP.
 *   Unknown/null layer names ride DEFAULT. Ties: server NLE row, then open
 *   time (later paints above — DOM order).
 * - **Active capture per span**: latest anchor ≤ t within the span; before a
 *   span's first anchor the *opening* capture applies (the runtime captures
 *   asynchronously, so the `ui_snapshot_taken` ledger point lands a few
 *   milliseconds after the `view_open` event the playhead rests on —
 *   "latest ≤ t" alone would leave every opening event blank).
 * - **Legacy fallback**: a playhead inside no span (or covering spans without
 *   captures) falls back to the global anchor chain, latest ≤ t — the
 *   pre-composite behavior of `Extra/snapshot-viewer`.
 */

/** A view life-cycle span (structural twin of the client's TimelineViewSpanDto). */
export interface CompositeSpanLike {
  index: number;
  viewId: string | null;
  openMs: number;
  closeMs: number | null;
  layer?: string | null;
  row?: number;
}

/** A snapshot ledger anchor (structural twin of the client's TimelineSnapshotDto). */
export interface CompositeAnchorLike {
  /** Global snapshot index (the ref the client fetches the artifact by). */
  index: number;
  ms: number;
  viewId: string | null;
}

/** Canvas layer name → stacking rank (enum order of `UI.CanvasLayer` = z-order). */
export const CANVAS_LAYER_RANK: Readonly<Record<string, number>> = {
  BACKGROUND: 0,
  DEFAULT: 1,
  MENU: 2,
  POPUP: 3,
};

const EPS = 1e-9;

export function canvasLayerRank(layer: string | null | undefined): number {
  if (layer == null) return CANVAS_LAYER_RANK.DEFAULT!;
  return CANVAS_LAYER_RANK[String(layer).toUpperCase()] ?? CANVAS_LAYER_RANK.DEFAULT!;
}

/** One rendered layer of the composite; `span === null` on the legacy fallback. */
export interface CompositeLayer<S extends CompositeSpanLike, A extends CompositeAnchorLike> {
  span: S | null;
  anchor: A;
}

export interface CompositeResult<S extends CompositeSpanLike, A extends CompositeAnchorLike> {
  /** Bottom → top painting order (base layer first). */
  layers: Array<CompositeLayer<S, A>>;
  /** True when no span covered the playhead and the global chain was used. */
  fallback: boolean;
  /** Human-readable reason, exactly when `layers` is empty. */
  reason: string | null;
}

/**
 * Resolve the composite replica for playhead time `tMs`.
 * `spans` are the view life-cycles, `anchors` the full snapshot ledger list
 * (time-ordered; re-sorted defensively per view id here).
 *
 * `stateMs` (2026-10-24): the *state* time for anchor selection, when the
 * playhead rests on an event that produces a capture a moment later —
 * mutation captures are debounced/settled, so a click's `ui_snapshot_taken`
 * ledger point lands (0.25–1.5 s) *after* the click event the playhead snaps
 * to. "Latest ≤ t" alone would show the pre-click state (the visitor sees the
 * previous mutation until the *next* event moves time past the capture).
 * `stateMs` resolves inside that open window instead — the captures taken
 * between the selected event and the next one are that event's consequence.
 * Span coverage still follows `tMs`; only the anchor pick is windowed.
 */
export function resolveComposite<S extends CompositeSpanLike, A extends CompositeAnchorLike>(
  spans: readonly S[],
  anchors: readonly A[],
  tMs: number,
  stateMs?: number | null,
): CompositeResult<S, A> {
  // Capture chain per view id, time-ordered.
  const anchorsByView = new Map<string, A[]>();
  for (const anchor of anchors) {
    if (anchor.viewId === null) continue;
    let list = anchorsByView.get(anchor.viewId);
    if (list === undefined) {
      list = [];
      anchorsByView.set(anchor.viewId, list);
    }
    list.push(anchor);
  }
  for (const list of anchorsByView.values()) {
    list.sort((a, b) => a.ms - b.ms);
  }

  const resolveMs = stateMs ?? tMs;

  const layers: Array<CompositeLayer<S, A>> = [];
  let covering = false;
  for (const span of spans) {
    if (!(span.openMs - EPS <= tMs && tMs <= (span.closeMs ?? Number.POSITIVE_INFINITY) + EPS)) continue;
    covering = true;
    const anchor = activeAnchorOf(anchorsByView.get(span.viewId ?? ""), span, resolveMs);
    // Spans without captures (legacy dedupe-era data) stay in the timeline
    // but contribute no layer — the resolution never invents captures.
    if (anchor === null) continue;
    layers.push({ span, anchor });
  }

  if (layers.length > 0) {
    layers.sort(
      (a, b) =>
        canvasLayerRank(a.span!.layer) - canvasLayerRank(b.span!.layer) ||
        (a.span!.row ?? 0) - (b.span!.row ?? 0) ||
        a.span!.openMs - b.span!.openMs,
    );
    return { layers, fallback: false, reason: null };
  }

  // Legacy fallback: no covering span (or none of the covering spans holds
  // captures) — the pre-composite rule, global chain latest ≤ resolveMs.
  const global = anchors
    .slice()
    .sort((a, b) => a.ms - b.ms)
    .reduce<A | null>((best, anchor) => (anchor.ms <= resolveMs + EPS ? anchor : best), null);
  if (global !== null) {
    return { layers: [{ span: null, anchor: global }], fallback: true, reason: null };
  }
  return {
    layers: [],
    fallback: covering,
    reason:
      covering
        ? "No capture covers this moment — the open spans hold no snapshots."
        : "No snapshot at this moment (before the first capture).",
  };
}

/**
 * The capture a span shows at `tMs`: latest anchor ≤ tMs inside the span;
 * before a span's first anchor the opening capture applies (async capture
 * lands a few ms after the `view_open` event the playhead rests on).
 * `tMs` here is the caller's *state* time (see resolveComposite's stateMs).
 */
function activeAnchorOf<A extends CompositeAnchorLike>(
  list: A[] | undefined,
  span: CompositeSpanLike,
  tMs: number,
): A | null {
  if (list === undefined || list.length === 0) return null;
  const upper = span.closeMs ?? Number.POSITIVE_INFINITY;
  let best: A | null = null;
  for (const anchor of list) {
    if (anchor.ms < span.openMs - EPS || anchor.ms > upper + EPS) continue;
    if (anchor.ms <= tMs + EPS) best = anchor;
    else break;
  }
  return best ?? list.find((anchor) => anchor.ms >= span.openMs - EPS && anchor.ms <= upper + EPS) ?? null;
}
