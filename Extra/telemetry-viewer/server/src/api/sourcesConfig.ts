/**
 * Runtime source-configuration routes (P6, plan §11/P6): switch
 * influx ⇄ directory-only mode, override/screen roots, force a re-scan and
 * manage the imported `.lp` files universe — all without a server restart.
 *
 * Uniform error envelope (`{ code, message }`, 4xx/5xx). The Influx token is
 * server config only and is never echoed by any of these endpoints.
 */
import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import { ApiError } from "./errorHandling.js";
import { PinnedProvidersError, SourceRuntime } from "../sources/runtime.js";
import { ImportedLpFilesSource } from "../sources/importedFiles.js";
import { SnapshotService } from "../snapshots/snapshotService.js";

export interface SourceImportLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

export const IMPORT_LIMITS: SourceImportLimits = {
  maxFiles: 200,
  maxTotalBytes: 32 * 1024 * 1024, // 32 MiB of .lp text
};

/** JSON request body of `PATCH /api/sources/config`; unknown keys rejected. */
export interface SourcesConfigPatch {
  influxEnabled?: boolean;
  lpRoot?: string | null;
  snapshotRoot?: string | null;
}

/**
 * Validation + application of a config patch in two strict phases:
 * (1) every field is parsed and validated (roots must exist as directories
 * *today* — a typo silently turning the universe empty would be worse UX
 * than an upfront 400), then (2) valid actions apply **all-or-nothing** —
 * a failed patch never leaves a partially mutated runtime behind.
 */
async function applyPatch(
  runtime: SourceRuntime,
  patch: Record<string, unknown>,
): Promise<{ applied: Array<string>; config: ReturnType<SourceRuntime["toConfig"]> }> {
  for (const key of Object.keys(patch)) {
    if (key !== "influxEnabled" && key !== "lpRoot" && key !== "snapshotRoot") {
      throw new ApiError(
        "INVALID_CONFIG",
        `Unknown field "${key}" (allowed: influxEnabled, lpRoot, snapshotRoot).`,
        400,
      );
    }
  }

  /* Phase 1 — parse + validate, no mutation. */
  if (runtime.pinned && ("influxEnabled" in patch || "lpRoot" in patch)) {
    throw new ApiError(
      "PROVIDERS_PINNED",
      "Providers were injected programmatically — influxEnabled/lpRoot cannot take effect (PUT/DELETE imported are pinned too).",
      409,
    );
  }
  const actions: Array<(runtime: SourceRuntime) => void> = [];
  const applied: Array<string> = [];
  const parseRoot = (
    raw: unknown,
    field: string,
    envVar: string,
  ): ((runtime: SourceRuntime) => void) | null => {
    if (raw === null) {
      return field === "lpRoot" ? (r) => r.clearLpRoot() : (r) => r.clearSnapshotRoot();
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      // Directory existence validated synchronously-in-order below.
      return field === "lpRoot"
        ? (r) => r.setLpRoot(raw.trim())
        : (r) => r.setSnapshotRoot(raw.trim());
    }
    throw new ApiError("INVALID_CONFIG", `\`${field}\` must be a non-empty directory path or null.`, 400);
  };

  const influxEnabled = patch.influxEnabled;
  if (influxEnabled !== undefined) {
    if (typeof influxEnabled !== "boolean") {
      throw new ApiError("INVALID_CONFIG", "`influxEnabled` must be a boolean.", 400);
    }
    actions.push((r) => r.setInfluxEnabled(influxEnabled));
    applied.push("influxEnabled");
  }
  if (patch.lpRoot !== undefined) {
    const path = typeof patch.lpRoot === "string" && patch.lpRoot.trim() !== "" ? patch.lpRoot.trim() : null;
    if (path !== null) await assertDirectory(path, "lpRoot", "LP_ROOT");
    const action = parseRoot(patch.lpRoot, "lpRoot", "LP_ROOT");
    if (action !== null) {
      actions.push(action);
      applied.push("lpRoot");
    }
  }
  if (patch.snapshotRoot !== undefined) {
    const path =
      typeof patch.snapshotRoot === "string" && patch.snapshotRoot.trim() !== ""
        ? patch.snapshotRoot.trim()
        : null;
    if (path !== null) await assertDirectory(path, "snapshotRoot", "SNAPSHOT_ROOT");
    const action = parseRoot(patch.snapshotRoot, "snapshotRoot", "SNAPSHOT_ROOT");
    if (action !== null) {
      actions.push(action);
      applied.push("snapshotRoot");
    }
  }

  /* Phase 2 — apply what validated. */
  for (const action of actions) action(runtime);
  return { applied, config: runtime.toConfig() };
}

async function assertDirectory(candidate: string, field: string, envVar: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(candidate);
  } catch (error) {
    throw new ApiError(
      "INVALID_CONFIG",
      `The ${field} directory does not exist: ${candidate}`,
      400,
      `${envVar}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new ApiError("INVALID_CONFIG", `The ${field} path is not a directory: ${candidate}`, 400, envVar);
  }
}

export interface SourceRoutesOptions {
  runtime: SourceRuntime;
  snapshotService: SnapshotService;
  /** Forces the next request to rebuild the session catalog (+ LRU clearing). */
  invalidateCaches: () => void;
  /** Fresh `GET /api/sources` payload (after the invalidation). */
  describeSources: () => Promise<unknown>;
  /** Rebuilds the snapshot store from the runtime's current root. */
  onSnapshotRootChange: () => void;
}

export function registerSourceRoutes(
  app: FastifyInstance,
  options: SourceRoutesOptions,
): void {
  const { runtime, snapshotService, invalidateCaches, describeSources, onSnapshotRootChange } = options;

  /** Programmatic providers (tests/scan harness) can't be switched at runtime. */
  function pinnedOrThrow(error: unknown): never {
    if (error instanceof PinnedProvidersError) {
      throw new ApiError("PROVIDERS_PINNED", error.message, 409);
    }
    throw error as Error;
  }

  app.get("/api/sources/config", { logLevel: "error" }, () => runtime.toConfig());

  app.patch("/api/sources/config", { logLevel: "error" }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ApiError("INVALID_CONFIG", "Body must be a JSON object.", 400);
    }
    let applied: Array<string>;
    let config: ReturnType<SourceRuntime["toConfig"]>;
    try {
      ({ applied, config } = await applyPatch(runtime, body));
    } catch (error) {
      pinnedOrThrow(error);
    }
    if (applied.includes("snapshotRoot")) {
      // Root may have changed — a fresh store picks it up; content-addressed
      // LRU stays valid, but we clear it to keep the honest-failure semantics.
      onSnapshotRootChange();
      invalidateCaches();
    }
    if (applied.includes("influxEnabled") || applied.includes("lpRoot")) {
      invalidateCaches();
    }
    return { applied, config };
  });

  app.post("/api/sources/rescan", { logLevel: "error" }, async () => {
    if (runtime.importedUniverse) {
      throw new ApiError(
        "UNIVERSE_READ_ONLY",
        "An imported .lp universe is active — imported files are immutable; clear the import first.",
        409,
      );
    }
    snapshotService.clearCache();
    invalidateCaches();
    return { rescan: "ok", sources: await describeSources() };
  });

  app.put<{
    Body: { files?: Array<{ name?: unknown; content?: unknown }> };
  }>("/api/sources/imported", { logLevel: "error", bodyLimit: IMPORT_LIMITS.maxTotalBytes * 2 + (1 << 20) }, async (request) => {
    try {
      return await putImported(request.body?.files);
    } catch (error) {
      pinnedOrThrow(error);
    }
  });

  async function putImported(files: unknown): Promise<unknown> {
    if (!Array.isArray(files) || files.length === 0) {
      throw new ApiError("IMPORT_EMPTY", "Body must be `{ files: [{ name, content }] }` with at least one file.", 400);
    }
    if (files.length > IMPORT_LIMITS.maxFiles) {
      throw new ApiError(
        "IMPORT_TOO_MANY",
        `At most ${IMPORT_LIMITS.maxFiles} files per import (got ${files.length}).`,
        400,
      );
    }
    let totalBytes = 0;
    const documents: Array<{ name: string; content: string }> = [];
    for (const [index, file] of files.entries()) {
      const { name, content } = file as { name?: unknown; content?: unknown };
      if (typeof name !== "string" || name.trim() === "" || name.includes("/") || name.includes("\\")) {
        throw new ApiError(
          "IMPORT_INVALID_FILE",
          `files[${index}]: "name" must be a display name without path separators.`,
          400,
        );
      }
      if (!name.toLowerCase().endsWith(".lp")) {
        throw new ApiError(
          "IMPORT_INVALID_FILE",
          `files[${index}]: only .lp line-protocol files can be imported (got "${name}").`,
          400,
        );
      }
      if (typeof content !== "string" || content.trim() === "") {
        throw new ApiError("IMPORT_INVALID_FILE", `files[${index}]: "content" must be the non-empty .lp text.`, 400);
      }
      totalBytes += Buffer.byteLength(content, "utf8");
      documents.push({ name, content });
    }
    if (totalBytes === 0) {
      throw new ApiError("IMPORT_EMPTY", "All imported files are empty.", 400);
    }
    if (totalBytes > IMPORT_LIMITS.maxTotalBytes) {
      throw new ApiError(
        "IMPORT_TOO_LARGE",
        `Import exceeds the ${MiB(IMPORT_LIMITS.maxTotalBytes)} MiB cap (got ${MiB(totalBytes)} MiB).`,
        413,
      );
    }
    // Parsing doubles as validation: an unusable import is rejected upfront
    // instead of activating a broken universe.
    let source: ImportedLpFilesSource;
    try {
      source = new ImportedLpFilesSource(documents);
    } catch (error) {
      throw new ApiError(
        "IMPORT_PARSE_FAILED",
        `Imported .lp content failed to parse: ${error instanceof Error ? error.message : String(error)}`,
        400,
      );
    }
    runtime.setImported(source);
    snapshotService.clearCache();
    invalidateCaches();
    return {
      universe: "imported",
      files: source.files,
      events: source.eventCount,
      malformedLines: source.malformedCount,
      sessions: source.sessions,
      config: runtime.toConfig(),
    };
  }

  app.delete("/api/sources/imported", { logLevel: "error" }, async () => {
    try {
      const hadUniverse = runtime.importedUniverse;
      runtime.setImported(null);
      snapshotService.clearCache();
      invalidateCaches();
      return { universe: "all", cleared: hadUniverse, config: runtime.toConfig() };
    } catch (error) {
      pinnedOrThrow(error);
    }
  });
}

function MiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
