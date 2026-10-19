/**
 * Runtime source configuration (P6): the mutable layer between env config
 * and the provider factory. The tool can switch InfluxDB ⇄ directory-only
 * mode, override the `.lp` root / snapshot root, and activate an imported
 * `.lp` files universe — all **without a process restart**.
 *
 * Layering rules (also enforced by `GET /api/sources/config`):
 * - Effective root = runtime override ?? env default (`LP_ROOT`/`SNAPSHOT_ROOT`).
 * - Imported files active → they alone define the session universe (plan
 *   §3.10): directory scan + InfluxDB are bypassed entirely, never merged.
 * - InfluxDB off → directory-only mode; `lp-files` unconfigured stays honest
 *   (an empty universe is reported, not hidden).
 * - Injected providers (`buildApp({ providers })`, used by tests) pin the
 *   factory: switching/imports leave the injected list untouched and the
 *   config routes answer 409 `PROVIDERS_PINNED` instead of lying about effect.
 */
import type { ToolConfig } from "../config.js";
import type { SourceProvider } from "../domain.js";
import { FluxInfluxSource } from "./influx.js";
import { LpFileListSource } from "./lpFiles.js";
import { ImportedLpFilesSource } from "./importedFiles.js";

export interface EffectiveRoot {
  /** Value from the environment (may be null). */
  env: string | null;
  /** Runtime override set through PATCH (never set = env applies). */
  override: string | null | undefined;
  /** `override ?? env`. */
  root: string | null;
}

export interface ImportedUniverseInfo {
  mode: "all" | "imported";
  files: Array<{ name: string; bytes: number }>;
  events: number;
  sessions: string[];
  malformedLines: number;
}

export interface RuntimeSourcesConfig {
  pinned: boolean;
  influx: { enabled: boolean; url: string; org: string; bucket: string };
  lpRoot: EffectiveRoot;
  snapshotRoot: EffectiveRoot;
  universe: ImportedUniverseInfo;
}

export class SourceRuntime {
  private importSource: ImportedLpFilesSource | null = null;
  private influxEnabled = true;

  constructor(
    private readonly base: ToolConfig,
    private readonly pinnedFlag: boolean,
  ) {}

  get influxActive(): boolean {
    return this.influxEnabled;
  }

  get importedFilesSource(): ImportedLpFilesSource | null {
    return this.importSource;
  }

  get importedUniverse(): boolean {
    return this.importSource !== null;
  }

  get pinned(): boolean {
    return this.pinnedFlag;
  }

  get effectiveLpRoot(): string | null {
    return this.lpRoot.root;
  }

  /**
   * Provider list for the *current* runtime state. Fresh instances per call
   * (cheap) keep `.lp` scans and Influx health honest on every catalog build.
   */
  providers(): SourceProvider[] {
    if (this.importSource !== null) return [this.importSource];
    const list: SourceProvider[] = [];
    if (this.lpRoot.root !== null) {
      list.push(new LpFileListSource({ root: this.lpRoot.root }));
    }
    // Influx last: files win for shared session ids (§6.1).
    if (this.influxEnabled) {
      list.push(
        new FluxInfluxSource({
          url: this.base.influx.url,
          org: this.base.influx.org,
          bucket: this.base.influx.bucket,
          token: this.base.influx.token,
          timeoutMs: this.base.influx.timeoutMs,
        }),
      );
    }
    return list;
  }

  setInfluxEnabled(enabled: boolean): void {
    if (this.pinnedFlag) {
      throw new PinnedProvidersError("PATCH influxEnabled");
    }
    this.influxEnabled = enabled;
  }

  setLpRoot(root: string): void {
    if (this.pinnedFlag) {
      throw new PinnedProvidersError("PATCH lpRoot");
    }
    this.overrides.lpRoot = root;
  }

  /** Clears the runtime override — the `LP_ROOT` env default applies again. */
  clearLpRoot(): void {
    if (this.pinnedFlag) {
      throw new PinnedProvidersError("PATCH lpRoot");
    }
    delete this.overrides.lpRoot;
  }

  /** Imported universe: non-null activates, null clears back to all sources. */
  setImported(source: ImportedLpFilesSource | null): void {
    if (this.pinnedFlag) {
      throw new PinnedProvidersError(source === null ? "DELETE imported" : "PUT imported");
    }
    this.importSource = source;
  }

  /** Full JSON description for `GET /api/sources/config` (no secrets). */
  toConfig(): RuntimeSourcesConfig {
    const imported: ImportedUniverseInfo =
      this.importSource === null
        ? { mode: "all", files: [], events: 0, sessions: [], malformedLines: 0 }
        : {
            mode: "imported",
            files: this.importSource.files,
            events: this.importSource.eventCount,
            sessions: this.importSource.sessions,
            malformedLines: this.importSource.malformedCount,
          };
    return {
      pinned: this.pinnedFlag,
      influx: {
        enabled: this.influxEnabled,
        url: this.base.influx.url,
        org: this.base.influx.org,
        bucket: this.base.influx.bucket,
      },
      lpRoot: { env: this.base.lpRoot, override: this.overrides.lpRoot, root: this.lpRoot.root },
      snapshotRoot: {
        env: this.base.snapshotRoot,
        override: this.overrides.snapshotRoot,
        root: this.snapshotRoot.root,
      },
      universe: imported,
    };
  }

  /* Roots are computed properties so overrides can be changed freely. */

  private readonly overrides: { lpRoot?: string | null; snapshotRoot?: string | null } = {};

  private get lpRoot(): EffectiveRoot {
    return effectiveRoot(this.overrides.lpRoot, this.base.lpRoot);
  }

  get snapshotRoot(): EffectiveRoot {
    return effectiveRoot(this.overrides.snapshotRoot, this.base.snapshotRoot);
  }

  setSnapshotRoot(root: string): void {
    this.overrides.snapshotRoot = root;
  }

  clearSnapshotRoot(): void {
    delete this.overrides.snapshotRoot;
  }
}

function effectiveRoot(override: string | null | undefined, env: string | null): EffectiveRoot {
  return {
    env,
    override: override === undefined ? undefined : override,
    root: override !== undefined ? override : env,
  };
}

export class PinnedProvidersError extends Error {
  constructor(operation: string) {
    super(`${operation} cannot take effect: providers were injected programmatically (PROVIDERS_PINNED).`);
    this.name = "PinnedProvidersError";
  }
}
