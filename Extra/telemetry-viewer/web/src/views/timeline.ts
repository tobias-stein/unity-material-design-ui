/**
 * Single-session timeline view (P2, plan §9.1) — NLE-style canvas timeline:
 *
 * - **Ruler**: time axis with adaptive tick density; wheel = zoom around
 *   cursor, shift+wheel = horizontal pan, drag = pan, pinch = zoom around the
 *   two-pointer midpoint. Min range = full session; max zoom = ms resolution
 *   (visible span ≥ 1 ms).
 * - **Lanes** (rows): view_open/view_close (+ dwell span bars), click, toggle
 *   (split by the `on` state), close, backdrop_click, and an unresolved lane
 *   for events no snapshot anchor could hold (§6.1 — never dropped). Dense
 *   clusters collapse into a per-pixel density bar (5k-event sessions stay
 *   smooth); sparse regions draw marbles.
 * - **Filmstrip**: one simplified blocky mini-map block per snapshot capture
 *   (scene change), fetched lazily + precomputed via the shared minimap;
 *   click snaps the playhead.
 * - **Playhead**: draggable in the ruler, click-to-place anywhere; PgUp/PgDn
 *   snap to snapshot anchors; ←/→ step events; Home/End clamp; double-click
 *   fits. The replica panel renders the nearest prior snapshot (~or before
 *   ← first snapshot → honest empty state) via `@mdu/snapshot-render`; wheel
 *   over the replica never zooms it (timeline-only zoom) and captured
 *   geometry warnings surface right below the header, as in the standalone
 *   viewer.
 */
import { api, ApiClientError, type ParsedSnapshotDto, type SnapshotResponse, type TimelineResponse } from "../api.js";
import {
  buildReplicaStage,
  computeMiniMap,
  defaultLightTheme,
  drawMiniMap,
  fitReplica,
  injectTheme,
  type MiniMapData,
  type UISnapshot,
} from "@mdu/snapshot-render";

/* ----------------------------------------------------------------- layout */

const RULER_H = 34;
const LANE_H = 34;
const FILM_H = 60;
const HANDLE_HALF = 6;
const MIN_VISIBLE_MS = 1; // max zoom: ms resolution
const MINIMAP_CONCURRENCY = 4;

const LANES = [
  { id: "views", label: "views open/close" },
  { id: "click", label: "click" },
  { id: "toggle", label: "toggle" },
  { id: "close", label: "close" },
  { id: "backdrop_click", label: "backdrop" },
  { id: "unresolved", label: "unresolved" },
] as const;

type LaneId = (typeof LANES)[number]["id"];

const MARBLE_COLORS = {
  views: "#8ab4f8",
  click: "#81c784",
  toggle_on: "#d0bcff",
  toggle_off: "#4a4b57",
  close: "#ffb74d",
  backdrop_click: "#64ffda",
  unresolved: "#f2b8b5",
};

/** Static lane color; the toggle lane resolves per-event to toggle_on/off. */
function marbleColor(laneId: LaneId): string {
  return laneId === "toggle" ? MARBLE_COLORS.toggle_off : MARBLE_COLORS[laneId];
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
  const fpsEl = app.querySelector<HTMLSpanElement>("#tl-fps")!;
  const themeToggle = app.querySelector<HTMLDivElement>("#tl-theme-toggle")!;
  const replicaHolder = app.querySelector<HTMLDivElement>("#tl-replica-holder")!;
  const replicaViewport = app.querySelector<HTMLDivElement>("#tl-replica-viewport")!;
  const replicaMeta = app.querySelector<HTMLDivElement>("#tl-replica-meta")!;
  const replicaFooter = app.querySelector<HTMLDivElement>("#tl-replica-footer")!;
  const replicaWarnings = app.querySelector<HTMLDivElement>("#tl-replica-warnings")!;
  const replicaEmpty = app.querySelector<HTMLDivElement>("#tl-replica-empty")!;

  // The replica never zooms or page-scrolls (plan §9.1): the timeline canvas is
  // the only zoom/pan surface, so wheel over the replica is swallowed.
  for (const surface of [replicaViewport, replicaHolder]) {
    surface.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
  }

  /* ------------------------------------------------------- canvas geometry */

  const T0 = timeline.startMs;
  const T1 = Math.max(timeline.endMs, timeline.startMs);
  const pad = Math.max(50, (T1 - T0) * 0.02);
  const lo0 = T0 - pad;
  const hi0 = T1 + pad;

  let viewStart = lo0;
  let viewEnd = hi0;
  let playheadMs = timeline.snapshots.length > 0 ? (timeline.snapshots[0]?.ms ?? T0) : T0;

  const laneBottom = RULER_H + LANES.length * LANE_H;
  const canvasH = laneBottom + FILM_H;

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
  let renderedAnchor = -1;
  let renderedTheme: "default-light" | "raw" | null = null;

  function anchorIndexAt(tMs: number): number {
    // Latest capture at or before the playhead (§6.1 "latest ≤ t").
    const anchors = timeline.snapshots;
    let lo = 0;
    let hi = anchors.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid]!.ms <= tMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

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
    const index = anchorIndexAt(playheadMs);
    if (index === -1) {
      renderedAnchor = -1;
      renderedTheme = null;
      replicaHolder.replaceChildren();
      replicaWarnings.replaceChildren();
      replicaMeta.textContent = "—";
      replicaFooter.textContent = "";
      replicaEmpty.textContent = "No snapshot at this moment (before the first capture).";
      replicaEmpty.classList.remove("hidden");
      return;
    }
    const anchor = timeline.snapshots[index]!;
    void replicaFor(index).then((entry) => {
      if (anchorIndexAt(playheadMs) !== index) return; // playhead moved on
      if (renderedAnchor === index && renderedTheme === themeMode) return; // already on stage
      if (entry.parsed === null) {
        const message =
          entry.error?.code === "SNAPSHOT_STORE_UNCONFIGURED"
            ? "Snapshot root not configured (SNAPSHOT_ROOT) — event lanes only."
            : entry.error?.code === "SNAPSHOT_ARTIFACT_MISSING"
            ? "Snapshot bytes missing in the store (ledger recorded the artifact)."
            : entry.error?.code === "SNAPSHOT_STORE_UNREACHABLE"
            ? "Snapshot store unreachable — check the root path."
            : `Snapshot unavailable (${entry.error?.code ?? "SNAPSHOT_FAILED"}).`;
        renderedAnchor = index;
        renderedTheme = themeMode;
        replicaHolder.replaceChildren();
        replicaWarnings.replaceChildren();
        replicaMeta.textContent = anchorName(anchor);
        replicaFooter.textContent = entry.error?.message ?? "";
        replicaEmpty.textContent = message;
        replicaEmpty.classList.remove("hidden");
        return;
      }

      const uiSnapshot = asUISnapshot(entry.parsed);
      replicaHolder.replaceChildren();
      const replica = buildReplicaStage(uiSnapshot, replicaHolder, themeMode);
      // Materialize the *applied* theme as --m3-* vars for CSS that reads
      // tokens (switch track/thumb, chip borders) — parity with the standalone.
      injectTheme(themeMode === "raw" ? uiSnapshot.theme : defaultLightTheme(), replica.stage);
      requestAnimationFrame(() => fitReplica(replica.stage, replicaViewport));

      renderedAnchor = index;
      renderedTheme = themeMode;
      const warnings = entry.parsed.warnings ?? [];
      replicaWarnings.replaceChildren(
        ...warnings.map((text) => {
          const chip = document.createElement("div");
          chip.className = "warn-chip";
          chip.textContent = `⚠ ${text}`;
          return chip;
        }),
      );
      replicaMeta.textContent = anchorName(anchor);
      const viewName = entry.parsed.view?.["name"] ?? "unnamed view";
      replicaFooter.textContent = `${fmtStamp(anchor.ms)} · ${viewName} · ${entry.parsed.nodes.length} nodes · schema v${entry.parsed.schemaVersion}`;
      replicaEmpty.classList.add("hidden");
    });
  }

  /* --------------------------------------------------------------- drawing */

  let dirty = true;
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

  function laneStyle(ctx: CanvasRenderingContext2D, cssW: number): void {
    for (let i = 0; i < LANES.length; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#111318" : "#0e1116";
      ctx.fillRect(0, RULER_H + i * LANE_H, cssW, LANE_H);
    }
    ctx.fillStyle = "#1a1d24";
    ctx.fillRect(0, laneBottom, cssW, FILM_H);
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

  function drawSpans(ctx: CanvasRenderingContext2D, cssW: number): void {
    const y = RULER_H + 7;
    const h = LANE_H - 14;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "top";
    for (const span of timeline.viewSpans) {
      const x0 = pxAt(span.openMs);
      const x1 = span.closeMs !== null ? pxAt(span.closeMs) : cssW;
      if (x1 < -2 || x0 > cssW + 2) continue;
      const left = Math.max(x0, -2);
      const right = Math.min(x1, cssW + 2);
      ctx.fillStyle = span.stillOpen ? "rgba(208,188,255,0.22)" : "rgba(138,180,248,0.16)";
      roundRectPath(ctx, left, y, Math.max(right - left, 2), h, 4);
      ctx.fill();
      // open + closure markers
      ctx.fillStyle = span.stillOpen ? "#d0bcff" : "#8ab4f8";
      ctx.fillRect(x0, y, 2, h);
      if (span.closeMs !== null) ctx.fillRect(Math.min(x1, cssW - 2) - 0, y, 2, h);
      const dwell = span.dwellSeconds ?? (x1 - x0) / 1000;
      const spanLabel =
        span.stillOpen
          ? `${span.view} · still open`
          : `${span.view} · ${dwell >= 100 ? dwell.toFixed(0) : dwell.toFixed(2)}s`;
      if (right - left > 70) {
        ctx.fillStyle = "#dde2ea";
        ctx.fillText(clipText(ctx, spanLabel, right - left - 10), left + 6, y + 4);
      }
    }
  }

  function drawLaneMarbles(ctx: CanvasRenderingContext2D, laneId: LaneId, cssW: number): void {
    const y = RULER_H + LANES.findIndex((l) => l.id === laneId) * LANE_H + LANE_H / 2;
    const events = timeline.events;

    // Binary search: first event index with ms ≥ viewStart - ε.
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.ms < viewStart - 1e-6) lo = mid + 1;
      else hi = mid;
    }

    // Bucket per pixel column: sparse ⇒ marbles, dense ⇒ density bar.
    const columns = cssW + 1;
    const counts = new Int32Array(columns);
    const colors: Array<string | null> = new Array(columns).fill(null);
    let crowded = 0;
    for (let i = lo; i < events.length; i++) {
      const event = events[i]!;
      if (event.ms > viewEnd + 1e-6) break;
      if (event.lane !== laneId) continue;
      const column = Math.floor(pxAt(event.ms) + 0.5);
      if (column < 0 || column >= columns) continue;
      counts[column]! += 1;
      const color =
        laneId === "toggle"
          ? event.on
            ? MARBLE_COLORS.toggle_on
            : MARBLE_COLORS.toggle_off
          : marbleColor(laneId);
      colors[column] = color;
      if (counts[column]! > 1) crowded++;
    }

    if (crowded === 0) {
      // Sparse: marbles. Unresolved events get a hollow ring treatment.
      for (let column = 0; column < columns; column++) {
        if (counts[column] === 0) continue;
        const color = colors[column]!;
        ctx.beginPath();
        ctx.arc(column + 0.5, y, 5, 0, Math.PI * 2);
        if (laneId === "unresolved") {
          ctx.fillStyle = "rgba(242,184,181,0.35)";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = MARBLE_COLORS.unresolved;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
          if (laneId === "toggle") {
            ctx.fillStyle = colors[column] === MARBLE_COLORS.toggle_on ? "#1d192b" : "#e6e0e9";
            ctx.fillRect(column - 1, y - 2, 3, 3);
          }
        }
      }
      return;
    }

    // Crowded: per-column density bars keep 5k sessions at 60 fps.
    const fallback = marbleColor(laneId);
    for (let column = 0; column < columns; column++) {
      if (counts[column] === 0) continue;
      const density = Math.min(1, 0.3 + counts[column]! / 12);
      ctx.fillStyle = colors[column] ?? fallback;
      ctx.globalAlpha = density;
      ctx.fillRect(column, y - LANE_H * 0.3, 1, LANE_H * 0.6);
      ctx.globalAlpha = 1;
    }
  }

  function drawFilmstrip(ctx: CanvasRenderingContext2D, cssW: number): void {
    ctx.fillStyle = "#151521";
    ctx.fillRect(0, laneBottom, cssW, FILM_H);
    ctx.fillStyle = "#2a2f38";
    ctx.fillRect(0, laneBottom - 1, cssW, 1);
    const anchors = timeline.snapshots;
    if (anchors.length === 0) {
      ctx.fillStyle = "#8f8a96";
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText("filmstrip: no snapshot capture in this session", 8, laneBottom + 26);
      return;
    }
    const stripY = laneBottom + 6;
    const stripH = FILM_H - 12;
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i]!;
      const nextAnchor = anchors[i + 1];
      const x0 = pxAt(anchor.ms);
      const xEnd = nextAnchor !== undefined ? pxAt(nextAnchor.ms) : cssW;
      const w = Math.max(16, Math.min(xEnd - x0 - 1, 240));
      if (xEnd < -4 || x0 > cssW + 4) continue;
      const minimap = minimaps.get(anchor.index);
      if (minimap === undefined) {
        ensureMinimap(anchor.index);
        ctx.strokeStyle = "#4b4453";
        ctx.strokeRect(x0 + 0.5, stripY + 0.5, w - 1, stripH - 1);
        continue;
      }
      drawMiniMap(
        ctx,
        minimap,
        x0 + 1,
        stripY,
        Math.max(1, w - 2),
        stripH,
        minimap.blocks.length > 0 ? FILM_BG : FILM_EMPTY_BG,
      );
      // capture boundary marker + index chip
      ctx.fillStyle = "rgba(138,180,248,0.9)";
      ctx.fillRect(x0, laneBottom, 2, FILM_H);
      if (w > 40) {
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillStyle = "#c4cad4";
        ctx.fillText(clipText(ctx, `#${i + 1} ${anchor.view ?? ""}`, w - 10), x0 + 5, stripY + 2);
        if (minimap.warnings.length > 0) {
          ctx.fillStyle = "#f2b8b5";
          ctx.fillText("⚠", x0 + 5, stripY + 14);
        }
      }
    }
  }

  function drawPlayhead(ctx: CanvasRenderingContext2D, cssW: number): void {
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
    // readout chip
    ctx.fillStyle = "rgba(253,214,99,0.14)";
    roundRectPath(ctx, Math.min(x + 3, cssW - 96), 2, 94, RULER_H - 6, 5);
    ctx.fill();
    ctx.fillStyle = "#fdd663";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.fillText(fmtRel(playheadMs), Math.min(x + 8, cssW - 88), RULER_H / 2 - 1);
    ctx.textBaseline = "top";
  }

  function draw(): void {
    const cssW = canvasWidth();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, canvasH);
    laneStyle(ctx, cssW);
    drawRuler(ctx, cssW);
    drawSpans(ctx, cssW);
    for (const lane of LANES) {
      if (lane.id === "views") continue; // drawn via spans + open/close marbles
      drawLaneMarbles(ctx, lane.id, cssW);
    }
    drawLaneMarbles(ctx, "views", cssW);
    drawFilmstrip(ctx, cssW);
    drawPlayhead(ctx, cssW);
  }

  let frames = 0;
  let fpsWindowStart = performance.now();

  function frame(): void {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    if (!dirty) return;
    resizeCanvas();
    const started = performance.now();
    draw();
    dirty = false;
    frames += 1;
    const now = performance.now();
    if (now - fpsWindowStart >= 500) {
      const fps = (frames * 1000) / (now - fpsWindowStart);
      fpsEl.textContent = `${Math.round(fps)} fps · draw ${(now - started).toFixed(1)} ms`;
      frames = 0;
      fpsWindowStart = now;
    }
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
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016));
      zoomAround(factor, localPx(event.clientX));
    },
    { passive: false },
  );

  canvas.addEventListener("click", (event) => {
    // Filmstrip block click = snap to that capture ("scene change").
    const y = event.clientY - canvas.getBoundingClientRect().top;
    if (y < laneBottom) return;
    const t = msAt(localPx(event.clientX));
    let bestIndex = -1;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const anchor of timeline.snapshots) {
      const diff = Math.abs(anchor.ms - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = anchor.index;
      }
    }
    if (bestIndex !== -1 && bestDiff < (viewEnd - viewStart) / 4) {
      setPlayheadMs(timeline.snapshots.find((a) => a.index === bestIndex)!.ms);
    }
  });

  function setPlayheadMs(t: number): void {
    const clamped = Math.min(Math.max(t, lo0), hi0);
    if (Math.abs(clamped - playheadMs) < 1e-9) return;
    playheadMs = clamped;
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
  }

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
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
        const dir = event.key === "PageUp" ? -1 : 1;
        const index = nearestAnchor(dir);
        if (index !== -1) {
          setPlayheadMs(timeline.snapshots[index]!.ms);
          reveal(timeline.snapshots[index]!.ms);
        }
        break;
      }
      case "Home":
        fitWindow();
        setPlayheadMs(lo0);
        break;
      case "End":
        fitWindow();
        setPlayheadMs(hi0);
        break;
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

  syncReplica();
  raf = requestAnimationFrame(frame);

  const resizeObserver = new ResizeObserver(() => {
    dirty = true;
  });
  resizeObserver.observe(wrap);

  return {
    destroy() {
      destroyed = true;
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
      </div>
    </header>
    <main class="timeline-layout">
      <section class="timeline-left panel">
        <div class="canvas-wrap" id="tl-wrap">
          <canvas id="tl-canvas" aria-label="Session timeline canvas"></canvas>
        </div>
      </section>
      <aside class="replica-panel panel">
        <div class="replica-head">
          <div class="replica-title">UI replica @ playhead</div>
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
    <footer class="hints">
      <span>wheel zoom (at cursor) · shift+wheel pan · drag pan · click sets playhead · drag ruler handle scrubs · ←/→ events · PgUp/PgDn snapshots · Home/End · dbl-click fit</span>
      <span class="hint" id="tl-fps"></span>
    </footer>
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
