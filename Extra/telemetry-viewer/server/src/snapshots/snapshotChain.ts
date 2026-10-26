/**
 * ADR-0009 delta chain materialization (server-side storage mechanics).
 *
 * A delta member of a chain is a *storage* artifact: the sparse diff between
 * its base (the previous exported chain member) and the fresh capture. Its
 * bytes are self-sufficient for replay only *together with* the chain
 * segment — which rides in the file itself (`bases`: ancestor hashes, anchor
 * first, immediate base last; invariant checked below), so the store alone
 * resolves every member without ledger resolvability.
 *
 * Replay order (the writer's materialization contract): the anchor's whole
 * node stream, then each delta's `removed/added/changed` applied in chain
 * order, then this file's own delta. The result is by construction the tree
 * the runtime walked fresh for this capture — every consumer downstream
 * (playhead, heatmap, P4 version clusters) keeps dealing in whole snapshots.
 */
import {
  applyDeltaToMap,
  orderMaterializedNodes,
  SnapshotParseError,
  type MdsSnapshotDoc,
  type SnapshotNodeShape,
} from "./parse.js";

/** Resolve one chain member by its file hash → decoded MDS doc; null when absent. */
export type ChainMemberProvider = (hash: string) => Promise<MdsSnapshotDoc | null>;

export class ChainBrokenError extends Error {
  constructor(
    readonly code: "SNAPSHOT_CHAIN_MEMBER_MISSING" | "SNAPSHOT_CHAIN_MEMBER_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ChainBrokenError";
  }
}

/** The chain segment as replayed: `[anchorHash, ...deltaHashes, ownBase]` minus self. */
export function chainOf(doc: MdsSnapshotDoc): string[] {
  const delta = doc.delta;
  if (delta === null || delta === undefined) return [];
  const bases = [...delta.bases];
  // Writer invariant (UISnapshotBinaryWriter.writeDelta): the segment ends at
  // the immediate base. A violation means corrupt bytes, silently reordering
  // the replay would fabricate a tree that never existed.
  if (bases.length === 0 || bases[bases.length - 1] !== delta.baseHash) {
    throw new SnapshotParseError(
      "SNAPSHOT_MDS_INVALID",
      `delta chain segment does not end at its baseHash (${delta.baseHash}) — bytes are inconsistent`,
    );
  }
  return bases;
}

/**
 * Materialize a chain whose seed is `doc` (the delta member being parsed):
 * resolves each ancestor hash through `provider`, folds `removed/added/changed`
 * over the anchor's node map and returns the whole tree in deterministic
 * pre-order. Never mutates the member docs — `applyDeltaToMap`'s additions are
 * shared node objects, whole payloads by contract.
 */
export async function materializeChain(
  doc: MdsSnapshotDoc,
  provider: ChainMemberProvider,
): Promise<SnapshotNodeShape[]> {
  const delta = doc.delta;
  if (delta === null || delta === undefined) {
    throw new SnapshotParseError("SNAPSHOT_MDS_INVALID", "chain materialization asked for a non-delta artifact");
  }
  const segment = chainOf(doc);

  // Root first: it is an anchor (whole stream) — a delta there means the
  // segment's own head is gone (chain started mid-cycle, e.g. after a prune).
  const anchorHash = segment[0]!;
  const anchor = await provider(anchorHash);
  if (anchor === null) {
    throw new ChainBrokenError(
      "SNAPSHOT_CHAIN_MEMBER_MISSING",
      `delta chain root ${anchorHash} is not in the snapshot store (pruned or uncollected)`,
    );
  }
  if (anchor.contentMode !== "anchor" || anchor.nodes === undefined) {
    throw new ChainBrokenError(
      "SNAPSHOT_CHAIN_MEMBER_INVALID",
      `chain root ${anchorHash} is not an anchor file (whole node stream expected)`,
    );
  }
  const nodes: Map<string, SnapshotNodeShape> = new Map();
  for (const node of anchor.nodes) {
    const id = String(node.id ?? "");
    if (id !== "") nodes.set(id, node);
  }

  // Then every intermediate delta, in segment order (anchor → ... → baseHash).
  for (let index = 1; index < segment.length; index++) {
    const hash = segment[index]!;
    const member = await provider(hash);
    if (member === null) {
      throw new ChainBrokenError(
        "SNAPSHOT_CHAIN_MEMBER_MISSING",
        `delta chain member ${hash} (${index}/${segment.length - 1} of the segment) is not in the snapshot store`,
      );
    }
    if (member.delta === null || member.delta === undefined) {
      throw new ChainBrokenError(
        "SNAPSHOT_CHAIN_MEMBER_INVALID",
        `chain member ${hash} is not a delta file — segment and store disagree`,
      );
    }
    applyDeltaToMap(nodes, member.delta);
  }

  // Finally this member's own diffs. The result IS the fresh capture the
  // runtime diffed against (see UISnapshotDeltaBuilder) — materially an
  // anchor, at a fragment of the bytes.
  applyDeltaToMap(nodes, delta);
  return orderMaterializedNodes(nodes.values());
}
