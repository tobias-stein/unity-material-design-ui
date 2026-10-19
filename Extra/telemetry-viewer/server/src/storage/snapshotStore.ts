/**
 * Snapshot storage abstraction (plan §4.1/§5): files stay files, the tool
 * resolves `storageKey → bytes`. v1 ships {@link LocalFsSnapshotStore}; the
 * interface is deliberately narrow so an S3-compatible adapter can drop in
 * later without touching callers.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ResolvedSnapshot {
  bytes: Buffer;
  /** Lowercase hex SHA-256 of the bytes (the ledger join key). */
  sha256: string;
}

export interface SnapshotStoreStatus {
  state: "ok" | "unconfigured" | "unreachable" | "not-a-directory";
  root: string | null;
  fileCount: number | null;
  message?: string;
}

export interface SnapshotStore {
  /** Identifier used in `GET /api/sources`. */
  readonly id: string;
  describe(): Promise<SnapshotStoreStatus>;
  /**
   * Resolve a storage key + expected hash to bytes, or `null` when absent.
   * `key` may be normalized away (hash-first matching); `hash` is the truth.
   */
  resolve(storageKey: string, expectedHash: string | null): Promise<ResolvedSnapshot | null>;
}

export class LocalFsSnapshotStore implements SnapshotStore {
  readonly id = "local-fs";

  constructor(private readonly root: string | null) {}

  async describe(): Promise<SnapshotStoreStatus> {
    if (this.root === null) {
      return { state: "unconfigured", root: null, fileCount: null };
    }
    try {
      const stat = await fs.stat(this.root);
      if (!stat.isDirectory()) {
        return { state: "not-a-directory", root: this.root, fileCount: null };
      }
      return {
        state: "ok",
        root: this.root,
        fileCount: await this.countFiles(this.root),
      };
    } catch (error) {
      return {
        state: "unreachable",
        root: this.root,
        fileCount: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resolve(storageKey: string, expectedHash: string | null): Promise<ResolvedSnapshot | null> {
    if (this.root === null) return null;
    // 1) Key hint: `snapshots/<yyyy>/<mm>/<dd>/<file>` straight under the root.
    const direct = path.join(this.root, storageKey);
    const directHit = await this.tryRead(direct, expectedHash);
    if (directHit !== null) return directHit;

    // 2) Legacy flat layout: leaf file name directly under the root.
    const leaf = path.join(this.root, path.basename(storageKey));
    const leafHit = await this.tryRead(leaf, expectedHash);
    if (leafHit !== null) return leafHit;

    // 3) Hash walk: precise but O(collection); use when keys are unreliable.
    if (expectedHash === null) return null;
    const match = await this.findByHash(this.root, expectedHash);
    return match;
  }

  private async tryRead(file: string, expectedHash: string | null): Promise<ResolvedSnapshot | null> {
    try {
      const bytes = await fs.readFile(file);
      if (expectedHash === null) {
        return { bytes, sha256: sha256Of(bytes) };
      }
      return sha256Of(bytes) === expectedHash ? { bytes, sha256: expectedHash } : null;
    } catch {
      return null;
    }
  }

  private async findByHash(dir: string, expectedHash: string): Promise<ResolvedSnapshot | null> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await this.findByHash(full, expectedHash);
        if (found !== null) return found;
      } else {
        const hit = await this.tryRead(full, expectedHash);
        if (hit !== null) return hit;
      }
    }
    return null;
  }

  private async countFiles(dir: string): Promise<number> {
    let count = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await this.countFiles(path.join(dir, entry.name));
      } else {
        count++;
      }
    }
    return count;
  }
}

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
