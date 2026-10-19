/**
 * Session catalog — orchestrates the source providers and builds the session
 * read model (plan §5 server, §6.1).
 *
 * Providers arrive in priority order (files first, InfluxDB last). A session
 * that exists in an earlier provider is ignored in later ones, so data never
 * double-counts when the outbox has already flushed to both places.
 */
import type {
  FetchOptions,
  RawEvent,
  RawEventResult,
  Session,
  SourceError,
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
  /** Aggregate health: `ok` when every configured provider is healthy. */
  status: "ok" | "degraded" | "unavailable";
}

export async function buildSessionCatalog(
  providers: readonly SourceProvider[],
  options: FetchOptions = {},
): Promise<SessionCatalog> {
  const runs: ProviderRun[] = [];
  const sessionLists: Array<{ providerId: SourceProvider["id"]; sessions: Session[] }> = [];

  // Files must resolve before Influx runs: files-first wins by identity.
  for (const provider of providers) {
    const status = await provider.describe();
    let result: RawEventResult | null = null;
    let error: SourceError | null = null;
    if (status.available) {
      result = await provider.fetchEvents(options);
      error = result.error ?? null;
    }
    runs.push({ id: provider.id, status, result, error });
    if (result !== null) {
      const sessions = projectSessions(result.events);
      for (const session of sessions) session.origin = provider.id;
      sessionLists.push({ providerId: provider.id, sessions });
    }
  }

  // Identity-based union with files-first precedence.
  const merged = new Map<string, Session>();
  for (const { sessions } of sessionLists) {
    for (const session of sessions) {
      if (!merged.has(session.id)) merged.set(session.id, session);
    }
  }

  const sessions = [...merged.values()].sort(compareSessions);
  const anyAvailable = runs.some((run) => run.status.available);
  const anyErrors = runs.some((run) => run.error !== null);
  return {
    sessions,
    runs,
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
