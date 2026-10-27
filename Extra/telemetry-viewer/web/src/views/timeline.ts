/**
 * Single-session timeline view (P2, plan §9.1, NLE rebuild 2026-10-21) —
 * canvas timeline in audio/video-editor layout:
 *
 * - **Rows (tracks)**: one row per *view*, not per event type. Every open/close
 *   cycle of a view renders as a clip on its view's row — main views and
 *   popup-layer views (Dialog, Snackbar) alike. Spans of the same view share
 *   one stable row (their covered-gaps stay visible, never merged); rows are
 *   reused as spans end so the track count stays minimal (server-packed `row`).
 * - **Filmstrip per row**: the mini-map blocks of the snapshots taken *inside
 *   that view's span*. Popup views capture their own snapshots at show(), so a
 *   dialog gets a real filmstrip; legacy popup rows render as tinted bars.
 * - **Events inside the filmstrip**: every interaction of a view is drawn as a
 *   marble inside that view's clip (click/toggle/close/backdrop colors;
 *   toggle=state dot; unresolved=hollow ring). Dense clusters collapse into a
 *   per-pixel density bar. Events without any view attribution ride a second
 *   ("no view") pseudo row — never dropped.
 * - **Ruler**: time axis with adaptive ticks; always pinned on top. Wheel =
 *   scroll rows when the session has more tracks than fit (max 3 visible),
 *   zoom at cursor otherwise (pinch/ctrl+wheel always zoom); shift+wheel =
 *   horizontal pan; drag = pan; dbl-click = fit.
 * - **Playhead**: draggable in the ruler, click-to-place; PgUp/PgDn snap to
 *   snapshot anchors; ←/→ step events; Home/End clamp. Every placement
 *   resolves to the temporally nearest event (`setPlayheadMs`), the event gets
 *   a ring marker, and the replica panel renders the *composite UI state* at
 *   the playhead (composite rework 2026-10-21): every view whose span covers
 *   the playhead renders its own capture, stacked bottom→top by canvas layer
 *   (dialogs/snackbars overlay the main view, placed from their captured root
 *   anchors). `applyReplicaHighlight` outlines the selected event's node in
 *   the matching layer; follow-selection (filmstrip/section clicks) chooses
 *   which layer carries the highlight outline.
 */
import { api, ApiClientError, type ParsedSnapshotDto, type SnapshotResponse, type TimelineEventDto, type TimelineResponse, type TimelineSnapshotDto, type TimelineViewSpanDto } from "../api.js";
import {
  buildReplicaStage,
  canvasViewportOf,
  computeMiniMap,
  defaultLightTheme,
  drawMiniMap,
  injectTheme,
  overlayPlacementFor,
  resolveComposite,
  type MiniMapData,
  type UISnapshot,
} from "@mdu/snapshot-render";

/* ----------------------------------------------------------------- layout */

const RULER_H = 34;
/** One track row: filmstrip band + event marbles. */
const ROW_H = 56;
/** Vertical viewport limit: more rows than this scroll instead of growing. */
const MAX_VISIBLE_ROWS = 3;
const HANDLE_HALF = 6;
const MIN_VISIBLE_MS = 1; // max zoom: ms resolution
const MINIMAP_CONCURRENCY = 4;

const MARBLE_COLORS = {
  click: "#81c784",
  toggle_on: "#d0bcff",
  toggle_off: "#4a4b57",
  close: "#ffb74d",
  backdrop_click: "#64ffda",
  unresolved: "#f2b8b5",
};

/** Static marble color; toggles resolve per-event to toggle_on/off. */
function marbleColor(type: string): string {
  if (type === "toggle") return MARBLE_COLORS.toggle_off;
  return (MARBLE_COLORS as Record<string, string | undefined>)[type] ?? MARBLE_COLORS.unresolved;
}

/** Span kind → clip palette [fill, edge]. */
function spanPalette(kind: TimelineViewSpanDto["kind"], stillOpen: boolean): [string, string] {
  if (kind === "popup") return stillOpen ? ["rgba(208,188,255,0.22)", "#d0bcff"] : ["rgba(208,188,255,0.18)", "#d0bcff"];
  if (kind === "inferred") return ["rgba(255,183,77,0.14)", "#ffb74d"];
  return stillOpen ? ["rgba(208,188,255,0.22)", "#d0bcff"] : ["rgba(138,180,248,0.16)", "#8ab4f8"];
}

const FILM_BG = "#221d2c";
const FILM_EMPTY_BG = "#1b2531";

export interface TimelineViewHandle {
  destroy(): void;
}

interface ReplicaEntry {
  index: number;
  parsed: ParsedSnapshotDto | null;
  error: { code?: string; message: string } | null;
}

export async function renderTimelineView(app: HTMLElement, sessionId: string): Promise<TimelineViewHandle> {
  document.body.classList.add("timeline-open");
  app.innerHTML = `<div class="state-block loading">Loading timeline for <code>${shortId(sessionId)}</code>…</div>`;

  let timeline: TimelineResponse;
  try {
    timeline = await api.timeline(sessionId);
  } catch (error) {
    const status = error instanceof ApiClientError ? error.status : 0;
    document.body.classList.remove("timeline-open");
    app.innerHTML = `
      <header class="topbar">
        <a class="btn small" href="#/">← Sessions</a>
        <div class="brand"><h2 class="session-title">Session timeline</h2></div>
      </header>
      <main class="layout"><section class="panel">
        <div class="state-block ${status >= 500 ? "err" : "warn"}">
          <h2>${status === 404 ? "Session not found" : "Timeline unavailable"}</h2>
          <p>${escapeHtml(String((error as Error)?.message ?? error))}</p>
          <a class="btn" href="#/">← Back to sessions</a>
        </div>
      </section></main>`;
    return { destroy() {} };
  }

  drawShell(app, timeline);
  const wrap = app.querySelector<HTMLDivElement>("#tl-wrap")!;
  const canvas = app.querySelector<HTMLCanvasElement>("#tl-canvas")!;
  const ctx = canvas.getContext("2d")!;
  const themeToggle = app.querySelector<HTMLDivElement>("#tl-theme-toggle")!;
  const replicaHolder = app.querySelector<HTMLDivElement>("#tl-replica-holder")!;
  const replicaViewport = app.querySelector<HTMLDivElement>("#tl-replica-viewport")!;
  const replicaMeta = app.querySelector<HTMLDivElement>("#tl-replica-meta")!;
  const replicaFooter = app.querySelector<HTMLDivElement>("#tl-replica-footer")!;
  const replicaWarnings = app.querySelector<HTMLDivElement>("#tl-replica-warnings")!;
  const replicaEmpty = app.querySelector<HTMLDivElement>("#tl-replica-empty")!;
  const zoomOutBtn = app.querySelector<HTMLButtonElement>("#tl-zoom-out")!;
  const zoomInBtn = app.querySelector<HTMLButtonElement>("#tl-zoom-in")!;
  const zoomFitBtn = app.querySelector<HTMLButtonElement>("#tl-zoom-fit")!;
  const zoom11Btn = app.querySelector<HTMLButtonElement>("#tl-zoom-11")!;
  const zoomLevel = app.querySelector<HTMLSpanElement>("#tl-zoom-level")!;
  const transportFirst = app.querySelector<HTMLButtonElement>("#tl-first")!;
  const transportPrev = app.querySelector<HTMLButtonElement>("#tl-prev")!;
  const transportNext = app.querySelector<HTMLButtonElement>("#tl-next")!;
  const transportLast = app.querySelector<HTMLButtonElement>("#tl-last")!;
  /** Playback (finished sessions only): play/pause toggle + event-step cadence. */
  const playbackBtn = app.querySelector<HTMLButtonElement>("#tl-play")!;
  const speedSelect = app.querySelector<HTMLSelectElement>("#tl-speed")!;

  // The replica owns its zoom/pan now (user request 2026-10-20): wheel over
  // it zooms (multiplying the fit scale), drag pans the zoomed stage, a
  // horizontal wheel pans. preventDefault keeps the page/gesture zoom out.
  replicaViewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        replicaHolder.scrollLeft += (event.deltaX !== 0 ? event.deltaX : event.deltaY) * 0.5;
        return;
      }
      setReplicaZoom(replicaZoom * Math.exp(-event.deltaY * 0.0022));
    },
    { passive: false },
  );

  let replicaPan: { x: number; y: number; left: number; top: number } | null = null;
  replicaViewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || replicaZoom <= 1) return; // fit fills the panel — nothing to pan
    replicaPan = { x: event.clientX, y: event.clientY, left: replicaHolder.scrollLeft, top: replicaHolder.scrollTop };
    replicaViewport.setPointerCapture(event.pointerId);
  });
  replicaViewport.addEventListener("pointermove", (event) => {
    if (replicaPan === null) return;
    replicaHolder.scrollLeft = replicaPan.left - (event.clientX - replicaPan.x);
    replicaHolder.scrollTop = replicaPan.top - (event.clientY - replicaPan.y);
  });
  const endReplicaPan = (): void => {
    replicaPan = null;
  };
  replicaViewport.addEventListener("pointerup", endReplicaPan);
  replicaViewport.addEventListener("pointercancel", endReplicaPan);

  /* ------------------------------------------------------------- row model */

  /**
   * The NLE model: spans packed on rows by the server, events attached to
   * spans, snapshot anchors scoped per span for the filmstrip blocks, and a
   * final pseudo row for events no view attribution could hold (never dropped).
   */
  interface RowSpan {
    span: TimelineViewSpanDto;
    events: TimelineEventDto[];
    /** Anchors of this span's view inside [openMs, closeMs|frame end]. */
    anchors: TimelineSnapshotDto[];
  }

  /* ----------------------------------------------------------- derived state */

  /**
   * Everything below re-derives from the TimelineResponse and rebuilds on each
   * live poll (`rebuildModel`); interactive state — viewport window, playhead,
   * selection, focus, replica/minimap caches — carries across polls.
   */
  let spanById = new Map<number, TimelineViewSpanDto>();
  let rowSpans = new Map<number, RowSpan[]>();
  let rowCount = 0;
  let NO_VIEW_ROW = 0;
  let rowOfSpanId = new Map<number, number>();
  let orphanEvents: TimelineEventDto[] = [];
  let orphanCount = 0;
  let totalRows = 0;
  let visibleRowsH = 0;
  let canvasH = RULER_H;
  let maxScrollY = 0;
  let frameStart = 0;
  let frameEnd = 1;
  /** Viewport frame in session-ms (padded [lo0, hi0]); rebuilt per poll. */
  let T0 = 0;
  let T1 = 1;
  let lo0 = 0;
  let hi0 = 1;
  let viewStart = 0;
  let viewEnd = 1;
  /** Playhead + the event it snaps to (closest-event invariant, see setPlayheadMs). */
  let playheadMs = 0;
  let selectedEventIndex = -1;
  let scrollY = 0;
  /** Dirty flag for the rAF-drawn canvas (shared with the drawing loop below). */
  let dirty = true;
  /** Set after the first rebuildModel — gates live-carry logic against the
   *  placeholder viewport state the initial call runs under. */
  let modelBuilt = false;

  /** Which span should the replica focus ("follow selection"); null = global fallback. */
  let focusedSpanId: number | null = null;

  /** Poll-stable span identity: view + open time (span indexes are append-only
   *  but rows are re-packed server-side; focus survives any re-packing). */
  const spanIdentity = (span: TimelineViewSpanDto): string => `${span.viewId}\u0000${span.openMs}`;

  /** Rebuild every derived construct from a fresh timeline response. */
  function rebuildModel(next: TimelineResponse): void {
    // Carry interactive state first (old frame geometry still applies here).
    const pinnedRight = modelBuilt && viewEnd + 1e-6 >= hi0; // parked at the session right edge
    const focused = focusedSpanId === null
      ? null
      : timeline.viewSpans.find((span) => span.index === focusedSpanId) ?? null;
    const focusedIdentity = focused !== null ? spanIdentity(focused) : null;

    timeline = next;
    frameStart = next.startMs;
    frameEnd = next.endMs;

    spanById = new Map();
    rowSpans = new Map();
    rowOfSpanId = new Map();
    for (const span of next.viewSpans) {
      spanById.set(span.index, span);
      const row = Math.max(span.row, 0);
      let list = rowSpans.get(row);
      if (list === undefined) {
        list = [];
        rowSpans.set(row, list);
      }
      list.push({ span, events: [], anchors: [] });
      rowOfSpanId.set(span.index, row);
    }
    for (const list of rowSpans.values()) {
      list.sort((a, b) => a.span.openMs - b.span.openMs);
    }
    rowCount = Math.max(next.rowCount, ...[...rowSpans.keys()].map((row) => row + 1), 0);
    NO_VIEW_ROW = rowCount; // pseudo row after the real tracks

    // Events → spans (spanId from the server; legacy events without rows keep
    // everything on the no-view row).
    orphanEvents = [];
    for (const event of next.events) {
      if (event.spanId === null && event.viewId === null) {
        orphanEvents.push(event);
        continue;
      }
      const spanId = event.spanId ?? nearestSpanIdFor(event.viewId, event.ms);
      if (spanId === null) {
        orphanEvents.push(event);
        continue;
      }
      const span = spanById.get(spanId);
      if (span === undefined) {
        orphanEvents.push(event);
        continue;
      }
      rowSpans.get(Math.max(span.row, 0))!.find((entry) => entry.span === span)!.events.push(event);
    }

    // Snapshot anchors grouped per view_id, then scoped into their span windows.
    const anchorsByViewId = new Map<string, TimelineSnapshotDto[]>();
    for (const anchor of next.snapshots) {
      if (anchor.viewId === null) continue;
      let list = anchorsByViewId.get(anchor.viewId);
      if (list === undefined) {
        list = [];
        anchorsByViewId.set(anchor.viewId, list);
      }
      list.push(anchor);
    }
    for (const list of anchorsByViewId.values()) {
      list.sort((a, b) => a.ms - b.ms);
    }
    for (const list of rowSpans.values()) {
      for (const entry of list) {
        const viewId = entry.span.viewId;
        const anchors = viewId !== null ? anchorsByViewId.get(viewId) ?? [] : [];
        entry.anchors = anchors.filter(
          (anchor) =>
            anchor.ms >= entry.span.openMs - 1e-9 &&
            anchor.ms <= (entry.span.closeMs ?? frameEnd) + 1e-9,
        );
      }
    }

    // Viewport frame: full session ± 2% (≥50 ms) padding — as before.
    T0 = next.startMs;
    T1 = Math.max(next.endMs, next.startMs);
    const pad = Math.max(50, (T1 - T0) * 0.02);
    lo0 = T0 - pad;
    hi0 = T1 + pad;

    orphanCount = orphanEvents.length;
    totalRows = rowCount + (orphanCount > 0 ? 1 : 0);
    const visibleRows = Math.min(totalRows, MAX_VISIBLE_ROWS);
    visibleRowsH = visibleRows * ROW_H;
    canvasH = RULER_H + visibleRowsH; // rows live below the pinned ruler
    maxScrollY = Math.max(0, totalRows * ROW_H - visibleRowsH);
    // The canvas is absolutely positioned; keep the wrap's explicit height current.
    wrap.style.height = `${canvasH}px`;

    // Focus follows the span identity, not the (possibly re-packed) index.
    if (focusedIdentity !== null) {
      focusedSpanId = next.viewSpans.find((span) => spanIdentity(span) === focusedIdentity)?.index ?? null;
    }

    // Live-follow: the right edge pinned to the old session end keeps tracking
    // "now"; a zoomed/scrolled window stays exactly where the user put it.
    if (pinnedRight && viewEnd > viewStart) {
      const span = viewEnd - viewStart;
      viewStart = hi0 - span;
      viewEnd = hi0;
    }

    // Selection invariant re-check: the playhead still snaps to the closest
    // event (it may have a new neighbour; ms-stable, never jumps otherwise).
    selectedEventIndex = closestEventIndex(playheadMs);
    if (selectedEventIndex !== -1) playheadMs = timeline.events[selectedEventIndex]!.ms;

    scrollY = clampScrollY(scrollY);
    updateTransport();
    dirty = true;
    modelBuilt = true;
  }


  /** Latest span of a view at-or-before t (client fallback for legacy events without spanId). */
  function nearestSpanIdFor(viewId: string | null, tMs: number): number | null {
    if (viewId === null) return null;
    let best: TimelineViewSpanDto | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const span of timeline.viewSpans) {
      if (span.viewId !== viewId) continue;
      const closeMs = span.closeMs ?? Number.POSITIVE_INFINITY;
      if (tMs >= span.openMs && tMs <= closeMs) return span.index;
      const dist = Math.min(
        Math.abs(tMs - span.openMs),
        Number.isFinite(closeMs) ? Math.abs(tMs - closeMs) : Number.POSITIVE_INFINITY,
      );
      if (dist < bestDist) {
        best = span;
        bestDist = dist;
      }
    }
    return best?.index ?? null;
  }

  /* ------------------------------------------------------- canvas geometry */

  rebuildModel(timeline);

  // Initial viewport: full session window, playhead on the first snapshot
  // (falling back to unscoped t0) snapped to its closest event.
  viewStart = lo0;
  viewEnd = hi0;
  playheadMs = timeline.snapshots.length > 0 ? (timeline.snapshots[0]?.ms ?? T0) : T0;
  selectedEventIndex = closestEventIndex(playheadMs);
  if (selectedEventIndex !== -1) playheadMs = timeline.events[selectedEventIndex]!.ms;
  scrollY = 0;
  function clampScrollY(value: number): number {
    return Math.min(Math.max(value, 0), maxScrollY);
  }
  function rowY(row: number): number {
    return RULER_H + row * ROW_H - scrollY;
  }
  function rowAt(y: number): number {
    return Math.floor((y - RULER_H + scrollY) / ROW_H);
  }
  /** Marbles/labels sit on the vertical center of their row. */
  function rowCenter(row: number): number {
    return rowY(row) + ROW_H / 2;
  }
  /** Scroll a row into the viewport (reveal of keyboard/programmatic jumps). */
  function revealRow(row: number): void {
    const top = row * ROW_H;
    const bottom = top + ROW_H;
    if (top < scrollY) scrollY = clampScrollY(top);
    else if (bottom > scrollY + visibleRowsH) scrollY = clampScrollY(bottom - visibleRowsH);
    dirty = true;
  }

  function canvasWidth(): number {
    return Math.max(canvas.clientWidth, 1);
  }

  function pixelsPerMs(): number {
    return canvasWidth() / Math.max(viewEnd - viewStart, Number.EPSILON);
  }

  function msAt(px: number): number {
    return viewStart + px / pixelsPerMs();
  }

  function pxAt(ms: number): number {
    return (ms - viewStart) * pixelsPerMs();
  }

  /** Clamp the visible window: inside the padded session, span ∈ [1ms, full]. */
  function setWindow(start: number, end: number): void {
    let span = end - start;
    span = Math.max(Math.min(span, hi0 - lo0), MIN_VISIBLE_MS);
    if (start < lo0) {
      start = lo0;
    } else if (start + span > hi0) {
      start = hi0 - span;
    }
    viewStart = start;
    viewEnd = Math.min(start + span, hi0);
    dirty = true;
  }

  function zoomAround(factor: number, focusPx: number): void {
    const focusMs = msAt(focusPx);
    const nextPpm = Math.max(
      Math.min(pixelsPerMs() * factor, canvasWidth() / MIN_VISIBLE_MS),
      canvasWidth() / Math.max(hi0 - lo0, MIN_VISIBLE_MS), // min zoom = full session
    );
    const span = canvasWidth() / nextPpm;
    setWindow(focusMs - (focusPx / canvasWidth()) * span, focusMs - (focusPx / canvasWidth()) * span + span);
  }

  function panBy(dxPx: number): void {
    const dms = dxPx / pixelsPerMs();
    setWindow(viewStart + dms, viewEnd + dms);
  }

  function fitWindow(): void {
    setWindow(lo0, hi0);
  }

  /* ------------------------------------------------------------ minimap pool */

  const minimaps = new Map<number, MiniMapData>();
  const minimapFailed = new Set<number>();
  let minimapInFlight = 0;

  function ensureMinimap(anchorIndex: number): void {
    if (minimapInFlight >= MINIMAP_CONCURRENCY) return;
    if (minimaps.has(anchorIndex) || minimapFailed.has(anchorIndex)) return;
    minimapInFlight++;
    snapshotFor(anchorIndex)
      .then((response) => minimaps.set(anchorIndex, computeMiniMap(asUISnapshot(response.parsed))))
      .catch(() => minimapFailed.add(anchorIndex))
      .finally(() => {
        minimapInFlight--;
        dirty = true;
        // Kick the next pending block so the strip fills gradually.
        for (const anchor of timeline.snapshots) {
          if (!minimaps.has(anchor.index) && !minimapFailed.has(anchor.index)) {
            ensureMinimap(anchor.index);
            break;
          }
        }
      });
  }

  /* ---------------------------------------------------------- replica sync */

  /** One fetch per anchor index, shared by replica + filmstrip (coalesced). */
  const snapshotFetches = new Map<number, Promise<SnapshotResponse>>();
  function snapshotFor(index: number): Promise<SnapshotResponse> {
    let pending = snapshotFetches.get(index);
    if (pending === undefined) {
      pending = api.snapshot(sessionId, String(index));
      snapshotFetches.set(index, pending);
      // Failures are not memoized: a later scrub may retry (store swap etc.).
      pending.catch(() => snapshotFetches.delete(index));
    }
    return pending;
  }

  const replicaCache = new Map<number, Promise<ReplicaEntry>>();
  /**
   * Monotonic render token: every syncReplica bumped; in-flight fetches that
   * resolve after a newer sync ignore themselves (the playhead moved on).
   */
  let renderToken = 0;
  /** What is on screen right now: `${anchor indexes}|${themeMode}` — re-syncs
   *  with the same key skip the rebuild and only refresh the highlight. */
  let renderedKey: string | null = null;
  /** The rendered composite wrapper (zoom/pan target) + its design size. */
  let liveComposite: HTMLDivElement | null = null;
  let liveBaseSize: { width: number; height: number } | null = null;
  /** Currently rendered layers, bottom → top (highlight/outline scope). */
  let renderedLayers: RenderedLayer[] = [];
  /** Replica zoom: user multiplier over the fit-in-panel scale, applied via
   *  CSS zoom (layout-scaled, so the holder's scrollbars act as pan). */
  let replicaFitScale = 1;
  let replicaZoom = 1;
  const REPLICA_MAX_ZOOM = 8;

  /**
   * Fit-in-panel scale for the composite, computed from the base snapshot's
   * design size (not the zoomed DOM box — CSS zoom cascades to children, so
   * offsetWidth measurements would feed back).
   */
  function computeFitScale(): number {
    const size = liveBaseSize;
    if (size === null) return 1;
    const availWidth = Math.max(replicaViewport.clientWidth - 24, 60);
    const availHeight = Math.max(replicaViewport.clientHeight - 24, 60);
    return Math.min(availWidth / size.width, availHeight / size.height, 1.5);
  }

  /** Set by filmstrip-block clicks: a click explicitly focuses a span even when it holds no captures. */
  let focusedSpanWasJustClicked = false;

  function replicaFor(index: number): Promise<ReplicaEntry> {
    let entry = replicaCache.get(index);
    if (entry === undefined) {
      entry = snapshotFor(index)
        .then((response) => ({ index, parsed: response.parsed, error: null }))
        .catch((error) => ({
          index,
          parsed: null as ParsedSnapshotDto | null,
          error:
            error instanceof ApiClientError
              ? error.body
              : { code: "SNAPSHOT_FAILED", message: String(error) },
        }));
      replicaCache.set(index, entry);
    }
    return entry;
  }

  function anchorName(anchor: { view: string | null; ms: number; nodes: number | null; width: number | null; height: number | null }): string {
    const bits: Array<string> = [];
    if (anchor.view) bits.push(anchor.view);
    if (anchor.nodes !== null) bits.push(`${anchor.nodes} nodes`);
    if (anchor.width !== null && anchor.height !== null) bits.push(`${Math.round(anchor.width)}×${Math.round(anchor.height)}`);
    return bits.join(" · ");
  }

  function syncReplica(): void {
    const token = ++renderToken;
    // State window (2026-10-24): the playhead rests on an event, but that
    // event's consequence capture can land later (debounced/settled mutation
    // captures). Resolve the composite's anchors up to the *next* event —
    // unbounded on the session tail, so the live auto-step playhead shows the
    // newest capture instead of lagging one mutation behind.
    let stateMs: number | null = null;
    const selection = selectedEventIndex !== -1 ? timeline.events[selectedEventIndex] : undefined;
    if (selection !== undefined) {
      const isTail = selectedEventIndex === timeline.events.length - 1;
      const following = timeline.events.find((event) => event.index > selection.index && event.ms > selection.ms + 1e-6);
      stateMs = isTail || following === undefined ? Number.POSITIVE_INFINITY : following!.ms;
    }
    const composite = resolveComposite(timeline.viewSpans, timeline.snapshots, playheadMs, stateMs);
    if (composite.layers.length === 0) {
      renderedKey = null;
      liveComposite = null;
      liveBaseSize = null;
      renderedLayers = [];
      replicaHolder.replaceChildren();
      replicaWarnings.replaceChildren();
      replicaMeta.textContent = "—";
      replicaFooter.textContent = "";
      replicaEmpty.textContent = composite.reason ?? "No snapshot at this moment.";
      replicaEmpty.classList.remove("hidden");
      applyReplicaHighlight();
      return;
    }
    const targets = composite.layers.map((layer) => ({
      span: layer.span,
      anchor: timeline.snapshots[layer.anchor.index]!,
      promise: replicaFor(layer.anchor.index),
    }));
    void Promise.all(targets.map((target) => target.promise)).then((entries) => {
      if (token !== renderToken) return; // playhead moved on
      const key = `${targets.map((target) => target.anchor.index).join(",")}|${themeMode}`;
      if (renderedKey === key) {
        // Composite already current: re-apply just the selection overlay (the
        // playhead may have moved to another event on the same captures).
        applyReplicaHighlight();
        return;
      }
      // Spans on screen that contribute no layer (their chain holds no capture
      // in this span — e.g. dedupe-era sessions) surface as warn chips.
      const renderedSpanIndexes = new Set(composite.layers.map((layer) => layer.span?.index));
      const skipped = timeline.viewSpans.filter(
        (span) =>
          !renderedSpanIndexes.has(span.index) &&
          span.openMs - 1e-9 <= playheadMs &&
          playheadMs <= (span.closeMs ?? Number.POSITIVE_INFINITY) + 1e-9,
      );
      renderComposite(targets.map((target, i) => ({ span: target.span, anchor: target.anchor, entry: entries[i]! })), skipped);
      renderedKey = key;
    });
  }

  /** One rendered composite layer (bottom → top). */
  interface RenderedLayer {
    span: TimelineViewSpanDto | null;
    anchor: TimelineSnapshotDto;
    /** The stage element — null for skipped layers. */
    stage: HTMLDivElement | null;
    /** Snapshot/span view id the stage was rendered from. */
    viewId: string | null;
  }

  function describeFetchError(entry: ReplicaEntry): string {
    return entry.error?.code === "SNAPSHOT_STORE_UNCONFIGURED"
      ? "Snapshot root not configured (SNAPSHOT_ROOT) — event lanes only."
      : entry.error?.code === "SNAPSHOT_ARTIFACT_MISSING"
        ? "Snapshot bytes missing in the store (ledger recorded the artifact)."
        : entry.error?.code === "SNAPSHOT_STORE_UNREACHABLE"
          ? "Snapshot store unreachable — check the root path."
          : `Snapshot unavailable (${entry.error?.code ?? "SNAPSHOT_FAILED"}).`;
  }

  /**
   * Build the layered composite (2026-10-21): all spans covering the playhead
   * render their own capture, stacked by canvas layer over the base stage —
   * dialogs/snackbars overlay the main view like the live app.
   */
  function renderComposite(
    resolved: Array<{ span: TimelineViewSpanDto | null; anchor: TimelineSnapshotDto; entry: ReplicaEntry }>,
    skipped: TimelineViewSpanDto[],
  ): void {
    replicaHolder.replaceChildren();
    renderedLayers = [];
    replicaWarnings.replaceChildren();

    // Overlay design space — canvas size from the app info (popup root anchors
    // are relative to the popup layer, canvas-sized). Legacy captures without
    // app info fall back to the base stage size. Coordinates map 1:1 into the
    // base stage: full-screen main captures share the popup layer's canvas
    // units precisely (same scaleFactor, same root-relative rect space).
    let viewport: { width: number; height: number } | null = null;
    let baseSize: { width: number; height: number } | null = null;
    const failures: Array<{ view: string; entry: ReplicaEntry }> = [];

    const compositeEl = document.createElement("div");
    compositeEl.className = "replica-composite";
    replicaHolder.appendChild(compositeEl);

    for (const item of resolved) {
      if (item.entry.parsed === null) {
        failures.push({ view: item.span?.view ?? item.anchor.view ?? "view", entry: item.entry });
        continue;
      }
      const uiSnapshot = asUISnapshot(item.entry.parsed);
      const overlay = renderedLayers.length > 0; // the first rendered layer is the base
      const stageHolder = document.createElement("div");
      compositeEl.appendChild(stageHolder);
      const replica = buildReplicaStage(uiSnapshot, stageHolder, themeMode, overlay ? { transparentStage: true } : {});
      const viewId = item.span?.viewId ?? uiSnapshot.view?.id ?? null;
      const viewName = item.span?.view ?? uiSnapshot.view?.["name"] ?? "unnamed view";
      const layerLabel = item.span?.layer ?? uiSnapshot.view?.["layer"] ?? "DEFAULT";

      // Materialize the *applied* theme as --m3-* vars for CSS that reads
      // tokens (switch track/thumb, chip borders) — parity with the standalone.
      injectTheme(themeMode === "raw" ? uiSnapshot.theme : defaultLightTheme(), replica.stage);

      if (viewport === null) viewport = canvasViewportOf(uiSnapshot);
      if (baseSize === null) baseSize = { width: replica.width, height: replica.height };

      if (overlay) {
        const vp = viewport ?? { width: replica.width, height: replica.height };
        const placement = overlayPlacementFor(uiSnapshot, vp);
        replica.stage.classList.add("overlay-stage");
        replica.stage.style.left = `${placement.left}px`;
        replica.stage.style.top = `${placement.top}px`;
        const chip = document.createElement("span");
        chip.className = "replica-layer-chip";
        const label = `${viewName} · ${layerLabel}${placement.mode === "center" ? " · centered" : ""}`;
        chip.textContent = label;
        chip.title = `Overlay capture — canvas layer ${layerLabel}\n${placement.mode === "center" ? "anchor data missing → centered on the base" : "placed from the captured root anchor"}`;
        replica.stage.appendChild(chip);
      }
      replica.stage.dataset.spanId = item.span !== null ? String(item.span.index) : "";
      replica.stage.dataset.viewId = viewId ?? "";
      renderedLayers.push({ span: item.span, anchor: item.anchor, stage: replica.stage, viewId });
    }

    // Warning/skip chips (before the empty-return so failures are visible).
    const warningChips: Array<HTMLDivElement> = [];
    for (const item of resolved) {
      const view = item.span?.view ?? item.anchor.view ?? "";
      if (item.entry.parsed === null) {
        const chip = document.createElement("div");
        chip.className = "warn-chip";
        chip.textContent = `⚠ ${view ? `${view}: ` : ""}${describeFetchError(item.entry)}`;
        warningChips.push(chip);
      } else {
        const prefix = resolved.length > 1 && view ? `${view}: ` : "";
        for (const text of item.entry.parsed.warnings ?? []) {
          const chip = document.createElement("div");
          chip.className = "warn-chip";
          chip.textContent = `⚠ ${prefix}${text}`;
          warningChips.push(chip);
        }
      }
    }
    for (const span of skipped) {
      const chip = document.createElement("div");
      chip.className = "warn-chip";
      chip.textContent = `▣ ${span.view} — span on screen, but its capture chain holds no snapshots`;
      warningChips.push(chip);
    }
    replicaWarnings.replaceChildren(...warningChips);

    if (renderedLayers.length === 0) {
      // Every layer failed to fetch.
      liveComposite = null;
      liveBaseSize = null;
      renderedLayers = [];
      replicaMeta.textContent = "—";
      replicaFooter.textContent = failures.length > 0 ? failures[0]!.entry.error?.message ?? "" : "";
      replicaEmpty.textContent = failures.map((failure) => describeFetchError(failure.entry)).join(" · ");
      replicaEmpty.classList.remove("hidden");
      applyReplicaHighlight();
      return;
    }

    const base = renderedLayers[0]!;
    compositeEl.style.width = `${baseSize!.width}px`;
    compositeEl.style.height = `${baseSize!.height}px`;
    liveComposite = compositeEl;
    liveBaseSize = baseSize!;

    replicaMeta.replaceChildren();
    replicaMeta.textContent = anchorName(base.anchor);
    for (const layer of renderedLayers.slice(1)) {
      const chip = document.createElement("span");
      chip.className = "chip info small";
      chip.textContent = `⬒ ${layer.span?.view ?? layer.anchor.view}`;
      chip.title = `overlay layer · ${anchorName(layer.anchor)}`;
      replicaMeta.appendChild(chip);
    }

    const layers = renderedLayers;
    const single = layers.length === 1;
    const viewNames = layers
      .map((layer) => (layer.span?.view ?? layer.anchor.view) ?? "unnamed view")
      .join(single ? "" : " + ");
    const layer = resolved.find((item) => item.entry.parsed !== null)?.entry.parsed ?? null;
    if (layer !== null) {
      replicaFooter.textContent = `${fmtStamp(base.anchor.ms)} · ${viewNames ?? "unnamed view"} · ${layer.nodes.length} nodes · schema v${layer.schemaVersion}`;
    } else {
      replicaFooter.textContent = `${fmtStamp(base.anchor.ms)} · ${viewNames ?? "unnamed view"} · schema v?`;
    }
    replicaEmpty.classList.add("hidden");
    applyReplicaHighlight();
    // Fit after layout settles (zoom applies to the composite wrapper).
    requestAnimationFrame(() => {
      replicaFitScale = computeFitScale();
      applyReplicaZoom();
    });
  }

  /* -------------------------------------------------------- replica zoom */

  /** Zoom stays a multiplier over the fit scale (≤ 8× fit = at least the
   *  native capture size); 1 is exactly "fit in panel". */
  function setReplicaZoom(level: number): void {
    const clamped = Math.min(Math.max(level, 1), REPLICA_MAX_ZOOM);
    if (Math.abs(clamped - replicaZoom) < 1e-4) return;
    replicaZoom = clamped;
    applyReplicaZoom();
  }

  function applyReplicaZoom(): void {
    const composite = liveComposite;
    const noStage = composite === null || liveBaseSize === null;
    zoomOutBtn.disabled = noStage || replicaZoom <= 1 + 1e-4;
    zoomInBtn.disabled = noStage || replicaZoom >= REPLICA_MAX_ZOOM - 1e-4;
    zoomFitBtn.disabled = noStage || replicaZoom <= 1 + 1e-4;
    zoom11Btn.disabled = noStage || replicaFitScale === 0;
    if (composite !== null) {
      composite.style.zoom = String(replicaFitScale * replicaZoom);
      if (replicaZoom <= 1 + 1e-4) replicaHolder.scrollTo({ left: 0, top: 0, behavior: "auto" });
    }
    zoomLevel.textContent = noStage ? "—" : `${Math.round(replicaFitScale * replicaZoom * 100)}%`;
  }

  /* --------------------------------------------------- selection highlight */

  /**
   * Outline the selected event's UI element inside the composite (2026-10-20,
   * composite rework 2026-10-21): the event's view is one layer of the
   * composite — if that view is on screen at the playhead, the element is
   * highlighted in *its* stage and the focused-layer outline marks the stage.
   * The stage exposes every node as `[data-node-id]`; the highlight is a
   * dedicated overlay element appended to the node — removed again on the
   * next application. Not-found (element created after the capture, or the
   * view not on screen at all) is reported in the meta chip, honestly.
   */
  function applyReplicaHighlight(): void {
    replicaHolder.querySelectorAll(".event-node-highlight").forEach((node) => node.remove());
    for (const stage of replicaHolder.querySelectorAll<HTMLElement>(".layer-focused")) {
      stage.classList.remove("layer-focused");
    }
    const selection = selectedEventIndex !== -1 ? timeline.events[selectedEventIndex] : undefined;
    const chip = replicaMeta.querySelector<HTMLElement>("#tl-sel-chip");
    if (selection === undefined) {
      chip?.remove();
      return;
    }

    const label =
      selection.elementType !== null ? `${selection.type} · ${selection.elementType}` : selection.type;
    const layer =
      selection.viewId !== null
        ? renderedLayers.find((candidate) => candidate.stage !== null && candidate.viewId === selection.viewId) ?? null
        : null;
    const target =
      layer !== null && selection.element !== null
        ? layer.stage!.querySelector<HTMLElement>(`[data-node-id="${cssEscape(selection.element)}"]`)
        : null;
    if (target !== null) {
      const overlay = document.createElement("div");
      overlay.className = "event-node-highlight";
      target.appendChild(overlay);
    }
    if (layer !== null) {
      // Tool chrome: the focused composite layer reads at a glance.
      layer.stage!.classList.add("layer-focused");
    }

    const node = chip ?? document.createElement("span");
    node.id = "tl-sel-chip";
    node.className = `chip ${target !== null ? "info" : "warn"} small`;
    node.textContent =
      target !== null ? `◆ ${label}` : layer !== null ? `◆ ${label} · not in this capture` : `◆ ${label} · view not on screen`;
    node.title = [
      `event ${selection.type} @ ${fmtStamp(playheadMs)}`,
      selection.element !== null ? `element ${selection.element}` : "element —",
      target !== null
        ? "highlighted in the replica"
        : layer !== null
          ? "no matching node in this capture"
          : "this view is not on screen at the playhead",
    ].join("\n");
    if (chip === null) replicaMeta.appendChild(node);
  }

  /* --------------------------------------------------------------- drawing */

  // `dirty` is declared with the derived model state above (rebuildModel sets it).
  let raf = 0;
  let dpr = Math.max(window.devicePixelRatio || 1, 1);

  function resizeCanvas(): boolean {
    const width = Math.max(wrap.clientWidth | 0, 64);
    const targetW = Math.floor(width * dpr);
    const targetH = Math.floor(canvasH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH || canvas.clientWidth !== width) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${canvasH}px`;
      canvas.width = targetW;
      canvas.height = targetH;
      return true;
    }
    return false;
  }

  function rowStyle(ctx: CanvasRenderingContext2D, cssW: number): void {
    const firstRow = Math.max(0, Math.floor(scrollY / ROW_H));
    const lastRow = Math.min(totalRows - 1, Math.ceil((scrollY + visibleRowsH) / ROW_H));
    for (let row = firstRow; row <= lastRow; row++) {
      ctx.fillStyle = row % 2 === 0 ? "#111318" : "#0e1116";
      ctx.fillRect(0, rowY(row), cssW, ROW_H);
    }
  }

  function drawRowClips(ctx: CanvasRenderingContext2D, cssW: number): void {
    // Rows scroll under the pinned ruler: clip the row region, then draw.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, cssW, canvasH - RULER_H);
    ctx.clip();
    rowStyle(ctx, cssW);
    for (const [row, spans] of rowSpans) {
      const y = rowY(row);
      if (y + ROW_H < RULER_H || y > canvasH) continue;
      for (const entry of spans) drawSpanClip(ctx, entry, row, cssW);
    }
    if (orphanCount > 0) drawNoViewRow(ctx, cssW);
    ctx.restore();
  }

  /** One view life-cycle as a clip on its track: filmstrip blocks of the span's own snapshots, span events as marbles inside. */
  function drawSpanClip(ctx: CanvasRenderingContext2D, entry: RowSpan, row: number, cssW: number): void {
    const span = entry.span;
    const x0 = pxAt(span.openMs);
    const x1 = span.closeMs !== null ? pxAt(span.closeMs) : cssW;
    if (x1 < -4 || x0 > cssW + 4) return;
    const left = Math.max(x0, -4);
    const right = Math.min(x1, cssW + 4);
    const y = rowY(row);
    const blockY = y + 4;
    const blockH = ROW_H - 8;
    const [fill, edge] = spanPalette(span.kind, span.stillOpen);

    // Clip background.
    ctx.fillStyle = fill;
    roundRectPath(ctx, left, blockY, Math.max(right - left, 2), blockH, 4);
    ctx.fill();
    // Open + closure markers.
    ctx.fillStyle = edge;
    if (x0 >= -2 && x0 <= cssW) ctx.fillRect(x0, blockY, 2, blockH);
    if (span.closeMs !== null && x1 - 2 >= -2 && x1 - 2 <= cssW) ctx.fillRect(x1 - 2, blockY, 2, blockH);

    // Filmstrip: this span's own snapshot captures, each block held until the
    // next capture (or the span's end) — scoped to the view that was on screen.
    for (let i = 0; i < entry.anchors.length; i++) {
      const anchor = entry.anchors[i]!;
      const nextAnchor = entry.anchors[i + 1];
      const ax0 = pxAt(anchor.ms);
      const axEnd = nextAnchor !== undefined ? pxAt(nextAnchor.ms) : x1;
      const w = Math.max(16, Math.min(axEnd - ax0 - 1, 240));
      if (axEnd < -4 || ax0 > cssW + 4) continue;
      const minimap = minimaps.get(anchor.index);
      if (minimap === undefined) {
        ensureMinimap(anchor.index);
        ctx.strokeStyle = "#4b4453";
        ctx.strokeRect(ax0 + 0.5, blockY + 0.5, w - 1, blockH - 1);
      } else {
        drawMiniMap(
          ctx,
          minimap,
          ax0 + 1,
          blockY,
          Math.max(1, w - 2),
          blockH,
          minimap.blocks.length > 0 ? FILM_BG : FILM_EMPTY_BG,
        );
        if (minimap.warnings.length > 0 && w > 40) {
          ctx.fillStyle = "#f2b8b5";
          ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
          ctx.fillText("⚠", ax0 + 5, blockY + 12);
        }
      }
      // Capture boundary marker.
      if (ax0 >= 0 && ax0 <= cssW) {
        ctx.fillStyle = "rgba(138,180,248,0.75)";
        ctx.fillRect(ax0, blockY, 2, blockH);
      }
    }

    // Span label chip (readable over filmstrip blocks and row gaps alike).
    const dwell = span.dwellSeconds ?? (x1 - x0) / 1000;
    const kindMark = span.kind === "popup" ? " ⬒" : span.kind === "inferred" ? " ⌛" : "";
    const spanLabel = span.stillOpen
      ? `▶ ${span.view}${kindMark} · still open`
      : `${span.view}${kindMark} · ${dwell >= 100 ? dwell.toFixed(0) : dwell.toFixed(2)}s`;
    if (right - left > 70) {
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      const text = clipText(ctx, spanLabel, right - left - 14);
      const chipW = Math.min(right - left - 10, ctx.measureText(text).width + 10);
      ctx.fillStyle = "rgba(8,10,14,0.6)";
      roundRectPath(ctx, left + 5, blockY + 2, chipW, 13, 4);
      ctx.fill();
      ctx.fillStyle = "#dde2ea";
      ctx.fillText(text, left + 10, blockY + 4);
    }

    drawEventMarbles(ctx, entry.events, rowCenter(row), cssW);
  }

  /** The "no view attribution" pseudo row — events the timeline cannot place on any view track (never dropped). */
  function drawNoViewRow(ctx: CanvasRenderingContext2D, cssW: number): void {
    const y = rowY(NO_VIEW_ROW);
    if (y + ROW_H < RULER_H || y > canvasH) return;
    ctx.fillStyle = "#262b33";
    ctx.fillRect(0, y, cssW, ROW_H);
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#5b6470";
    ctx.fillText("no view attribution", 8, y + 5);
    drawEventMarbles(ctx, orphanEvents, rowCenter(NO_VIEW_ROW), cssW);
  }

  /** Events of one row as marbles centered in the band; crowded clusters collapse into a per-pixel density bar. */
  function drawEventMarbles(
    ctx: CanvasRenderingContext2D,
    events: TimelineEventDto[],
    y: number,
    cssW: number,
  ): void {
    // Bucket per pixel column: sparse ⇒ marbles, dense ⇒ density bar.
    const columns = cssW + 1;
    const counts = new Int32Array(columns);
    const colors: Array<string | null> = new Array<string | null>(columns).fill(null);
    const unresolvedColumns = new Int32Array(columns);
    let crowded = 0;
    for (const event of events) {
      if (event.ms > viewEnd + 1e-6) break;
      const column = Math.floor(pxAt(event.ms) + 0.5);
      if (column < 0 || column >= columns) continue;
      counts[column]! += 1;
      const color =
        event.type === "toggle"
          ? event.on
            ? MARBLE_COLORS.toggle_on
            : MARBLE_COLORS.toggle_off
          : marbleColor(event.type);
      colors[column] = color;
      if (event.unresolved) unresolvedColumns[column] = 1;
      if (counts[column]! > 1) crowded++;
    }

    if (crowded === 0) {
      // Sparse: marbles; unresolved events get a hollow ring.
      for (let column = 0; column < columns; column++) {
        if (counts[column] === 0) continue;
        ctx.beginPath();
        ctx.arc(column + 0.5, y, 5, 0, Math.PI * 2);
        if (unresolvedColumns[column] === 1) {
          ctx.fillStyle = "rgba(242,184,181,0.35)";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = MARBLE_COLORS.unresolved;
          ctx.stroke();
        } else {
          ctx.fillStyle = colors[column]!;
          ctx.fill();
          if (colors[column] === MARBLE_COLORS.toggle_on || colors[column] === MARBLE_COLORS.toggle_off) {
            ctx.fillStyle = colors[column] === MARBLE_COLORS.toggle_on ? "#1d192b" : "#e6e0e9";
            ctx.fillRect(column - 1, y - 2, 3, 3);
          }
        }
      }
      return;
    }

    // Crowded: per-column density bars keep 5k sessions at 60 fps.
    for (let column = 0; column < columns; column++) {
      if (counts[column] === 0) continue;
      const density = Math.min(1, 0.3 + counts[column]! / 12);
      ctx.fillStyle = colors[column] ?? MARBLE_COLORS.unresolved;
      ctx.globalAlpha = density;
      ctx.fillRect(column, y - ROW_H * 0.3, 1, ROW_H * 0.6);
      ctx.globalAlpha = 1;
    }
  }

  function drawRuler(ctx: CanvasRenderingContext2D, cssW: number): void {
    ctx.fillStyle = "#171b22";
    ctx.fillRect(0, 0, cssW, RULER_H);
    ctx.fillStyle = "#2a2f38";
    ctx.fillRect(0, RULER_H - 1, cssW, 1);

    // Major ticks every step ≥ 64 px, using nice 1/2/5 decades.
    const targetPx = 64;
    const rawStep = targetPx / pixelsPerMs();
    const step = niceStep(rawStep);
    const minorStep = step / 5;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "top";

    const startTick = Math.ceil(viewStart / minorStep) * minorStep;
    for (let t = startTick; t <= viewEnd + minorStep; t += minorStep) {
      const x = Math.round(pxAt(t)) + 0.5;
      const isMinorBoundary = Math.abs(t / minorStep - Math.round(t / minorStep)) < 1e-9;
      if (!isMinorBoundary) continue;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-9;
      ctx.strokeStyle = major ? "#454d59" : "#262b33";
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 1);
      ctx.lineTo(x, RULER_H - (major ? 10 : 5));
      ctx.stroke();
      if (major) {
        ctx.fillStyle = "#aeb4bd";
        ctx.fillText(fmtRel(t), x + 4, 6);
      }
    }
    // hint label of the absolute time of window start (helps correlate)
    ctx.fillStyle = "#5b6470";
    ctx.textAlign = "right";
    ctx.fillText(fmtAbs(viewStart), cssW - 6, 6);
    ctx.textAlign = "left";
  }

  function niceStep(raw: number): number {
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const residual = raw / magnitude;
    if (residual <= 1) return magnitude;
    if (residual <= 2) return 2 * magnitude;
    if (residual <= 5) return 5 * magnitude;
    return 10 * magnitude;
  }

  /** mm:ss.mmm relative to the session start (00:00.000 = session start). */
  function fmtRel(t: number): string {
    const sec = Math.max(0, t - T0) / 1000;
    const mm = Math.floor(sec / 60);
    const s = sec - mm * 60;
    return `${String(mm).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  }

  function fmtAbs(t: number): string {
    return new Date(t).toISOString().slice(11, 23).replace("Z", "");
  }

  function fmtStamp(ms: number): string {
    return `${fmtRel(ms)} · ${fmtAbs(ms)}`;
  }

  /** Row of the nearest span of a view (legacy events without a valid spanId still render on their view's track). */
  function rowOfNearestSpan(spanId: number | null, viewId: string): number | null {
    if (spanId !== null) return rowOfSpanId.get(spanId) ?? null;
    let best: TimelineViewSpanDto | null = null;
    for (const span of timeline.viewSpans) {
      if (span.viewId !== viewId) continue;
      if (best === null || span.row < best.row || (span.row === best.row && span.index < best.index)) {
        best = span;
      }
    }
    return best !== null ? Math.max(best.row, 0) : null;
  }

  /** Selection ring: bold circle around the selected event's marble. */
  function drawPlayhead(ctx: CanvasRenderingContext2D): void {
    const x = Math.round(pxAt(playheadMs)) + 0.5;
    ctx.strokeStyle = "#fdd663";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvasH);
    ctx.stroke();
    ctx.fillStyle = "#fdd663";
    ctx.beginPath();
    ctx.moveTo(x, RULER_H - 1);
    ctx.lineTo(x - HANDLE_HALF, RULER_H - 11);
    ctx.lineTo(x + HANDLE_HALF, RULER_H - 11);
    ctx.closePath();
    ctx.fill();
  }

  function draw(): void {
    const cssW = canvasWidth();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, canvasH);
    drawRowClips(ctx, cssW);
    // Ruler + overlays pin above the (scrollable) rows.
    drawRuler(ctx, cssW);
    drawPlayhead(ctx);
  }

  function frame(): void {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (!dirty) return;
    resizeCanvas();
    draw();
    dirty = false;
  }

  /* ---------------------------------------------------------- interactions */

  let destroyed = false;
  let dragMode: "none" | "scrub" | "pan" = "none";
  let pointerStartX = 0;
  let windowStartMs = 0;
  let dragged = false;
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchStartDist = 0;
  /** Session-ms under the two-pointer midpoint at pinch start (zoom anchor). */
  let pinchFocusMs = 0;

  function localPx(clientX: number): number {
    return clientX - canvas.getBoundingClientRect().left;
  }

  canvas.addEventListener("pointerdown", (event) => {
    stopPlayback(); // manual interaction on the strip takes over from the player
    if (activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
    dragged = false;

    if (activePointers.size === 2) {
      // Pinch zoom cancels any drag intent; anchor = session-ms under the
      // two-pointer midpoint (kept fixed while the distance maps to span).
      const pts = [...activePointers.values()];
      pinchStartDist = Math.max(Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y), 1);
      pinchFocusMs = msAt(localPx((pts[0]!.x + pts[1]!.x) / 2));
      dragMode = "none";
      return;
    }

    const y = event.clientY - canvas.getBoundingClientRect().top;
    pointerStartX = localPx(event.clientX);
    windowStartMs = viewStart;
    dragMode = y < RULER_H ? "scrub" : "pan";
    if (dragMode === "scrub") setPlayheadMs(msAt(pointerStartX));
  });

  canvas.addEventListener("pointermove", (event) => {
    const pointer = activePointers.get(event.pointerId);
    if (pointer !== undefined) {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    }

    if (activePointers.size === 2 && pinchStartDist > 0) {
      // Zoom around the 2-finger midpoint: the focus ms stays under it while
      // the starting distance maps to the visible span.
      const pts = [...activePointers.values()];
      const dist = Math.max(Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y), 1);
      const midLocal = localPx((pts[0]!.x + pts[1]!.x) / 2);
      const span = Math.max(
        Math.min((viewEnd - viewStart) * (pinchStartDist / dist), hi0 - lo0),
        MIN_VISIBLE_MS,
      );
      setWindow(pinchFocusMs - (midLocal / canvasWidth()) * span, pinchFocusMs - (midLocal / canvasWidth()) * span + span);
      return;
    }

    if (dragMode === "none") return;
    const x = localPx(event.clientX);
    const dx = x - pointerStartX;
    if (Math.abs(dx) > 3) dragged = true;
    if (dragMode === "scrub") {
      setPlayheadMs(msAt(x));
    } else if (dragMode === "pan") {
      // Translate the pointerdown window by the pixel delta; panning never
      // changes the span, so the in-flight ppm is the same on both ends.
      const span = viewEnd - viewStart;
      const dms = dx / pixelsPerMs();
      setWindow(windowStartMs - dms, windowStartMs + span - dms);
    }
  });

  function endPointer(event: PointerEvent): void {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) {
      pinchStartDist = 0;
      // A plain click (no drag) places the playhead in both scrub & pan zones.
      if (!dragged && dragMode === "pan") {
        setPlayheadMs(msAt(localPx(event.clientX)));
      }
      dragMode = "none";
    }
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("dblclick", () => fitWindow());

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.shiftKey) {
        panBy((event.deltaY + event.deltaX) * 0.5);
        return;
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        panBy(event.deltaX);
        return;
      }
      // Trackpad pinch (ctrlKey) always zooms; a plain vertical wheel scrolls
      // rows whenever the session has more tracks than the viewport holds
      // (hitting the scroll edge hands back to zoom).
      if (event.ctrlKey) {
        zoomAround(Math.exp(-event.deltaY * 0.01), localPx(event.clientX));
        return;
      }
      if (maxScrollY > 0) {
        const next = clampScrollY(scrollY + event.deltaY);
        if (next !== scrollY) {
          scrollY = next;
          dirty = true;
          return;
        }
      }
      zoomAround(Math.exp(-event.deltaY * 0.0016), localPx(event.clientX));
    },
    { passive: false },
  );

  /** The RowSpan entry of a span (filmstrip blocks etc.). */
  function rowEntryOf(span: TimelineViewSpanDto): RowSpan | undefined {
    return rowSpans.get(Math.max(span.row, 0))?.find((entry) => entry.span === span);
  }

  /** Row (track) an event belongs to, for hit-testing and reveal. */
  function rowOfEvent(event: TimelineEventDto): number {
    const spanId = event.spanId ?? nearestSpanIdFor(event.viewId, event.ms);
    if (spanId !== null) {
      const row = rowOfSpanId.get(spanId);
      if (row !== undefined) return row;
    }
    if (event.viewId !== null) return rowOfNearestSpan(event.spanId, event.viewId) ?? NO_VIEW_ROW;
    return NO_VIEW_ROW;
  }

  /** Explicit focus request (filmstrip click); survives the sneaky focus from setPlayheadMs. */
  function focusSpan(index: number): void {
    focusedSpanId = index;
    focusedSpanWasJustClicked = true;
    dirty = true;
  }

  canvas.addEventListener("click", (event) => {
    const y = event.clientY - canvas.getBoundingClientRect().top;
    if (y < RULER_H) return; // ruler scrub handles its own
    const row = rowAt(y);
    if (row < 0 || row >= totalRows) return;
    const x = localPx(event.clientX);
    const t = msAt(x);

    // A clip on this row? Clicking inside it focuses the view + snaps to its
    // nearest capture ("scene change") — popup rows render the popup replica.
    if (row < rowCount) {
      const entries = rowSpans.get(row) ?? [];
      const hit = entries.find((entry) => {
        const x0 = pxAt(entry.span.openMs);
        const x1 = entry.span.closeMs !== null ? pxAt(entry.span.closeMs) : canvasWidth();
        return x >= x0 && x <= x1;
      });
      if (hit !== undefined) {
        focusSpan(hit.span.index);
        let bestDiff = Number.POSITIVE_INFINITY;
        for (const anchor of hit.anchors) {
          const diff = Math.abs(anchor.ms - t);
          if (diff < bestDiff) bestDiff = diff;
        }
        if (hit.anchors.length > 0 && bestDiff < (viewEnd - viewStart) / 4) {
          let best = hit.anchors[0]!;
          for (const anchor of hit.anchors) {
            if (Math.abs(anchor.ms - t) < Math.abs(best.ms - t)) best = anchor;
          }
          setPlayheadMs(best.ms);
          return;
        }
        setPlayheadMs(t);
        return;
      }
    }
    // Row background or no-view row: plain playhead placement (focus then
    // follows the nearest event's view via setPlayheadMs).
    setPlayheadMs(t);
  });

  /** Index of the event temporally nearest to t (either side), or -1 when
   *  the session has no events. Binary search for the insertion point, then
   *  compare the flanking events. Ties resolve to the earlier event. */
  function closestEventIndex(t: number): number {
    const events = timeline.events;
    if (events.length === 0) return -1;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.ms < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    if (lo === events.length) return events.length - 1;
    const prev = events[lo - 1]!;
    const next = events[lo]!;
    return t - prev.ms <= next.ms - t ? lo - 1 : lo;
  }

  function setPlayheadMs(t: number): void {
    // Track-head invariant (2026-10-20 regression): the playhead snaps to the
    // *closest event* and can never rest between events — scrubbing, plain
    // clicks, filmstrip clicks and Home/End all funnel through here. Ties at
    // the same ms select one index deterministically.
    const clamped = Math.min(Math.max(t, lo0), hi0);
    const index = closestEventIndex(clamped);
    const snapped = index !== -1 ? timeline.events[index]!.ms : clamped;
    if (index === selectedEventIndex && (index !== -1 || Math.abs(snapped - playheadMs) < 1e-9)) {
      return;
    }
    selectedEventIndex = index;
    playheadMs = snapped;
    updateTransport();
    // Follow selection: the replica switches to the view of the selected
    // event — unless a filmstrip-block click just focused its span explicitly.
    if (index !== -1 && !focusedSpanWasJustClicked) {
      const selection = timeline.events[index]!;
      const spanId = selection.spanId ?? nearestSpanIdFor(selection.viewId, selection.ms);
      if (spanId !== null && focusedSpanId !== spanId) {
        focusedSpanId = spanId;
        dirty = true;
      }
    } else if (focusedSpanWasJustClicked) {
      focusedSpanWasJustClicked = false; // consumed: later moves follow selection again
    }
    dirty = true;
    syncReplica();
  }

  /* -------------------------------------------------------------- keyboard */

  function nearestEventIndex(direction: 1 | -1): number {
    const events = timeline.events;
    let lo = 0;
    let hi = events.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ms = events[mid]!.ms;
      if (direction === 1 ? ms > playheadMs + 1e-9 : ms < playheadMs - 1e-9) {
        best = mid;
        if (direction === 1) hi = mid - 1;
        else lo = mid + 1;
      } else if (direction === 1) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function nearestAnchor(direction: 1 | -1): number {
    const anchors = timeline.snapshots;
    let lo = 0;
    let hi = anchors.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ms = anchors[mid]!.ms;
      if (direction === 1 ? ms > playheadMs + 1e-9 : ms < playheadMs - 1e-9) {
        best = mid;
        if (direction === 1) hi = mid - 1;
        else lo = mid + 1;
      } else if (direction === 1) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  function reveal(t: number): void {
    const x = pxAt(t);
    if (x < 0 || x > canvasWidth()) {
      const span = viewEnd - viewStart;
      setWindow(t - span * 0.45, t + span * 0.55);
    }
    // Vertical: the selected event's row scrolls into the viewport.
    const selection = selectedEventIndex !== -1 ? timeline.events[selectedEventIndex] : undefined;
    if (selection !== undefined) revealRow(rowOfEvent(selection));
  }

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    // SELECT: the speed dropdown keeps its native space behavior; BUTTON: a
    // focused button is space-activated natively (including the player itself).
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.tagName === "BUTTON" || target.isContentEditable)
    ) {
      return;
    }
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        stopPlayback(); // manual seek takes over from the player
        const dir = event.key === "ArrowLeft" ? -1 : 1;
        const index = nearestEventIndex(dir);
        if (index !== -1) {
          setPlayheadMs(timeline.events[index]!.ms);
          reveal(timeline.events[index]!.ms);
        }
        break;
      }
      case "PageUp":
      case "PageDown": {
        stopPlayback(); // manual seek takes over from the player
        const dir = event.key === "PageUp" ? -1 : 1;
        const index = nearestAnchor(dir);
        if (index !== -1) {
          setPlayheadMs(timeline.snapshots[index]!.ms);
          reveal(timeline.snapshots[index]!.ms);
        }
        break;
      }
      case "Home":
        stopPlayback(); // manual seek takes over from the player
        fitWindow();
        setPlayheadMs(lo0);
        break;
      case "End":
        stopPlayback(); // manual seek takes over from the player
        fitWindow();
        setPlayheadMs(hi0);
        break;
      case " ": {
        // Play/pause toggle (finished sessions only; a live session leaves
        // the page's native space handling alone). Hold-repeat must not
        // strobe the toggle.
        if (!event.repeat && timeline.sessionEnded && timeline.events.length > 0) {
          togglePlayback();
        }
        break;
      }
      case "+":
      case "=":
        zoomAround(1.25, canvasWidth() / 2);
        break;
      case "-":
      case "_":
        zoomAround(1 / 1.25, canvasWidth() / 2);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  window.addEventListener("keydown", onKeyDown, { passive: false });

  /* ------------------------------------------------------------- theme UI */

  const storedTheme = window.sessionStorage.getItem(storeKey(sessionId));
  let themeMode: "default-light" | "raw" = storedTheme === "raw" ? "raw" : "default-light";

  for (const button of themeToggle.querySelectorAll<HTMLButtonElement>("button")) {
    button.classList.toggle("active", button.dataset.mode === themeMode);
    button.addEventListener("click", () => {
      const next = (button.dataset.mode as "raw" | "default-light") ?? "default-light";
      themeMode = next;
      window.sessionStorage.setItem(storeKey(sessionId), next);
      for (const other of themeToggle.querySelectorAll<HTMLButtonElement>("button")) {
        other.classList.toggle("active", other.dataset.mode === themeMode);
      }
      syncReplica();
    });
  }

  zoomOutBtn.addEventListener("click", () => setReplicaZoom(replicaZoom / 1.25));
  zoomInBtn.addEventListener("click", () => setReplicaZoom(replicaZoom * 1.25));
  zoomFitBtn.addEventListener("click", () => setReplicaZoom(1));
  zoom11Btn.addEventListener("click", () => setReplicaZoom(1 / Math.max(replicaFitScale, 1e-6)));

  /* ------------------------------------------------------- event transport */

  /**
   * The "event player" above the strip (2026-10-22): the ←/→/Home/End
   * keyboard steps as centered buttons — every hop funnels through
   * setPlayheadMs, so snapping, focus-follow and the replica stay in sync.
   */
  function gotoEvent(index: number): void {
    const event = timeline.events[index];
    if (event === undefined) return;
    setPlayheadMs(event.ms);
    reveal(event.ms);
  }

  // Manual seeks stop playback (the stepper is "your hands took over").
  transportFirst.addEventListener("click", () => {
    stopPlayback();
    gotoEvent(0);
  });
  transportLast.addEventListener("click", () => {
    stopPlayback();
    gotoEvent(timeline.events.length - 1);
  });
  transportPrev.addEventListener("click", () => {
    stopPlayback();
    const index = nearestEventIndex(-1);
    if (index !== -1) gotoEvent(index);
  });
  transportNext.addEventListener("click", () => {
    stopPlayback();
    const index = nearestEventIndex(1);
    if (index !== -1) gotoEvent(index);
  });

  /** Reflect the selection's position: nothing to step to ⇒ buttons disabled. */
  function updateTransport(): void {
    const hasEvents = timeline.events.length > 0;
    transportFirst.disabled = !hasEvents;
    transportLast.disabled = !hasEvents;
    transportPrev.disabled = !hasEvents || nearestEventIndex(-1) === -1;
    transportNext.disabled = !hasEvents || nearestEventIndex(1) === -1;
    playbackBtn.disabled = !hasEvents;
  }
  updateTransport();

  /* ---------------------------------------------------------------- playback */

  /**
   * Playback (2026-10-27): finished-session auto-stepping — the ▶/⏸ toggle
   * between the stepper buttons advances one event per interval from the
   * speed dropdown (0.2s…3s, default 1s), exactly like pressing → repeatedly.
   * Visible only when the runtime's end marker arrived (`sessionEnded`) —
   * live sessions keep the auto-scroll toggle instead. Every manual seek
   * (canvas scrub/click, stepper buttons, keyboard steps) stops it; running
   * off the last event stops it. Space toggles (see onKeyDown).
   */
  let playing = false;
  let playbackTimer = 0;
  let playbackSpeedMs = 1000;

  /** Halt timer + reset the toggle to its "play" face. Idempotent. */
  function stopPlayback(): void {
    if (playbackTimer !== 0) {
      window.clearInterval(playbackTimer);
      playbackTimer = 0;
    }
    playing = false;
    playbackBtn.textContent = "▶";
    playbackBtn.setAttribute("aria-pressed", "false");
    playbackBtn.setAttribute("aria-label", "play");
    playbackBtn.classList.remove("active");
    playbackBtn.title = "play (space)";
  }

  /** Advance one event (skipping same-ms duplicates); off the tail ⇒ stop. */
  function advancePlayback(): void {
    const index = nearestEventIndex(1);
    if (index === -1) {
      stopPlayback();
      return;
    }
    gotoEvent(index);
  }

  function startPlayback(): void {
    if (timeline.events.length === 0) return;
    stopPlayback();
    // At/after the last event ⇒ restart from the first (media-player rule).
    if (nearestEventIndex(1) === -1) gotoEvent(0);
    playing = true;
    playbackBtn.textContent = "⏸";
    playbackBtn.setAttribute("aria-pressed", "true");
    playbackBtn.setAttribute("aria-label", "pause");
    playbackBtn.classList.add("active");
    playbackBtn.title = "pause (space)";
    playbackTimer = window.setInterval(advancePlayback, playbackSpeedMs);
  }

  const togglePlayback = (): void => {
    if (playing) stopPlayback();
    else startPlayback();
  };

  playbackBtn.addEventListener("click", togglePlayback);

  /** Chosen cadence applies immediately — a running interval is rescheduled. */
  speedSelect.addEventListener("change", () => {
    const seconds = Number.parseFloat(speedSelect.value);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    playbackSpeedMs = seconds * 1000;
    if (playing) {
      window.clearInterval(playbackTimer);
      playbackTimer = window.setInterval(advancePlayback, playbackSpeedMs);
    }
  });

  /** Finished sessions get the player; live ones keep auto-scroll only. The
   *  markup starts hidden — the two reveal points are: page load on an ended
   *  session (`sessionEnded`), and the live poll seeing the end marker. */
  const showPlayback = (): void => {
    playbackBtn.classList.remove("hidden");
    speedSelect.classList.remove("hidden");
  };
  if (timeline.sessionEnded) showPlayback();


  /* ------------------------------------------------------------- auto-scroll */

  /**
   * Auto-scroll (2026-10-22): while the session is live, each poll that brings
   * new events places the playhead on the newest event and keeps the window's
   * right edge pinned to "now" (the user's zoom span is preserved). The
   * toggle exists only while the session is live — it disables itself the
   * moment the runtime's end marker arrives.
   */
  const autostepWrap = app.querySelector<HTMLDivElement>("#tl-autostep")!;
  const autostepBtn = app.querySelector<HTMLButtonElement>("#tl-autostep-btn")!;
  let autoStep = false;

  /** Jump to the newest event, viewport glued to the session's right edge. */
  const applyAutoStep = (): void => {
    if (!autoStep || timeline.events.length === 0) return;
    const span = Math.max(viewEnd - viewStart, MIN_VISIBLE_MS);
    viewEnd = hi0;
    viewStart = Math.max(lo0, hi0 - span);
    gotoEvent(timeline.events.length - 1);
  };

  /** Only a running session offers auto-scroll: finished sessions don't
   *  receive new events, so the control is removed from the toolbar. */
  const hideAutoStep = (): void => {
    autoStep = false;
    autostepWrap.classList.add("hidden");
  };

  autostepBtn.addEventListener("click", () => {
    autoStep = !autoStep;
    autostepBtn.classList.toggle("active", autoStep);
    if (autoStep) applyAutoStep();
  });

  const showAutoStep = (): void => {
    autostepWrap.classList.remove("hidden");
  };

  if (timeline.sessionEnded) {
    hideAutoStep();
  } else {
    showAutoStep();
  }


  syncReplica();
  raf = requestAnimationFrame(frame);

  /* ------------------------------------------------------------------- live */

  /**
   * Live session tracking (2026-10-22): while the runtime session is still
   * open (no `session type=end` point yet), the timeline re-fetches every
   * second and rebuilds in place — the LIVE pill in the topbar pulses while
   * it tracks. The poll stops itself on the first response that reports the
   * session ended (final rebuild renders the closed session), and the view's
   * destroy() tears the timer down on navigation.
   */
  const LIVE_POLL_MS = 1000;
  /** Legacy sessions can lack a `session type=end` point entirely (old runtimes,
   *  undelivered end markers) — without a staleness guard those would poll at
   *  1s forever. After 2 min of no new events the cadence drops to 10s and the
   *  badge goes idle; the poll still ends the moment the end marker appears. */
  const LIVE_STALE_MS = 120_000;
  const LIVE_IDLE_POLL_MS = 10_000;

  const liveBadge = app.querySelector<HTMLSpanElement>("#tl-live")!;
  const liveLabel = app.querySelector<HTMLSpanElement>("#tl-live-label")!;

  let liveTimer = 0;
  let livePollMs = LIVE_POLL_MS;
  let liveInFlight = false;
  let liveErrors = 0;

  const stopLivePoll = (): void => {
    if (liveTimer !== 0) {
      window.clearInterval(liveTimer);
      liveTimer = 0;
    }
    liveBadge.classList.add("hidden");
  };

  const restartLiveTimer = (ms: number): void => {
    if (ms === livePollMs) return;
    livePollMs = ms;
    window.clearInterval(liveTimer);
    liveTimer = window.setInterval(livePoll, ms);
  };

  const livePoll = (): void => {
    if (liveInFlight || destroyed) return;
    liveInFlight = true;
    api
      .timeline(sessionId)
      .then((next) => {
        liveErrors = 0;
        liveBadge.classList.remove("syncing");
        if (next.sessionEnded) {
          // Session closed — final static render, badge gone, poll stops.
          // The auto-scroll toggle (live-only) is replaced by the player.
          stopLivePoll();
          rebuildModel(next);
          syncReplica();
          hideAutoStep();
          showPlayback();
          return;
        }
        if (Date.now() - next.endMs > LIVE_STALE_MS) {
          // No end marker yet, but nothing new for a while: idle cadence.
          restartLiveTimer(LIVE_IDLE_POLL_MS);
          liveBadge.classList.add("syncing");
          liveLabel.textContent = `live · idle (last event ${Math.round((Date.now() - next.endMs) / 1000)}s ago)`;
        } else {
          restartLiveTimer(LIVE_POLL_MS);
          liveLabel.textContent = "live";
        }
        rebuildModel(next);
        syncReplica();
        applyAutoStep();
      })
      .catch(() => {
        // Keep polling: a lagging server/catalog or a stale Influx connection
        // recovers; the badge shows the degraded (reconnecting) state.
        liveErrors++;
        liveBadge.classList.add("syncing");
        liveLabel.textContent = liveErrors >= 3 ? `live · reconnecting (×${liveErrors})` : "live";
      })
      .finally(() => {
        liveInFlight = false;
      });
  };

  if (!timeline.sessionEnded) {
    liveLabel.textContent = "live";
    liveBadge.classList.remove("hidden");
    livePollMs = LIVE_POLL_MS;
    liveTimer = window.setInterval(livePoll, LIVE_POLL_MS);
  }


  const resizeObserver = new ResizeObserver(() => {
    dirty = true;
    // The replica viewport resizes with the page (panel below the strip):
    // re-fit to the current box, keeping the user's zoom multiplier.
    if (liveComposite !== null) {
      requestAnimationFrame(() => {
        replicaFitScale = computeFitScale();
        applyReplicaZoom();
        dirty = true;
      });
    }
  });
  resizeObserver.observe(wrap);
  resizeObserver.observe(replicaViewport);

  return {
    destroy() {
      destroyed = true;
      window.clearInterval(liveTimer);
      stopPlayback(); // release the playback interval too
      document.body.classList.remove("timeline-open");
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
    },
  };
}

/* ---------------------------------------------------------------- helpers */

function drawShell(app: HTMLElement, timeline: TimelineResponse): void {
  const { session } = timeline;
  app.innerHTML = `
    <header class="topbar">
      <a class="btn small" href="#/">← Sessions</a>
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h2 class="session-title mono" title="session id">${escapeHtml(session.id)}</h2>
      </div>
      <div class="session-meta">
        <span class="pill ok">${timeline.eventCount} events</span>
        <span class="pill info">${timeline.snapshots.length} snapshots</span>
        <span class="pill ${timeline.unresolvedCount > 0 ? "warn" : "ok"}">${timeline.unresolvedCount} unresolved</span>
        <span class="hint">${escapeHtml(metaLine(session))}</span>
        <span class="pill live hidden" id="tl-live" title="session is still running — auto-refreshing every 1s">
          <span class="dot" aria-hidden="true"></span><span id="tl-live-label">live</span>
        </span>
      </div>
    </header>
    <main class="timeline-layout">
      <section class="timeline-left panel">
        <div class="canvas-toolbar">
          <div class="segmented" id="tl-transport" role="group" aria-label="Event transport">
            <button type="button" id="tl-first" title="go to first event (Home)">&lt;&lt;</button>
            <button type="button" id="tl-prev" title="previous event (←)">&lt;</button>
            <button type="button" id="tl-play" class="hidden" title="play (space)" aria-pressed="false" aria-label="play">&#9654;</button>
            <button type="button" id="tl-next" title="next event (→)">&gt;</button>
            <button type="button" id="tl-last" title="go to last event (End)">&gt;&gt;</button>
          </div>
          <select id="tl-speed" class="speed-select hidden" aria-label="Playback speed" title="playback speed: one event per interval">
            <option value="0.2">0.2s</option>
            <option value="0.5">0.5s</option>
            <option value="1" selected>1s</option>
            <option value="1.5">1.5s</option>
            <option value="2">2s</option>
            <option value="3">3s</option>
          </select>
          <div class="segmented hidden" id="tl-autostep" role="group" aria-label="Auto-scroll">
            <button type="button" id="tl-autostep-btn" title="auto-scroll: follow the newest event while the session is live">⏩ auto-scroll</button>
          </div>
        </div>
        <div class="canvas-wrap" id="tl-wrap">
          <canvas id="tl-canvas" aria-label="Session timeline canvas"></canvas>
        </div>
      </section>
      <aside class="replica-panel panel">
        <div class="replica-head">
          <div class="replica-title">UI replica @ playhead</div>
          <div class="replica-zoom">
            <div class="segmented" id="tl-replica-zoom" role="toolbar" aria-label="Replica zoom">
              <button type="button" id="tl-zoom-out" title="zoom out (wheel over the replica works too)">−</button>
              <button type="button" id="tl-zoom-11" title="native 1:1 scale">1:1</button>
              <button type="button" id="tl-zoom-fit" title="reset: fit the capture into the panel">⤢</button>
              <button type="button" id="tl-zoom-in" title="zoom in (wheel over the replica works too)">+</button>
            </div>
            <span class="zoom-level" id="tl-zoom-level">—</span>
          </div>
          <div class="segmented" id="tl-theme-toggle" role="tablist" aria-label="Theme mode">
            <button type="button" data-mode="default-light" role="tab">Default light</button>
            <button type="button" data-mode="raw" role="tab">Raw</button>
          </div>
        </div>
        <div class="replica-warnings" id="tl-replica-warnings"></div>
        <div class="replica-meta" id="tl-replica-meta">—</div>
        <div class="replica-viewport" id="tl-replica-viewport">
          <div class="replica-holder" id="tl-replica-holder"></div>
          <div class="replica-empty hidden" id="tl-replica-empty"></div>
        </div>
        <div class="replica-footer" id="tl-replica-footer"></div>
      </aside>
    </main>
`;
}

function metaLine(session: TimelineResponse["session"]): string {
  const parts: Array<string> = [];
  for (const key of ["owner", "platform", "screen"] as const) {
    const value = session[key];
    if (value) parts.push(value);
  }
  return parts.join(" · ") || "no ledger owner info";
}

function asUISnapshot(parsed: ParsedSnapshotDto): UISnapshot {
  return parsed as unknown as UISnapshot;
}

function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function clipText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function storeKey(sessionId: string): string {
  return `mdu.timeline.theme.${sessionId}`;
}
