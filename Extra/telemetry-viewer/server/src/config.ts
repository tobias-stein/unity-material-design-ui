/**
 * Server configuration from environment variables. Everything is optional —
 * the tool degrades gracefully (`GET /api/sources` reports what is missing).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ToolConfig {
  influx: {
    url: string;
    org: string;
    bucket: string;
    token: string;
    timeoutMs: number;
  };
  /** Optional `.lp` directory auto-scan (file source). */
  lpRoot: string | null;
  /** Local snapshot storage root (kept for later phases; surfaces in /sources). */
  snapshotRoot: string | null;
  /** TTL cache for `/api/aggregate` responses (0 disables; requests coalesce). */
  aggregateCacheMs: number;
  /** Absolute path of the built web client (served statically). */
  webDist: string | null;
  port: number;
  host: string;
}

/** Server-side only defaults; tokens are never shipped to the web bundle. */
const DEV_DEFAULT_TOKEN = "mdu-local-dev-token-0123456789abcdef";

/** Locates the server package root (`…/server`) regardless of tsx/dist/IDE runs. */
export function resolveServerRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (path.basename(path.resolve(dir, "..")) !== "server") {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Cannot locate server package root.");
    dir = parent;
  }
  return path.dirname(dir);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ToolConfig {
  const webDist = env.WEB_DIST?.trim() || path.join(resolveServerRoot(), "..", "web", "dist");
  return {
    influx: {
      url: (env.INFLUX_URL?.trim() || "http://localhost:8086").replace(/\/+$/, ""),
      org: env.INFLUX_ORG?.trim() || "mdu",
      bucket: env.INFLUX_BUCKET?.trim() || "ui",
      token: env.INFLUX_TOKEN?.trim() || DEV_DEFAULT_TOKEN,
      timeoutMs: positiveInt(env.INFLUX_TIMEOUT_MS) ?? 10_000,
    },
    lpRoot: nullIfEmpty(env.LP_ROOT),
    snapshotRoot: nullIfEmpty(env.SNAPSHOT_ROOT),
    aggregateCacheMs: nonNegativeInt(env.AGGREGATE_CACHE_MS) ?? 15_000,
    webDist,
    port: positiveInt(env.PORT) ?? 8087,
    host: env.HOST?.trim() || "0.0.0.0",
  };
}

function nullIfEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function positiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
