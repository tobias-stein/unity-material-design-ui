/**
 * `.lp` file source — reads the session files the runtime already writes
 * (`session-<id>.lp`, `pending-*.lp` outbox files) from a local directory.
 *
 * Runs strictly read-only and produces event streams byte-comparable with the
 * InfluxDB source (parity-tested against the P0 fixtures).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FetchOptions, RawEvent, RawEventResult, SourceProvider, SourceStatus } from "../domain.js";
import { parseLpDocuments } from "./lp.js";

export interface LpFilesSourceOptions {
  /** Absolute or workspace-relative directory auto-scanned for `*.lp` files. */
  root: string | null;
  /** Injectable for tests (defaults to node:fs). */
  readdir?: (dir: string) => Promise<DirEntry[]>;
  readFile?: (file: string) => Promise<string>;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

/** Walk `root`, returning every `*.lp` file sorted by path (stable ingestion order). */
export async function listLpFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".lp")) {
        files.push(full);
      }
    }
  };
  await walk(root);
  files.sort();
  return files;
}

export class LpFileListSource implements SourceProvider {
  readonly id = "lp-files" as const;

  constructor(private readonly options: LpFilesSourceOptions) {}

  get root(): string | null {
    return this.options.root;
  }

  async describe(): Promise<SourceStatus> {
    if (!this.root) {
      return {
        id: this.id,
        available: false,
        state: "unconfigured",
        facts: { root: null, fileCount: null, malformedRows: null },
      };
    }
    try {
      const files = await listLpFiles(this.root);
      return {
        id: this.id,
        available: true,
        state: "ok",
        facts: { root: this.root, fileCount: files.length, malformedRows: null },
      };
    } catch (error) {
      return {
        id: this.id,
        available: false,
        state: "unavailable",
        message: error instanceof Error ? error.message : String(error),
        facts: { root: this.root, fileCount: null, malformedRows: null },
      };
    }
  }

  async loadEvents(): Promise<RawEventResult> {
    if (!this.root) {
      return {
        events: [],
        malformedCount: 0,
        error: {
          code: "LP_NOT_CONFIGURED",
          message: "No .lp file directory configured (set LP_ROOT).",
          httpStatus: 400,
        },
      };
    }
    try {
      const files = await listLpFiles(this.root);
      const documents: Array<{ file: string; content: string }> = [];
      for (const file of files) {
        documents.push({ file: path.relative(this.root, file), content: await fs.readFile(file, "utf8") });
      }
      return parseLpDocuments(documents);
    } catch (error) {
      return {
        events: [],
        malformedCount: 0,
        error: {
          code: "LP_ROOT_UNREADABLE",
          message: `Cannot read .lp directory ${this.root}: ${error instanceof Error ? error.message : String(error)}`,
          httpStatus: 503,
        },
      };
    }
  }

  async fetchEvents(_options?: FetchOptions): Promise<RawEventResult> {
    // Directory auto-scan: every file, every session (~dev corpora scale).
    return this.loadEvents();
  }
}
