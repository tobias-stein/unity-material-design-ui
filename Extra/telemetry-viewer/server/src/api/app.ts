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
import type { Session, SourceProvider } from "../domain.js";
import { buildSessionCatalog, filterSessions, type ProviderRun, type SessionCatalog } from "../core/sessionCatalog.js";
import { FluxInfluxSource } from "../sources/influx.js";
import { LpFileListSource } from "../sources/lpFiles.js";
import { LocalFsSnapshotStore } from "../storage/snapshotStore.js";
import { registerErrorHandlers, ApiError, errorBody } from "./errorHandling.js";
import { nsToMs, parseRangeQuery } from "./queryParams.js";

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
