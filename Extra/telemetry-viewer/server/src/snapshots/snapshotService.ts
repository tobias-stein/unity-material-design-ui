/**
 * Snapshot artifact resolution + parse caching (P2 plan §8: the playhead's
 * replica needs the parsed snapshot near the scrub position).
 *
 * - Resolution goes through the {@link SnapshotStore} (hash first, key hint
 *   second) — files stay files; the tool never modifies them.
 * - Parsed documents are cached by content hash (the join key): replaying a
 *   session back and forth never re-parses YAML.
 * - The cache is a small bounded LRU so month-long tool sessions can't leak.
 *
 * Format-migration additions (ADR-0007/0008/0009), both resolved here so
 * `parse.ts` stays single-artifact:
 * - delta chain members materialize into the whole tree their runtime capture
 *   produced — `snapshotChain.ts` walks the `bases` segment through the store
 *   alone; a broken chain (pruned member) surfaces as a coded error, never a
 *   silently wrong replica.
 * - theme manifest refs (hash → `theme-manifest-<sessionId>.mds`) resolve
 *   through a per-session manifest cache; unresolvable refs degrade with a
 *   warning, the acknowledged ADR-0007 pruning consequence.
 */
import type { SnapshotStore } from "../storage/snapshotStore.js";
import { sha256Of } from "../storage/snapshotStore.js";
import {
  decodeSnapshotBytes,
  decodeMdsBytes,
  finalizeSnapshot,
  hasMdsMagic,
  parseSnapshotText,
  SnapshotParseError,
  type MdsSnapshotDoc,
  type MdsThemeManifest,
  type ParsedSnapshot,
} from "./parse.js";
import { ChainBrokenError, materializeChain } from "./snapshotChain.js";

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
  /** Decoded chain members by file hash — deltas recur across later members' replays. */
  private readonly docCache: Map<string, MdsSnapshotDoc> = new Map();
  /**
   * Session id → decoded manifest *with the bytes it was decoded from*. The
   * runtime rewrites this file mid-session (every distinct theme hash appends),
   * so a decoded-once cache would serve a stale, entry-poor manifest for the
   * rest of the process lifetime — exactly the "already known, got more entries
   * later" failure observed repeatedly. So: re-read the tiny (~2.5 KB) manifest
   * every lookup, keep only the *decode* cached, and refresh it whenever the
   * bytes' hash differs (the manifest file's replace-write makes change →
   * different sha256, byte-identical → sha equal → zero re-decode).
   */
  private readonly manifestCache: Map<string, { bytesSha256: string; manifest: MdsThemeManifest }> = new Map();

  constructor(
    private store: SnapshotStore,
    private readonly cacheEntries: number = DEFAULT_CACHE_ENTRIES,
  ) {}

  /** Runtime root reconfiguration (P6): the store instance may be swapped. */
  setStore(store: SnapshotStore): void {
    this.store = store;
    // All caches are rooted in the same store volume — a fresh root must not
    // serve a stale unconfigured/unreachable state; clearing is cheap and honest.
    this.clearCache();
  }

  clearCache(): void {
    this.cache.clear();
    this.docCache.clear();
    this.manifestCache.clear();
  }

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
    const bytes = new Uint8Array(resolved.bytes);
    if (hasMdsMagic(bytes)) {
      // MDS v3 (ADR-0008): header is the version authority; delta chains and
      // theme manifest refs resolve in the service paths below.
      let doc: MdsSnapshotDoc;
      try {
        doc = decodeMdsBytes(bytes) as MdsSnapshotDoc;
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
      if (resolved.sha256 !== null) {
        this.docCache.set(resolved.sha256, doc);
        this.boundCache(this.docCache);
      }
      parsed = await this.parsedFromMds(doc);
    } else {
      try {
        parsed = parseSnapshotText(decodeSnapshotBytes(bytes));
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
    }

    if (resolved.sha256 !== null && this.cacheEntries > 0) {
      // Insert at the end; evict the least-recently-used entry beyond the cap.
      // Manifest-ref-degraded parses are NOT cached (ADR-0007): a snapshot hash
      // stays valid forever while the *session manifest* the theme resolves
      // through gets rewritten mid-session (theme switch appends entries).
      // Caching the degraded parse would pin its warning for the process
      // lifetime; re-parsing until the manifest catches up is cheap (≤ a few
      // bytes/decodes of a 2.5 KB manifest) and self-healing.
      const manifestDegrade = parsed.warnings.some((w) => w.includes("theme manifest"));
      this.cache.delete(resolved.sha256);
      if (!manifestDegrade) {
        this.cache.set(resolved.sha256, parsed);
      }
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

  /** ------------------------------------------------------------------ *
   *  ADR-0007/0009 — MDS service paths (deltas + manifest theme refs).
   *  ---------------------------------------------------------------- */
  private async parsedFromMds(doc: MdsSnapshotDoc): Promise<ParsedSnapshot> {
    const warnings: string[] = [];

    let nodes = doc.nodes ?? [];
    if (doc.contentMode === "delta" || doc.delta != null) {
      // ADR-0009: the file's `bases` segment names every ancestor; the store
      // alone resolves the chain (no ledger dependency).
      try {
        nodes = await materializeChain(doc, (memberHash) => this.memberDoc(memberHash));
      } catch (error) {
        if (error instanceof ChainBrokenError) {
          throw new SnapshotResolutionError(error.code, error.message, 409, `baseHash: ${doc.delta?.baseHash ?? "?"}`);
        }
        if (error instanceof SnapshotParseError) {
          throw new SnapshotResolutionError(error.code, error.message, 409);
        }
        throw error;
      }
    }

    let theme = doc.theme;
    if (theme === null && doc.themeRef !== null) {
      // ADR-0007: hash → session manifest → theme. Unresolvable is the
      // acknowledged pruning consequence: a warning, not a wrong replica.
      theme = await this.themeFromManifest(doc, warnings);
      if (theme === null) {
        warnings.push(
          `theme manifest ref ${doc.themeRef} unresolved — session manifest missing or pruned; rendering degrades`,
        );
      }
    }

    if (nodes.length === 0) {
      throw new SnapshotResolutionError(
        "SNAPSHOT_EMPTY",
        "Snapshot contains no nodes.",
        409,
        `contentMode: ${doc.contentMode}`,
      );
    }

    return finalizeSnapshot(
      {
        schemaVersion: doc.schemaVersion,
        timestampUtc: doc.timestampUtc,
        app: doc.app,
        view: doc.view,
        theme: theme ?? undefined,
        themeRef: doc.themeRef,
        source: doc.source,
        nodes,
      },
      warnings,
      { supportedSchemaVersion: 3 },
    );
  }

  /** One chain member (ancestor) by file hash — decoded and cached. */
  private async memberDoc(hash: string): Promise<MdsSnapshotDoc | null> {
    const cached = this.docCache.get(hash);
    if (cached !== undefined) return cached;

    const resolved = await this.store.resolve("", hash);
    if (resolved === null) {
      const probe = await this.store.probe();
      if (probe.state === "unreachable" || probe.state === "not-a-directory" || probe.state === "unconfigured") {
        throw new ChainBrokenError(
          "SNAPSHOT_CHAIN_MEMBER_MISSING",
          `snapshot store ${probe.state} while resolving chain member ${hash}`,
        );
      }
      return null;
    }
    try {
      const doc = decodeMdsBytes(new Uint8Array(resolved.bytes)) as MdsSnapshotDoc;
      this.docCache.set(hash, doc);
      this.boundCache(this.docCache);
      return doc;
    } catch (error) {
      if (error instanceof SnapshotParseError) {
        throw new ChainBrokenError("SNAPSHOT_CHAIN_MEMBER_INVALID", `chain member ${hash}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Manifest lookup for one doc's themeRef — grouped by session id, never throws. */
  private async themeFromManifest(doc: MdsSnapshotDoc, warnings: string[]): Promise<Record<string, unknown> | null> {
    const themeRef = doc.themeRef;
    const sessionId = typeof doc.app?.["sessionId"] === "string" ? (doc.app["sessionId"] as string) : null;
    if (themeRef === null || sessionId === null) return null; // outside a session context → inline fallback already applied by the runtime

    const bytes = await this.readManifestBytes(sessionId);
    if (bytes === null) return null;

    // Decode-cache keyed on the bytes themselves (see manifestCache doc). The
    // read is always fresh — a mid-session theme switch appends entries and the
    // sha changes, so a stale manifest can never outlive the file that fixed it.
    const manifestBytesSha = sha256Of(Buffer.from(bytes));
    const cached = this.manifestCache.get(sessionId) ?? null;
    let manifest: MdsThemeManifest;
    if (cached !== null && cached.bytesSha256 === manifestBytesSha) {
      manifest = cached.manifest;
    } else {
      try {
        manifest = (decodeMdsBytes(bytes, true) as { manifest: MdsThemeManifest }).manifest;
      } catch (error) {
        // Corrupt/refused manifest — same degrade as a missing one.
        warnings.push(`theme manifest for session ${sessionId} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      this.manifestCache.set(sessionId, { bytesSha256: manifestBytesSha, manifest });
    }

    const entry = manifest.find((candidate) => candidate.hash === themeRef);
    return entry?.theme ?? null;
  }

  /**
   * Manifest bytes: the runtime writes `theme-manifest-<sessionId>.mds` beside
   * the snapshot files (flat directory). The store's key resolution covers
   * both the tool root and the day-hatted key convention via its basename
   * fallback, so the leaf name alone resolves.
   */
  private async readManifestBytes(sessionId: string): Promise<Uint8Array | null> {
    const resolved = await this.store.resolve(`theme-manifest-${sessionId}.mds`, null);
    return resolved === null ? null : new Uint8Array(resolved.bytes);
  }

  /** CRUD-free bound for the doc cache (shared LRU discipline with `cache`). */
  private boundCache(map: Map<string, unknown>): void {
    while (map.size > this.cacheEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
