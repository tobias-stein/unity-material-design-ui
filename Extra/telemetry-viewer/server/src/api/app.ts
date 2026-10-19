/**
 * HTTP surface of the telemetry viewer (plan §8).
 *
 * Reads only. Static hosting for the built web client plus the JSON API.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import type { ToolConfig } from "../config.js";
import type { RawEvent, Session, SourceProvider } from "../domain.js";
import { buildSessionCatalog, filterSessions, type ProviderRun, type SessionCatalog } from "../core/sessionCatalog.js";
import { buildTimelineFrame, type TimelineFrame } from "../core/timeline.js";
import {
  buildAggregate,
  aggregateToCsv,
  type AggregateResult,
  type SnapshotLoader,
} from "../core/heatmap.js";
import { AggregateGroupError } from "../core/versioning.js";
import { FluxInfluxSource } from "../sources/influx.js";
import { LpFileListSource } from "../sources/lpFiles.js";
import { LocalFsSnapshotStore } from "../storage/snapshotStore.js";
import { SnapshotService, SnapshotResolutionError } from "../snapshots/snapshotService.js";
import type { ParsedSnapshot } from "../snapshots/parse.js";
import { registerErrorHandlers, ApiError, errorBody } from "./errorHandling.js";
import { nsToMs, parseTimeParam, parseRangeQuery } from "./queryParams.js";
import { parseAggregateQuery, MAX_AGGREGATE_SESSIONS, type AggregateQuery } from "./aggregateQuery.js";

/** Parsed-snapshot resolution is shared across timeline playhead requests. */
function snapshotReference(
  session: Session,
  ref: string,
  query: Record<string, unknown>,
): { key: string | null; hash: string | null; index: number } {
  const anchors = session.snapshots;
  if (anchors.length === 0) {
    throw new ApiError("NO_SNAPSHOTS", "The session ledger holds no snapshot points.", 404);
  }

  const nearRaw = query.near;
  if (typeof nearRaw === "string" && nearRaw !== "") {
    const nearMs = parseTimeParam(nearRaw, "near");
    if (nearMs === undefined) {
      throw new ApiError("INVALID_TIME", "Query parameter \"near\" is not a valid time.", 400);
    }
    const viewIdFilter = typeof query.viewId === "string" && query.viewId !== "" ? query.viewId : null;
    const nearNs = BigInt(Math.floor(nearMs)) * 1_000_000n;
    // Latest anchor (of the requested view when given) at or before `near`.
    let best = -1;
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i]!;
      if (anchor.timestampNs > nearNs) continue;
      if (viewIdFilter !== null && anchor.viewId !== viewIdFilter) continue;
      best = i;
    }
    if (best === -1) {
      // Nothing before `near`: honest 404 (the client shows an honest
      // pre-first-snapshot state rather than teleporting to a later anchor).
      throw new ApiError(
        "SNAPSHOT_NOT_AT_OR_BEFORE",
        `No snapshot of view ${viewIdFilter ?? "(any)"} at or before the requested time.`,
        404,
      );
    }
    return { key: anchors[best]!.key, hash: anchors[best]!.hash, index: best };
  }

  if (/^\d+$/.test(ref)) {
    const index = Number.parseInt(ref, 10);
    if (index < 0 || index >= anchors.length) {
      throw new ApiError(
        "SNAPSHOT_INDEX_OUT_OF_RANGE",
        `Snapshot index ${index} out of range (session holds ${anchors.length}).`,
        404,
      );
    }
    return { key: anchors[index]!.key, hash: anchors[index]!.hash, index };
  }

  if (ref.startsWith("hash:")) {
    const hash = ref.slice("hash:".length);
    const index = anchors.findIndex((anchor) => anchor.hash === hash);
    if (index === -1) {
      throw new ApiError("SNAPSHOT_NOT_IN_LEDGER", `Ledger holds no snapshot with hash ${hash}.`, 404);
    }
    return { key: anchors[index]!.key, hash: anchors[index]!.hash, index };
  }

  throw new ApiError(
    "INVALID_SNAPSHOT_REF",
    "Snapshot reference must be a numeric index or `hash:<sha256>` (or pass ?near=<time>).",
    400,
  );
}

export interface AppOptions {
  config: ToolConfig;
  /** Override providers (tests inject fakes). */
  providers?: () => SourceProvider[];
  /** Cache lifetime for the session catalog (ms). */
  catalogCacheMs?: number;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1 << 20,
  });

  const providers = options.providers ?? defaultProviders(config);
  const snapshotStore = new LocalFsSnapshotStore(config.snapshotRoot);
  const snapshotService = new SnapshotService(snapshotStore);
  const cacheMs = options.catalogCacheMs ?? 5_000;
  const spaIndexFile = await resolveSpaIndex(app, config);

  let cachedCatalog: { at: number; promise: Promise<SessionCatalog> } | null = null;
  const catalog = (): Promise<SessionCatalog> => {
    if (cachedCatalog !== null && Date.now() - cachedCatalog.at < cacheMs) {
      return cachedCatalog.promise;
    }
    const promise = buildSessionCatalog(providers());
    cachedCatalog = { at: Date.now(), promise };
    promise.catch(() => {
      // Errors surface per-request; refresh on the next call.
      if (cachedCatalog?.promise === promise) cachedCatalog = null;
    });
    return promise;
  };

  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/api/")) app.log.info({ method: request.method, url: request.url }, "api");
  });

  app.get("/api/health", { logLevel: "error" }, async () => ({ ok: true }));

  app.get("/api/sources", { logLevel: "error" }, async () => {
    const [catalogResult, snapshotStatus] = await Promise.all([catalogGuard(catalog()), snapshotStore.describe()]);
    const sources: Record<string, unknown> = { snapshots: snapshotStatus };
    for (const run of catalogResult.runs) {
      sources[run.id] = { ...run.status, error: run.error ?? undefined };
    }
    const statuses = Object.values(sources) as Array<{ state?: string; available?: boolean }>;
    const degraded =
      catalogResult.status !== "ok" ||
      statuses.some((s) => s.state === "unconfigured" || s.state === "unreachable" || s.state === "not-a-directory");
    const unavailable = runsAllUnavailable(catalogResult);
    return {
      status: unavailable ? "unavailable" : degraded ? "degraded" : "ok",
      sources,
    };
  });

  app.get("/api/sessions", { logLevel: "error" }, async (request) => {
    const catalogResult = await catalogGuard(catalog());
    const query = parseRangeQuery(request.query as Record<string, unknown>);
    const sessions = filterSessions(catalogResult.sessions, query);
    const anySourceOk = catalogResult.runs.some((run) => run.status.available);
    if (!anySourceOk) {
      throw new ApiError(
        "NO_SOURCE_AVAILABLE",
        "No telemetry source is reachable right now.",
        503,
        sourceSummaries(catalogResult),
      );
    }
    return {
      total: catalogResult.sessions.length,
      count: sessions.length,
      status: catalogResult.status,
      sources: catalogResult.runs.map((run) => summarizeRun(run)),
      sessions: sessions.map(toSessionDto),
    };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", { logLevel: "error" }, async (request) => {
    const catalogResult = await catalogGuard(catalog());
    const session = catalogResult.sessions.find((entry) => entry.id === request.params.id);
    if (session === undefined) {
      throw new ApiError("SESSION_NOT_FOUND", `No session "${request.params.id}" in any source.`, 404);
    }
    return toSessionDtoIncludeSnapshots(session);
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/timeline", { logLevel: "error" }, async (request) => {
    const catalogResult = await catalogGuard(catalog());
    const session = catalogResult.sessions.find((entry) => entry.id === request.params.id);
    if (session === undefined) {
      throw new ApiError("SESSION_NOT_FOUND", `No session "${request.params.id}" in any source.`, 404);
    }
    // Events come from the session's own provider run (files win by identity,
    // §6.1) and are filtered to this session — never double-counted.
    const producingRun = catalogResult.runs.find((run) => run.id === session.origin);
    const sessionEvents = (producingRun?.result?.events ?? []).filter((event) => event.tags.session === session.id);
    const frame = buildTimelineFrame(session, sessionEvents);
    // The timeline is the session detail's event list — nothing may be added
    // or silently dropped between the two read models (tested invariant).
    return toTimelineDto(catalogResult, frame, session);
  });

  app.get<{
    Params: { id: string; ref: string };
    Querystring: Record<string, unknown>;
  }>("/api/snapshots/:id/:ref", { logLevel: "error" }, async (request) => {
    const catalogResult = await catalogGuard(catalog());
    const session = catalogResult.sessions.find((entry) => entry.id === request.params.id);
    if (session === undefined) {
      throw new ApiError("SESSION_NOT_FOUND", `No session "${request.params.id}" in any source.`, 404);
    }
    const reference = snapshotReference(session, request.params.ref, request.query);
    try {
      const resolved = await snapshotService.resolve({
        key: reference.key,
        hash: reference.hash,
      });
      return {
        sessionId: session.id,
        index: reference.index,
        snapshotId: resolved.snapshotId,
        hash: resolved.hash,
        key: resolved.key,
        parsed: resolved.parsed,
      };
    } catch (error) {
      if (error instanceof SnapshotResolutionError) {
        throw new ApiError(error.code, error.message, error.httpStatus as 400 | 404 | 409 | 503, error.detail);
      }
      throw error;
    }
  });

  /* ----------------------------------------------------------- aggregate (P3) */

  const snapshotLoader: SnapshotLoader = async (entry) => {
    try {
      const resolved = await snapshotService.resolve({ key: entry.key, hash: entry.hash });
      return { parsed: resolved.parsed, errorCode: null };
    } catch (error) {
      // Aggregate reads degrade per-snapshot with warnings — never 500 because
      // one artifact went missing while the events remain countable.
      if (error instanceof SnapshotResolutionError) {
        return { parsed: null, errorCode: error.code };
      }
      return { parsed: null, errorCode: error instanceof Error ? error.message : String(error) };
    }
  };

  /** Shared selection resolution for `/api/aggregate` and its CSV export. */
  const resolveAggregateSelection = async (
    catalogResult: SessionCatalog,
    query: AggregateQuery,
  ): Promise<{ sessions: Session[]; eventsBySession: Map<string, RawEvent[]> }> => {
    let selected: Session[];
    if (query.sessions.length > 0) {
      selected = [];
      const missing: string[] = [];
      for (const id of query.sessions) {
        const session = catalogResult.sessions.find((entry) => entry.id === id);
        if (session === undefined) missing.push(id);
        else selected.push(session);
      }
      if (missing.length > 0) {
        throw new ApiError(
          "AGGREGATE_UNKNOWN_SESSIONS",
          `Unknown session id(s) in the selection: ${missing.join(", ")}`,
          400,
          `available: ${catalogResult.sessions.map((entry) => entry.id).join(", ")}`,
        );
      }
    } else {
      selected = filterSessions(catalogResult.sessions, {
        fromMs: query.fromMs,
        toMs: query.toMs,
        limit: MAX_AGGREGATE_SESSIONS,
      });
    }

    // Events ride each session's own producing provider run (files win by
    // identity, §6.1) — never double-counted across sources.
    const eventsBySession = new Map<string, RawEvent[]>();
    for (const session of selected) {
      const producingRun = catalogResult.runs.find((run) => run.id === session.origin);
      eventsBySession.set(
        session.id,
        (producingRun?.result?.events ?? []).filter((event) => event.tags.session === session.id),
      );
    }
    return { sessions: selected, eventsBySession };
  };

  const runAggregate = async (rawQuery: Record<string, unknown>): Promise<{
    selection: AggregateSelectionDto;
    result: AggregateResult;
  }> => {
    const catalogResult = await catalogGuard(catalog());
    const query = parseAggregateQuery(rawQuery);
    const selection = await resolveAggregateSelection(catalogResult, query);
    let result: AggregateResult;
    try {
      result = await buildAggregate({
        sessions: selection.sessions,
        eventsBySession: selection.eventsBySession,
        loadSnapshot: snapshotLoader,
        mode: query.mode,
        groundTruth: query.groundTruth,
      });
    } catch (error) {
      // A bad group pick is the caller's fault: honest 400, not a 500.
      if (error instanceof AggregateGroupError) {
        throw new ApiError(error.code, error.message, 400);
      }
      throw error;
    }
    return {
      selection: {
        mode: query.mode,
        group: query.group,
        sessions: selection.sessions.map(toSessionDto),
        fromMs: query.fromMs ?? null,
        toMs: query.toMs ?? null,
        status: catalogResult.status,
      },
      result,
    };
  };

  app.get("/api/aggregate", { logLevel: "error" }, async (request) =>
    toAggregateResponseDto(await runAggregate(request.query as Record<string, unknown>)),
  );

  app.get("/api/aggregate/export.csv", { logLevel: "error" }, async (request, reply) => {
    const { result } = await runAggregate(request.query as Record<string, unknown>);
    reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="aggregate-mode-${result.mode}.csv"`)
      .send(aggregateToCsv(result));
  });


  registerErrorHandlers(app, { spaIndexFile });
  return app;
}

/** Central unexpected-error mapping: uniform body, source-level detail kept. */
async function catalogGuard(promise: Promise<SessionCatalog>): Promise<SessionCatalog> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "SOURCE_FAILURE",
      `Failed to read telemetry sources: ${error instanceof Error ? error.message : String(error)}`,
      503,
    );
  }
}

function runsAllUnavailable(catalog: SessionCatalog): boolean {
  return catalog.runs.every((run) => !run.status.available);
}

function sourceSummaries(catalog: SessionCatalog): string {
  return catalog.runs.map((run) => `${run.id}: ${run.status.state}${run.error ? ` (${run.error.message})` : ""}`).join("; ");
}

function summarizeRun(catalogRun: ProviderRun): Record<string, unknown> {
  return {
    id: catalogRun.id,
    state: catalogRun.status.state,
    available: catalogRun.status.available,
    message: catalogRun.status.message,
    error: catalogRun.error ? { code: catalogRun.error.code, message: catalogRun.error.message } : undefined,
    facts: catalogRun.status.facts,
  };
}

function defaultProviders(config: ToolConfig): () => SourceProvider[] {
  return () => {
    const list: SourceProvider[] = [new LpFileListSource({ root: config.lpRoot })];
    // Influx last: files win for shared session ids (§6.1).
    list.push(
      new FluxInfluxSource({
        url: config.influx.url,
        org: config.influx.org,
        bucket: config.influx.bucket,
        token: config.influx.token,
        timeoutMs: config.influx.timeoutMs,
      }),
    );
    return list;
  };
}

/**
 * Serve the built web client. Returns the `index.html` content (for SPA
 * fallback in the not-found handler) or null when the client is not built.
 */
async function resolveSpaIndex(app: FastifyInstance, config: ToolConfig): Promise<string | null> {
  const webDist = config.webDist;
  if (webDist === null) return null;
  let indexFile: string | null = null;
  try {
    indexFile = await fs.readFile(path.join(webDist, "index.html"), "utf8");
  } catch {
    return null;
  }
  await app.register(fastifyStatic, { root: path.resolve(webDist), wildcard: false, index: false });
  app.get("/", { logLevel: "error" }, (_request, reply: FastifyReply) => reply.type("text/html").send(indexFile));
  return indexFile;
}

interface SessionDto {
  id: string;
  origin: string;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  eventCount: number;
  snapshotCount: number;
  owner: string | null;
  platform: string | null;
  screen: string | null;
  views: Array<{
    view: string;
    viewId: string | null;
    openMs: number | null;
    closeMs: number | null;
    dwellSeconds: number | null;
  }>;
  eventCountsByType: Record<string, number>;
  openViewCount: number;
}

export function toSessionDto(session: Session): SessionDto {
  return {
    id: session.id,
    origin: session.origin,
    startMs: nsToMs(session.startNs ?? session.firstEventNs),
    endMs: nsToMs(session.endNs ?? session.lastEventNs),
    durationMs: nsToMs(session.durationNs),
    eventCount: session.eventCount,
    snapshotCount: session.snapshotCount,
    owner: session.owner,
    platform: session.platform,
    screen: session.screen,
    views: session.views.map((span) => ({
      view: span.view,
      viewId: span.viewId,
      openMs: nsToMs(span.openNs),
      closeMs: nsToMs(span.closeNs),
      dwellSeconds: span.dwellSeconds,
    })),
    eventCountsByType: session.eventCountsByType,
    openViewCount: session.openViewCount,
  };
}

export function toSessionDtoIncludeSnapshots(session: Session): SessionDto & {
  snapshots: Array<{
    timestampMs: number | null;
    view: string | null;
    viewId: string | null;
    key: string | null;
    hash: string | null;
    nodes: number | null;
    width: number | null;
    height: number | null;
  }>;
} {
  return {
    ...toSessionDto(session),
    snapshots: session.snapshots.map((snapshot) => ({
      timestampMs: nsToMs(snapshot.timestampNs),
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

export interface TimelineEventDto {
  index: number;
  ns: string;
  ms: number;
  type: string;
  lane: string;
  view: string | null;
  viewId: string | null;
  element: string | null;
  elementType: string | null;
  on: boolean | null;
  dwellSeconds: number | null;
  value: number | null;
  snapshotIndex: number | null;
  unresolved: boolean;
}

export interface TimelineDto {
  session: SessionDto;
  status: "ok" | "degraded" | "unavailable";
  startNs: string;
  endNs: string;
  startMs: number;
  endMs: number;
  eventCount: number;
  unresolvedCount: number;
  lanes: Array<{ lane: string; label: string; count: number }>;
  events: TimelineEventDto[];
  viewSpans: Array<{
    index: number;
    view: string;
    viewId: string | null;
    openNs: string;
    openMs: number;
    closeNs: string | null;
    closeMs: number | null;
    dwellSeconds: number | null;
    stillOpen: boolean;
  }>;
  snapshots: Array<{
    index: number;
    ns: string;
    ms: number;
    view: string | null;
    viewId: string | null;
    key: string | null;
    hash: string | null;
    nodes: number | null;
    width: number | null;
    height: number | null;
  }>;
}

export function toTimelineDto(_catalogResult: SessionCatalog, frame: TimelineFrame, session: Session): TimelineDto {
  const catalogStatus = _catalogResult.status;
  return {
    session: toSessionDto(session),
    status: catalogStatus,
    startNs: frame.startNs,
    endNs: frame.endNs,
    startMs: frame.startMs,
    endMs: frame.endMs,
    eventCount: frame.eventCount,
    unresolvedCount: frame.unresolvedCount,
    lanes: frame.lanes,
    events: frame.events,
    viewSpans: frame.viewSpans,
    snapshots: frame.snapshots,
  };
}

/* ------------------------------------------------------------------ aggregate */

export interface AggregateSelectionDto {
  mode: "a" | "b" | "c";
  /** The mode-C pick, echoed raw (`<viewKey>#<versionIndex>`). */
  group: string | null;
  sessions: SessionDto[];
  fromMs: number | null;
  toMs: number | null;
  status: "ok" | "degraded" | "unavailable";
}

export interface AggregateCountDto {
  key: string;
  count: number;
  elementType: string | null;
  leafLabel: string;
  confidence: "exact" | "approximate";
  templateNodeId: string | null;
  dimensions: { width: number | null; height: number | null } | null;
}

export interface AggregateVersionGroupDto {
  /** Chronological ordinal within the viewKey. */
  index: number;
  /** `<viewKey>#<index>` — the mode-C `group=` param. */
  groupId: string;
  viewKey: string;
  fingerprint: string;
  snapshotCount: number;
  keys: string[];
  keyCount: number;
  counts: AggregateCountDto[];
  /** Own event count of this version (own template + own counts, §7 B). */
  eventCount: number;
  /** ⊕ new keys vs the earliest version. */
  addedKeys: string[];
  /** ⊖ keys missing vs the earliest version. */
  removedKeys: string[];
  template: {
    hash: string | null;
    storageKey: string | null;
    viewId: string | null;
  } | null;
}

export interface AggregateMergeDto {
  groupId: string;
  viewKey: string;
  groundTruthIndex: number;
  fingerprint: string;
  rows: Array<
    AggregateCountDto & {
      ownCount: number;
      folded: Array<{ key: string; versionIndex: number; count: number; matched: number; wildcards: number }>;
    }
  >;
  unmatched: Array<{
    key: string;
    versionIndex: number;
    count: number;
    leafLabel: string;
    elementType: string | null;
  }>;
  foldedEvents: number;
  unmatchedEvents: number;
}

export interface AggregateViewDto {
  viewKey: string;
  divergent: boolean;
  versionCount: number;
  intersectionKeyCount: number;
  hiddenKeyCount: number;
  hiddenEventCount: number;
  counts: AggregateCountDto[];
  template: {
    hash: string | null;
    storageKey: string | null;
    viewId: string | null;
    /** Client-ready parsed snapshot (snapshot-render consumes it directly). */
    parsed: ParsedSnapshot;
  } | null;
  /** Modes B/C only: per-version groups of a divergent viewKey. */
  versions: AggregateVersionGroupDto[] | null;
  /** Mode C only: the ground-truth merge of the picked viewKey. */
  merge: AggregateMergeDto | null;
}

export interface AggregateResponseDto {
  selection: AggregateSelectionDto;
  totals: AggregateResult["totals"];
  views: AggregateViewDto[];
  unresolved: AggregateResult["unresolved"];
  warnings: string[];
}

export function toAggregateResponseDto(payload: {
  selection: AggregateSelectionDto;
  result: AggregateResult;
}): AggregateResponseDto {
  const { selection, result } = payload;
  return {
    selection,
    totals: result.totals,
    views: result.views.map((view) => ({
      viewKey: view.viewKey,
      divergent: view.divergent,
      versionCount: view.versionCount,
      intersectionKeyCount: view.intersectionKeyCount,
      hiddenKeyCount: view.hiddenKeyCount,
      hiddenEventCount: view.hiddenEventCount,
      counts: view.counts,
      template:
        view.template === null
          ? null
          : {
              hash: view.template.hash,
              storageKey: view.template.storageKey,
              viewId: view.template.viewId,
              parsed: view.template.parsed,
            },
      versions: view.versions,
      merge: view.merge,
    })),
    unresolved: result.unresolved,
    warnings: result.warnings,
  };
}
