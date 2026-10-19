/**
 * Structure fingerprints (plan §6.2/§7) — a snapshot's structural identity is
 * the sorted set of its canonical element keys, hashed to one fingerprint.
 * Pure layout/visual differences (colors, sizes, text) never touch it, so a
 * fingerprint bump means the *tree changed*.
 *
 * P3 scope (aggregate mode A): version *clustering* per viewKey is what the
 * divergence badge counts — "N divergent viewKeys — M keys hidden" — plus the
 * intersection/template-selection ground rules of §7 A. Modes B and C
 * (per-version groups, ground-truth merge) arrive in P4 on the same types.
 */
import { createHash } from "node:crypto";
import type { CanonicalIndex } from "./canonical.js";

export interface StructureVersion {
  /** sha256 over the sorted canonical key list (structural identity). */
  fingerprint: string;
  /** Sorted canonical keys of this version. */
  keys: string[];
}

export interface VersionedSnapshotRef {
  /** Content hash (ledger join key); unique per parsed document. */
  hash: string;
  viewKey: string;
  timestampNs: bigint;
  index: CanonicalIndex;
}

/** Fingerprint of a parsed snapshot's canonical key set. */
export function structureVersionOf(index: CanonicalIndex): StructureVersion {
  const keys = [...index.byKey.keys()].sort(compareKeys);
  const digest = createHash("sha256");
  for (const key of keys) digest.update(key, "utf8").update("\n");
  return { fingerprint: digest.digest("hex"), keys };
}

/** Stable total order for canonical keys (lexicographic, code-point safe). */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Cluster parsed snapshots per viewKey into structure versions. Deterministic:
 * the same snapshots always produce the same version list (sorted by first
 * occurrence timestamp, then fingerprint; snapshots by timestamp, then hash).
 */
export function clusterPerViewKey(
  snapshots: readonly VersionedSnapshotRef[],
): Map<string, Array<StructureVersion & { snapshots: VersionedSnapshotRef[] }>> {
  const result = new Map<string, Array<StructureVersion & { snapshots: VersionedSnapshotRef[] }>>();
  for (const ref of snapshots) {
    const version = structureVersionOf(ref.index);
    let clusters = result.get(ref.viewKey);
    if (clusters === undefined) {
      clusters = [];
      result.set(ref.viewKey, clusters);
    }
    let found = clusters.find((entry) => entry.fingerprint === version.fingerprint);
    if (found === undefined) {
      found = { ...version, snapshots: [] };
      clusters.push(found);
    }
    found.snapshots.push(ref);
  }
  for (const clusters of result.values()) {
    clusters.sort(
      (a, b) =>
        minTs(a.snapshots) < minTs(b.snapshots)
          ? -1
          : minTs(a.snapshots) > minTs(b.snapshots)
            ? 1
            : a.fingerprint < b.fingerprint
              ? -1
              : a.fingerprint > b.fingerprint
                ? 1
                : 0,
    );
    for (const cluster of clusters) {
      cluster.snapshots.sort(
        (a, b) => (a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : a.hash < b.hash ? -1 : 1),
      );
    }
  }
  return result;
}

function minTs(refs: readonly VersionedSnapshotRef[]): bigint {
  let min = refs[0]?.timestampNs ?? 0n;
  for (const ref of refs) if (ref.timestampNs < min) min = ref.timestampNs;
  return min;
}

/**
 * Keys present in some but not all structure versions of a viewKey
 * (union − intersection; §7 A's "hidden" amount).
 */
export function hiddenKeysOf(versions: readonly StructureVersion[]): {
  intersection: Set<string>;
  hidden: Set<string>;
} {
  if (versions.length === 0) return { intersection: new Set(), hidden: new Set() };
  if (versions.length === 1) return { intersection: new Set(versions[0]!.keys), hidden: new Set() };
  const [first, ...rest] = versions;
  const intersection = new Set(first!.keys);
  for (const version of rest) {
    const versionKeys = new Set(version.keys);
    for (const key of intersection) if (!versionKeys.has(key)) intersection.delete(key);
  }
  const hidden = new Set<string>();
  for (const version of versions) {
    for (const key of version.keys) if (!intersection.has(key)) hidden.add(key);
  }
  return { intersection, hidden };
}
