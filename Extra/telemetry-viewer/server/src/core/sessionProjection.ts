/**
 * Session projection — the read model builder (plan §6.1).
 *
 * Takes normalized {@link RawEvent}s (any mix of `session`, `ui_event`,
 * `ui_snapshot_taken` points) and produces one {@link Session} per session id.
 *
 * Guarantees:
 * - Never touches snapshot YAML. Session meta comes from ledger **fields** or
 *   session-only sources; a test spy asserts `loadSnapshot` is never called.
 * - Unknown measurements were dropped at the source boundary; here nothing is
 *   silently discarded again.
 * - `.lp`-sourced and InfluxDB-sourced inputs produce identical sessions
 *   (parity-tested).
 */
import type { RawEvent, Session, SessionViewSpan, SnapshotLedgerEntry, SourceId } from "../domain.js";

/** Interaction element types that mark the event's view as a popup view. */
const POPUP_ELEMENT_TYPES = ["mdu.ui.Snackbar", "mdu.ui.Dialog"];

/** Popup marker for legacy inference (view types never tracked by old runtimes). */
function isPopupAttribution(event: RawEvent): boolean {
  const elementType = event.tags.element_type ?? "";
  for (const prefix of POPUP_ELEMENT_TYPES) {
    if (elementType.startsWith(prefix)) return true;
  }
  const view = event.tags.view ?? "";
  return view === "Snackbar" || view === "Dialog";
}

/** Injection seam reserved for later phases (P2+ snapshot enrichment). */
export interface ProjectionHooks {
  /**
   * Hook the viewer would use to load parsed snapshot YAML. The projection
   * deliberately never calls it in P1 — session meta is ledger-only.
   */
  loadSnapshot?: (storageKey: string, hash: string | null) => Promise<unknown>;
}

const DEFAULT_HOOKS: ProjectionHooks = {};

export function projectSessions(events: readonly RawEvent[], hooks: ProjectionHooks = DEFAULT_HOOKS): Session[] {
  // Room for the future hook keeps the call signature stable across phases.
  void hooks.loadSnapshot;

  interface Accumulator {
    origin: SourceId | "unknown";
    startNs: bigint | null;
    endNs: bigint | null;
    firstNs: bigint | null;
    lastNs: bigint | null;
    eventCount: number;
    snapshotCount: number;
    owner: string | null;
    platform: string | null;
    screen: string | null;
    views: SessionViewSpan[];
    /** view key → span awaiting its close event (for dwell pairing). */
    pendingSpans: Map<string, SessionViewSpan>;
    /** view_id → attribution candidates (first/last event, popup marker) for legacy popup inference. */
    candidates: Map<string, { view: string; firstNs: bigint; lastNs: bigint; popup: boolean }>;
    snapshots: SnapshotLedgerEntry[];
    eventCountsByType: Map<string, number>;
  }

  const sessions = new Map<string, Accumulator>();

  const accOf = (sessionId: string): Accumulator => {
    let acc = sessions.get(sessionId);
    if (acc === undefined) {
      acc = {
        origin: "unknown",
        startNs: null,
        endNs: null,
        firstNs: null,
        lastNs: null,
        eventCount: 0,
        snapshotCount: 0,
        owner: null,
        platform: null,
        screen: null,
        views: [],
        pendingSpans: new Map(),
        candidates: new Map(),
        snapshots: [],
        eventCountsByType: new Map(),
      };
      sessions.set(sessionId, acc);
    }
    return acc;
  };

  const seen = (acc: Accumulator, ns: bigint): void => {
    if (acc.firstNs === null || ns < acc.firstNs) acc.firstNs = ns;
    if (acc.lastNs === null || ns > acc.lastNs) acc.lastNs = ns;
  };

  /**
   * Records one attribution candidate for legacy popup spans: popup views
   * (Dialog/Snackbar) never emitted view_open/view_close on old runtimes —
   * they only show up as interaction events attributed to their own view_id.
   */
  const updateCandidate = (acc: Accumulator, viewId: string, event: RawEvent): void => {
    let candidate = acc.candidates.get(viewId);
    if (candidate === undefined) {
      acc.candidates.set(viewId, {
        view: event.tags.view ?? "",
        firstNs: event.timestampNs,
        lastNs: event.timestampNs,
        popup: isPopupAttribution(event),
      });
      return;
    }
    if (event.timestampNs < candidate.firstNs) candidate.firstNs = event.timestampNs;
    if (event.timestampNs > candidate.lastNs) candidate.lastNs = event.timestampNs;
    if (candidate.view === "" && event.tags.view) candidate.view = event.tags.view;
    if (isPopupAttribution(event)) candidate.popup = true;
  };

  for (const event of events) {
    const sessionId = event.tags.session;
    if (sessionId === "") {
      // A point without a session tag cannot be attributed to a session.
      // The runtime always writes one; here we drop honestly at the boundary.
      continue;
    }
    const acc = accOf(sessionId);

    if (event.measurement === "session") {
      seen(acc, event.timestampNs);
      if (event.tags.type === "start") {
        if (acc.startNs === null || event.timestampNs < acc.startNs) acc.startNs = event.timestampNs;
      } else if (event.tags.type === "end") {
        if (acc.endNs === null || event.timestampNs > acc.endNs) acc.endNs = event.timestampNs;
      }
      continue;
    }

    if (event.measurement === "ui_event") {
      acc.eventCount++;
      seen(acc, event.timestampNs);
      const type = event.tags.type ?? "";
      acc.eventCountsByType.set(type, (acc.eventCountsByType.get(type) ?? 0) + 1);

      const viewId = event.tags.view_id ?? null;
      if (viewId !== null && viewId !== "") {
        updateCandidate(acc, viewId, event);
      }

      if (type === "view_open" || type === "view_close") {
        const view = event.tags.view ?? "";
        const layer = event.tags.layer ?? null;
        const spanKey = `${view}\u0000${viewId ?? ""}`;
        if (type === "view_open") {
          // An open while a previous span with the same identity is still
          // pending implicitly closes that span here (close event lost).
          const prior = acc.pendingSpans.get(spanKey);
          if (prior !== undefined) {
            prior.closeNs = event.timestampNs;
            prior.dwellSeconds = prior.dwellSeconds ?? Number(event.timestampNs - prior.openNs) / 1e9;
            acc.pendingSpans.delete(spanKey);
          }
          const span: SessionViewSpan = {
            view,
            viewId,
            openNs: event.timestampNs,
            closeNs: null,
            dwellSeconds: null,
            layer,
          };
          acc.views.push(span);
          acc.pendingSpans.set(spanKey, span);
        } else {
          const pending = acc.pendingSpans.get(spanKey);
          if (pending !== undefined) {
            pending.closeNs = event.timestampNs;
            // The runtime records dwell seconds on the close event; fall back
            // to the span width when a measurement is missing.
            pending.dwellSeconds =
              event.fields.dwell ?? Number(event.timestampNs - pending.openNs) / 1e9;
            acc.pendingSpans.delete(spanKey);
          } else {
            // Close without a matching open (data came in mid-session):
            // keep it visible with a degenerate span.
            acc.views.push({
              view,
              viewId,
              openNs: event.timestampNs,
              closeNs: event.timestampNs,
              dwellSeconds: event.fields.dwell ?? 0,
              layer,
            });
          }
        }
      }
      continue;
    }

    if (event.measurement === "ui_snapshot_taken") {
      acc.snapshotCount++;
      seen(acc, event.timestampNs);
      acc.snapshots.push({
        timestampNs: event.timestampNs,
        view: event.tags.view ?? null,
        viewId: event.tags.view_id ?? null,
        key: event.fields.key ?? null,
        hash: event.fields.hash ?? null,
        nodes: event.fields.nodes ?? null,
        width: event.fields.width ?? null,
        height: event.fields.height ?? null,
      });
      // Earliest ledger point wins: owner info is metadata, not per-shot data.
      acc.owner = acc.owner ?? event.fields.owner ?? null;
      acc.platform = acc.platform ?? event.fields.platform ?? null;
      acc.screen = acc.screen ?? event.fields.screen ?? null;
      continue;
    }
  }

  const projected: Session[] = [];
  for (const [id, acc] of sessions) {
    // Legacy popup spans: candidates flagged as popup views that never received
    // a lifecycle pair get a synthesized span from their first attributed event
    // to their last (auto-dismissed snackbars with no interaction become an
    // honest degenerate span at the close event). Never dropped.
    for (const [viewId, candidate] of acc.candidates) {
      if (!candidate.popup) continue;
      if (acc.views.some((span) => span.viewId === viewId)) continue;
      acc.views.push({
        view: candidate.view || viewId,
        viewId,
        openNs: candidate.firstNs,
        closeNs: candidate.lastNs,
        dwellSeconds: Number(candidate.lastNs - candidate.firstNs) / 1e9,
        layer: null,
      });
    }

    const boundsEnd = acc.endNs ?? acc.lastNs;
    const boundsStart = acc.startNs ?? acc.firstNs;
    projected.push({
      id,
      origin: acc.origin,
      startNs: acc.startNs,
      endNs: acc.endNs,
      firstEventNs: acc.firstNs,
      lastEventNs: acc.lastNs,
      durationNs: boundsStart !== null && boundsEnd !== null ? boundsEnd - boundsStart : null,
      eventCount: acc.eventCount,
      snapshotCount: acc.snapshotCount,
      owner: acc.owner,
      platform: acc.platform,
      screen: acc.screen,
      views: acc.views
        .slice()
        .sort((a, b) => (a.openNs < b.openNs ? -1 : a.openNs > b.openNs ? 1 : 0)),
      snapshots: acc.snapshots.sort((a, b) => (a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : 0)),
      eventCountsByType: Object.fromEntries(
        [...acc.eventCountsByType.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      openViewCount: acc.pendingSpans.size,
    });
  }
  return projected;
}
