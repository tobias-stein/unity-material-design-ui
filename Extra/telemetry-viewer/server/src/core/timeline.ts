/**
 * Single-session timeline assembly (P2, plan §6.1/§9.1).
 *
 * Takes one projected {@link Session} plus the `ui_run` UI-event points that
 * belong to it and produces the ordered, snapshot-correlated timeline the web
 * client renders on canvas:
 *
 * - every `ui_event` appears, ordered by exact nanosecond timestamp;
 * - `view_open`/`view_close` events pair into {@link TimelineViewSpan}s with
 *   dwell seconds (pairs both ways: open→close and close-less-span);
 * - interaction events (`click`/`toggle`/`close`/`backdrop_click`) correlate
 *   to the latest snapshot anchor of the *same view_id* at or before the
 *   event (`latest ≤ t`, §6.1) — the playhead's snapshot for that moment;
 * - events before the first matching snapshot are **never dropped**: they
 *   ride the timeline with `unresolved: true` and the client pins them to the
 *   unresolved lane.
 */
import type {
  RawEvent,
  Session,
  SnapshotLedgerEntry,
  TimelineEvent,
  TimelineLane,
  TimelineSnapshotAnchor,
  TimelineSpanKind,
  TimelineViewSpan,
} from "../domain.js";

/** Lane layout order (top → bottom in the client); `unresolved` sits last. */
export const LANE_ORDER: readonly TimelineLane[] = [
  "views",
  "click",
  "toggle",
  "close",
  "backdrop_click",
  "unresolved",
];

const LANE_LABELS: Record<TimelineLane, string> = {
  views: "view_open / view_close(+dwell)",
  click: "click",
  toggle: "toggle(on/off)",
  close: "close",
  backdrop_click: "backdrop_click",
  unresolved: "unresolved(no snapshot)",
};

export interface TimelineFrame {
  sessionId: string;
  /** Event envelope; edges from start/end points or events, whichever exist. */
  startNs: string;
  endNs: string;
  startMs: number;
  endMs: number;
  /** ui_event count — **equals `<Session>` eventCount exactly** (invariance tested). */
  eventCount: number;
  unresolvedCount: number;
  events: TimelineEvent[];
  lanes: Array<{ lane: TimelineLane; label: string; count: number }>;
  viewSpans: TimelineViewSpan[];
  /** Number of NLE rows (tracks) the spans were packed into. */
  rowCount: number;
  snapshots: TimelineSnapshotAnchor[];
}

/**
 * Exact-epoch-ms float from an ns decimal string: `Number(ns / 1e6)` is the
 * exact integer part (below 2^53) and the ns remainder is folded in so
 * fractional precision stays where the float puts it.
 */
export function nsToExactMs(nsText: string): number {
  const ns = BigInt(nsText);
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6;
}

export function buildTimelineFrame(session: Session, sessionEvents: readonly RawEvent[]): TimelineFrame {
  const uiEvents: Array<{ event: RawEvent; type: string }> = [];
  for (const event of sessionEvents) {
    if (event.measurement === "ui_event") uiEvents.push({ event, type: event.tags.type ?? "" });
  }
  // Sources deliver sorted streams already; a full sort keeps every provider
  // shape honestly ordered (stable: same-instant points keep source order).
  uiEvents.sort((a, b) => (a.event.timestampNs < b.event.timestampNs ? -1 : a.event.timestampNs > b.event.timestampNs ? 1 : 0));

  // Correlation index: per view_id, the projection's anchors in time order
  // (the projection already sorts them). Snapshot ids/paths stay in the sort.
  const anchorsByView = new Map<string, SnapshotLedgerEntry[]>();
  for (const anchor of session.snapshots) {
    if (anchor.viewId === null) continue;
    let list = anchorsByView.get(anchor.viewId);
    if (list === undefined) {
      list = [];
      anchorsByView.set(anchor.viewId, list);
    }
    list.push(anchor);
  }

  const startNs = session.startNs ?? session.firstEventNs;
  const endNs = session.endNs ?? session.lastEventNs;
  const startNsText = startNs === null ? "0" : startNs.toString();
  const endNsText = endNs === null ? "0" : endNs.toString();
  const startMs = nsToExactMs(startNsText);
  const endMs = nsToExactMs(endNsText);

  // view_ids with runtime lifecycle points — separates "view" from "inferred"
  // spans on legacy data (inferred popup spans have no lifecycle pair at all).
  const lifecycleViewIds = new Set<string>();
  for (const { event, type } of uiEvents) {
    if ((type === "view_open" || type === "view_close") && event.tags.view_id) {
      lifecycleViewIds.add(event.tags.view_id);
    }
  }

  const spanKindOf = (layer: string | null, viewId: string | null): TimelineSpanKind => {
    if (layer === "POPUP") return "popup";
    if (layer !== null) return "view";
    return viewId !== null && lifecycleViewIds.has(viewId) ? "view" : "inferred";
  };

  // NLE row packing: spans of the same view share a preferred row (their
  // fragments are sequential and never overlap), other spans take the lowest
  // row free at their open — rows free up as spans end, so the track count
  // stays minimal (audio/video editor layout).
  const spans: TimelineViewSpan[] = session.views.map((span) => ({
    index: 0, // assigned after the sort below (it is the array ordinal)
    view: span.view,
    viewId: span.viewId,
    openNs: span.openNs.toString(),
    openMs: nsToExactMs(span.openNs.toString()),
    closeNs: span.closeNs === null ? null : span.closeNs.toString(),
    closeMs: span.closeNs === null ? null : nsToExactMs(span.closeNs.toString()),
    dwellSeconds: span.dwellSeconds,
    stillOpen: span.closeNs === null,
    kind: spanKindOf(span.layer, span.viewId),
    layer: span.layer,
    row: -1, // assigned below
  }));
  spans.sort((a, b) => (a.openMs < b.openMs ? -1 : a.openMs > b.openMs ? 1 : 0));
  const rowFreeAtMs: number[] = [];
  const preferredRowByView = new Map<string, number>();
  for (const span of spans) {
    const spanEnd = span.closeMs ?? endMs; // still-open spans hold their row to the frame end
    let row = span.viewId !== null ? preferredRowByView.get(span.viewId) : undefined;
    if (row === undefined || rowFreeAtMs[row]! > span.openMs) {
      row = rowFreeAtMs.findIndex((free) => free <= span.openMs);
      if (row === -1) row = rowFreeAtMs.length;
    }
    rowFreeAtMs[row] = spanEnd;
    if (span.viewId !== null) preferredRowByView.set(span.viewId, row);
    span.row = row;
  }
  const rowCount = rowFreeAtMs.length;

  // Index the spans by their client-visible ordinal (the sorted array position).
  spans.forEach((span, index) => {
    span.index = index;
  });

  // Spans grouped per view_id for event→span placement.
  const spansByView = new Map<string, TimelineViewSpan[]>();
  for (const span of spans) {
    if (span.viewId === null) continue;
    let list = spansByView.get(span.viewId);
    if (list === undefined) {
      list = [];
      spansByView.set(span.viewId, list);
    }
    list.push(span);
  }

  /** Span of the event's view that contains (or, failing that, is nearest to) t. */
  function spanIdFor(viewId: string | null, tMs: number): number | null {
    if (viewId === null) return null;
    const list = spansByView.get(viewId);
    if (list === undefined) return null;
    for (const span of list) {
      if (span.openMs <= tMs && (span.closeMs === null || tMs <= span.closeMs)) {
        return span.index;
      }
    }
    // Outside every span of this view: clamp to the temporally nearest span
    // (events before the first open / after the last close still belong to
    // that view's track visually).
    let best = list[0]!;
    let bestDist = Math.abs(tMs - best.openMs);
    for (const span of list) {
      for (const edge of [span.openMs, span.closeMs ?? Number.POSITIVE_INFINITY]) {
        const dist = Math.abs(tMs - edge);
        if (dist < bestDist) {
          best = span;
          bestDist = dist;
        }
      }
    }
    return best.index;
  }

  const events: TimelineEvent[] = uiEvents.map(({ event, type }, index) => {
    const ns = event.timestampNs.toString();
    let lane: TimelineLane | null = null;
    let unresolved = false;
    let snapshotIndex: number | null = null;
    if (type === "view_open" || type === "view_close") {
      lane = "views";
    } else if (type === "click" || type === "toggle" || type === "close" || type === "backdrop_click") {
      const viewId = event.tags.view_id ?? "";
      const list = viewId !== "" ? anchorsByView.get(viewId) : undefined;
      // Latest anchor for this view at or before the event (binary search).
      snapshotIndex = findPriorAnchor(list ?? [], event.timestampNs);
      if (snapshotIndex === null) {
        // No snapshot yet: the event cannot be placed on captured UI state.
        unresolved = true;
        lane = "unresolved";
      } else {
        lane = type;
      }
    } else if (type === "start" || type === "end") {
      // Runtime `type` collision: ui_event never carries start/end today, but
      // if a future runtime emits them they stay honest, not unresolved.
      lane = "views";
    } else {
      // Unknown type: keep it visible, grouped with unresolved (never dropped).
      unresolved = true;
      lane = "unresolved";
    }
    const viewId = event.tags.view_id ?? null;
    return {
      index,
      ns,
      ms: nsToExactMs(ns),
      type,
      lane,
      view: event.tags.view ?? null,
      viewId,
      spanId: spanIdFor(viewId, nsToExactMs(ns)),
      element: event.tags.element ?? null,
      elementType: event.tags.element_type ?? null,
      on: event.fields.on ?? null,
      dwellSeconds: event.fields.dwell ?? null,
      value: event.fields.value ?? null,
      snapshotIndex,
      unresolved,
    };
  });

  const laneCounts = new Map<TimelineLane, number>();
  for (const event of events) laneCounts.set(event.lane, (laneCounts.get(event.lane) ?? 0) + 1);
  const lanes = LANE_ORDER.map((lane) => ({ lane, label: LANE_LABELS[lane], count: laneCounts.get(lane) ?? 0 }));

  return {
    sessionId: session.id,
    startNs: startNsText,
    endNs: endNsText,
    startMs,
    endMs,
    eventCount: session.eventCount,
    unresolvedCount: events.filter((event) => event.unresolved).length,
    events,
    lanes,
    viewSpans: spans,
    rowCount,
    snapshots: session.snapshots.map((snapshot, index) => ({
      index,
      ns: snapshot.timestampNs.toString(),
      ms: nsToExactMs(snapshot.timestampNs.toString()),
      view: snapshot.view,
      viewId: snapshot.viewId,
      key: snapshot.key,
      hash: snapshot.hash,
      nodes: snapshot.nodes,
      width: snapshot.width,
      height: snapshot.height,
    })),
  };
}

/**
 * Index of the latest anchor with `timestampNs <= t`, or null when absent.
 * Shared rule (§6.1 "latest ≤ t, same view_id"): the timeline playhead and
 * the aggregate correlate with the very same lookup, so the two read models
 * can never drift apart.
 */
export function findPriorAnchor(
  anchors: readonly SnapshotLedgerEntry[],
  tNs: bigint,
): number | null {
  let low = 0;
  let high = anchors.length - 1;
  let found: number | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const anchor = anchors[mid]!;
    if (anchor.timestampNs <= tNs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Deterministic synthetic fixture generator for perf/robustness tests and the
 * `big-session` demo `.lp` (5k events, plan §14 P2 performance clause).
 * Timestamps stride forward evenly across `durationMs`.
 */
export function syntheticSessionLpData(
  sessionId: string,
  eventCount: number,
  startEpochMs: number,
  durationMs: number,
  opts: { viewId?: string; view?: string; togglesEvery?: number } = {},
): string {
  const viewId = opts.viewId ?? "bbb11111aaaa2222bbbb3333cccc4444";
  const view = opts.view ?? "SyntheticBigSession";
  const togglesEvery = opts.togglesEvery ?? 7;
  const lines: string[] = [];
  lines.push(`session,session=${sessionId},type=start value=1i ${(BigInt(startEpochMs) * 1_000_000n).toString()}`);
  lines.push(
    `ui_event,session=${sessionId},type=view_open,view=${view},view_id=${viewId} value=1i ${(BigInt(startEpochMs + 1) * 1_000_000n).toString()}`,
  );
  const step = Math.max(1, Math.floor((durationMs - 10) / eventCount));
  for (let i = 0; i < eventCount; i++) {
    const tMs = startEpochMs + 5 + i * step;
    const element = `UIElement_${(i % 40).toString().padStart(2, "0")}`;
    if (i % togglesEvery === togglesEvery - 1) {
      lines.push(
        `ui_event,element=${element},element_type=mdu.ui.Toggle,session=${sessionId},type=toggle,view=${view},view_id=${viewId} value=1i,on=${i % (togglesEvery * 2) === togglesEvery - 1 ? "true" : "false"} ${(BigInt(tMs) * 1_000_000n).toString()}`,
      );
    } else {
      lines.push(
        `ui_event,element=${element},element_type=mdu.ui.Button,session=${sessionId},type=click,view=${view},view_id=${viewId} value=1i ${(BigInt(tMs) * 1_000_000n).toString()}`,
      );
    }
  }
  const endMs = startEpochMs + 5 + eventCount * step + 1;
  lines.push(
    `ui_event,session=${sessionId},type=view_close,view=${view},view_id=${viewId} value=1i,dwell=${((endMs - startEpochMs - 1) / 1000).toFixed(3)} ${(BigInt(endMs) * 1_000_000n).toString()}`,
  );
  lines.push(`session,session=${sessionId},type=end value=1i ${(BigInt(endMs + 1) * 1_000_000n).toString()}`);
  return `${lines.join("\n")}\n`;
}
