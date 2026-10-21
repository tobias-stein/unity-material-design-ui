/**
 * Session catalog — orchestrates the source providers and builds the session
 * read model (plan §5 server, §6.1).
 *
 * Providers arrive in priority order (files first, InfluxDB last); the origin
 * of a merged session is the first provider that holds it. Sessions found in
 * several providers are **unioned**: a leftover `pending-*.lp` contains only
 * the tail of a session whose earlier batches InfluxDB already acknowledged,
 * so first-wins-by-identity would present the partial tail and drop the
 * complete ledger (snapshots included) that lives in InfluxDB. Duplicate
 * points (at-least-once delivery) collapse on a wire identity key so data
 * never double-counts.
 */
import type {
  FetchOptions,
  RawEvent,
  RawEventResult,
  Session,
  SourceError,
  SourceId,
  SourceProvider,
  SourceStatus,
} from "../domain.js";
import { projectSessions } from "./sessionProjection.js";

export interface ProviderRun {
  id: SourceProvider["id"];
  status: SourceStatus;
  result: RawEventResult | null;
  error: SourceError | null;
}

export interface SessionCatalog {
  sessions: Session[];
  runs: ProviderRun[];
  /**
   * The unioned event stream each projected session was built from, keyed by
   * session id (server-only, not serialized). Sessions found across several
   * providers hold the *merged* stream here — a detail endpoint that re-derives
   * events from the session's `origin` provider run alone would drop the events
   * of a split stream (e.g. a `pending-*.lp` tail over an influx-led body).
   */
  sessionEvents: ReadonlyMap<string, readonly RawEvent[]>;
  /** Aggregate health: `ok` when every configured provider is healthy. */
  status: "ok" | "degraded" | "unavailable";
}

export async function buildSessionCatalog(
  providers: readonly SourceProvider[],
  options: FetchOptions = {},
): Promise<SessionCatalog> {
  const runs: ProviderRun[] = [];

  // Per-session event union across providers, in provider priority order.
  // `origin` is the first provider that holds the session; the identity set
  // collapses points that arrived via both the outbox and the archive.
  interface Union {
    origin: SourceId;
    events: RawEvent[];
    identity: Set<string>;
  }
  const bySession = new Map<string, Union>();

  for (const provider of providers) {
    const status = await provider.describe();
    let result: RawEventResult | null = null;
    let error: SourceError | null = null;
    if (status.available) {
      result = await provider.fetchEvents(options);
      error = result.error ?? null;
    }
    runs.push({ id: provider.id, status, result, error });
    if (result === null) continue;

    for (const event of result.events) {
      const sessionId = event.tags.session;
      if (sessionId === "") continue; // unattributable at projection anyway

      let union = bySession.get(sessionId);
      if (union === undefined) {
        union = { origin: provider.id, events: [], identity: new Set() };
        bySession.set(sessionId, union);
      }

      // At-least-once delivery guard. The runtime emits one point per wire
      // series (measurement + timestamp + full tag set) — a wire-exact
      // duplicate is a replay, never a distinct event. The key carries the
      // full tag set (not just type/view_id) so two *distinct* points that
      // share a nanosecond (e.g. two different elements clicking in the same
      // instant) never collapse; exact replays share every tag regardless.
      const identityKey = [
        event.measurement,
        event.timestampNs.toString(),
        event.tags.type ?? "",
        event.tags.view ?? "",
        event.tags.view_id ?? "",
        event.tags.element ?? "",
        event.tags.element_type ?? "",
        event.tags.layer ?? "",
        // ui_snapshot_taken carries its artifact identity in fields.
        event.fields.key ?? "",
      ].join("\u0000");
      if (union.identity.has(identityKey)) continue;
      union.identity.add(identityKey);
      union.events.push(event);
    }
  }

  // Projection is order-sensitive for view open/close pairing; the merged
  // event set interleaves providers, so sort each session's union by time
  // (stable) before projecting.
  const sessions: Session[] = [];
  for (const union of bySession.values()) {
    union.events.sort((a, b) => (a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : 0));
    const session = projectSessions(union.events)[0];
    if (session === undefined) continue;
    session.origin = union.origin;
    sessions.push(session);
  }

  sessions.sort(compareSessions);
  // Retain each session's unioned stream: the API's detail read models
  // (timeline, aggregate) must see exactly what the projection saw.
  const sessionEvents = new Map<string, readonly RawEvent[]>();
  for (const [id, union] of bySession) sessionEvents.set(id, union.events);
  const anyAvailable = runs.some((run) => run.status.available);
  const anyErrors = runs.some((run) => run.error !== null);
  return {
    sessions,
    runs,
    sessionEvents,
    status: !anyAvailable ? "unavailable" : anyErrors ? "degraded" : "ok",
  };
}

/** Newest first; sessions without any time anchor sort deterministically last. */
function compareSessions(a: Session, b: Session): number {
  const aNs = a.startNs ?? a.firstEventNs ?? null;
  const bNs = b.startNs ?? b.firstEventNs ?? null;
  if (aNs === null && bNs === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (aNs === null) return 1;
  if (bNs === null) return -1;
  if (aNs !== bNs) return aNs > bNs ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Apply `q`/`from`/`to`/`limit` post-filtering on the catalog. */
export interface SessionQuery {
  q?: string;
  /** Epoch millisecond bounds (inclusive) on session start. */
  fromMs?: number;
  toMs?: number;
  limit: number;
}

export function filterSessions(sessions: readonly Session[], query: SessionQuery): Session[] {
  const needle = query.q !== undefined && query.q !== "" ? query.q.toLowerCase() : null;
  const from = query.fromMs ?? null;
  const to = query.toMs ?? null;
  const result: Session[] = [];
  for (const session of sessions) {
    if (needle !== null && !matches(session, needle)) continue;
    const startNs = session.startNs ?? session.firstEventNs ?? null;
    if (from !== null && (startNs === null || startNs < BigInt(Math.floor(from)) * 1_000_000n)) continue;
    if (to !== null && (startNs === null || startNs > BigInt(Math.floor(to)) * 1_000_000n)) continue;
    result.push(session);
    if (result.length >= query.limit) break;
  }
  return result;
}

function matches(session: Session, needle: string): boolean {
  const haystack: string[] = [session.id];
  if (session.owner) haystack.push(session.owner);
  if (session.platform) haystack.push(session.platform);
  if (session.screen) haystack.push(session.screen);
  for (const view of session.views) {
    if (view.view) haystack.push(view.view);
  }
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

/** Collect only the raw events worth keeping when counting (parity aid). */
export function countBySession(events: readonly RawEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const id = event.tags.session;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
