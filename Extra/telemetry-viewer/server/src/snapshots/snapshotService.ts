/**
 * Snapshot artifact resolution + parse caching (P2 plan §8: the playhead's
 * replica needs the parsed snapshot near the scrub position).
 *
 * - Resolution goes through the {@link SnapshotStore} (hash first, key hint
 *   second) — files stay files; the tool never modifies them.
 * - Parsed documents are cached by content hash (the join key): replaying a
 *   session back and forth never re-parses YAML.
 * - The cache is a small bounded LRU so month-long tool sessions can't leak.
 */
import type { SnapshotStore } from "../storage/snapshotStore.js";
import { parseSnapshotBytes, type ParsedSnapshot, SnapshotParseError } from "./parse.js";

export interface ResolvedParsedSnapshot {
  snapshotId: string;
  key: string | null;
  hash: string | null;
  parsed: ParsedSnapshot;
}

export class SnapshotResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 404 | 409 | 503,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SnapshotResolutionError";
  }
}

const DEFAULT_CACHE_ENTRIES = 24;

export class SnapshotService {
  private readonly cache: Map<string, ParsedSnapshot> = new Map();

  constructor(
    private readonly store: SnapshotStore,
    private readonly cacheEntries: number = DEFAULT_CACHE_ENTRIES,
  ) {}

  /**
   * Resolve + parse a ledger entry. `buffer` allows clients to pass opacity;
   * deterministic failures carry codes the REST layer maps verbatim.
   */
  async resolve(ledger: {
    key: string | null;
    hash: string | null;
  }): Promise<ResolvedParsedSnapshot> {
    const hash = ledger.hash;
    if (hash !== null && hash !== "") {
      const cached = this.cache.get(hash);
      if (cached !== undefined) {
        return { snapshotId: hash, key: ledger.key, hash, parsed: cached };
      }
    }

    if (this.store.root === null) {
      throw new SnapshotResolutionError(
        "SNAPSHOT_STORE_UNCONFIGURED",
        "Snapshot storage root is not configured (set SNAPSHOT_ROOT).",
        503,
      );
    }

    const key = ledger.key ?? "";
    const resolved = await this.store.resolve(key, hash);
    if (resolved === null) {
      // Ledger recorded the artifact but the collection holds no such bytes —
      // distinguish "store unreadable" from "artifact genuinely missing".
      const probe = await this.store.probe();
      if (probe.state === "unreachable" || probe.state === "not-a-directory" || probe.state === "unconfigured") {
        throw new SnapshotResolutionError(
          "SNAPSHOT_STORE_UNREACHABLE",
          `Snapshot storage root is ${probe.state}${probe.message ? `: ${probe.message}` : "."}`,
          503,
        );
      }
      throw new SnapshotResolutionError(
        "SNAPSHOT_ARTIFACT_MISSING",
        `No snapshot file with ${hash !== null ? `hash ${hash}` : `key ${key}`} in the snapshot store.`,
        404,
        `ledger key: ${key || "(none)"}`,
      );
    }

    let parsed: ParsedSnapshot;
    try {
      parsed = parseSnapshotBytes(new Uint8Array(resolved.bytes));
    } catch (error) {
      if (error instanceof SnapshotParseError) {
        throw new SnapshotResolutionError(error.code, error.message, 409, `sha256: ${resolved.sha256}`);
      }
      throw new SnapshotResolutionError(
        "SNAPSHOT_PARSE_FAILED",
        error instanceof Error ? error.message : String(error),
        409,
        `sha256: ${resolved.sha256}`,
      );
    }

    if (resolved.sha256 !== null && this.cacheEntries > 0) {
      // Insert at the end; evict the least-recently-used entry beyond the cap.
      this.cache.delete(resolved.sha256);
      this.cache.set(resolved.sha256, parsed);
      while (this.cache.size > this.cacheEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }

    return { snapshotId: resolved.sha256 ?? key, key, hash: resolved.sha256, parsed };
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}
