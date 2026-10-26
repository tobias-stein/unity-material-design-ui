/**
 * MDS v3 binary format tests (ADR-0008/0007/0009).
 *
 * The fixture encoder (`mdsFixture.ts`) mirrors the wire layout pinned in
 * `Assets/Runtime/Telemetry/Snapshot/UISnapshotBinaryWriter.cs` (LEB128
 * varints, interned string table, 0.01-quantized ints, info-bitset order).
 * It is a *self-consistency* fixture for the TS side — byte parity with the
 * C# writer still needs the golden round-trip captured inside Unity (see the
 * hand-over notes); these tests lock the TS decoder/finalize/materialization
 * path the two viewers share.
 */
import { describe, expect, it } from "vitest";
import {
  decodeMdsBytes,
  hasMdsMagic,
  parseSnapshotBytes,
  SnapshotParseError,
  type MdsSnapshotDoc,
} from "../src/snapshots/parse.js";
import { chainOf } from "../src/snapshots/snapshotChain.js";
import { SnapshotService } from "../src/snapshots/snapshotService.js";
import type { SnapshotStore } from "../src/storage/snapshotStore.js";
import {
  encodeAnchor,
  encodeDelta,
  encodeManifest,
  encodeThemeRefAnchor,
  sha,
  testTheme,
} from "./mdsFixture.js";

let service: SnapshotService | null = null;

/* In-memory store — hash-first plus a basename map for key-hint findings (manifest lookups). */
function memoryStore(files: Map<string, Uint8Array>, byName: Map<string, Uint8Array> = new Map()): SnapshotStore {
  return {
    id: "memory-test",
    root: "memory:",
    probe: async () => ({ state: "ok" as const }),
    describe: async () => ({ state: "ok" as const, root: "memory:", fileCount: files.size }),
    resolve: async (key, hash) => {
      const bytes = hash !== null ? files.get(hash) : undefined;
      if (bytes) return { bytes: Buffer.from(bytes), sha256: hash! };
      const named = key !== "" ? byName.get(key) ?? byName.get(key.split("/").pop() ?? "") : undefined;
      if (named) return { bytes: Buffer.from(named), sha256: sha(named) };
      return null;
    },
  };
}

describe("MDS v3 binary format (ADR-0008)", () => {
  it("sniffs the magic and parses an anchor file into the client-ready shape", () => {
    const anchor = encodeAnchor();
    expect(hasMdsMagic(anchor)).toBe(true);

    const parsed = parseSnapshotBytes(anchor);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.rootId).toBe("root");
    expect(parsed.childrenOf["root"]).toEqual(["label", "btn"]); // siblingIndex order
    expect(parsed.nodes.map((node) => node["id"])).toEqual(["root", "label", "btn"]);
    expect(parsed.view?.["name"]).toBe("UIDemoMainMenu");
    expect(parsed.theme?.["seedColor"]).toBe("#6750A4");
    expect(parsed.theme?.["spacing"]).toEqual({ m1: 0.75 });
    expect(parsed.themeRef).toBeNull();
    expect(parsed.warnings).toEqual([]);

    const btn = parsed.nodes.find((node) => node["id"] === "btn");
    expect(btn?.rect).toEqual({ x: 100, y: 100, width: 120, height: 40 });
    expect(btn?.parentId).toBe("root");
  });

  it("rejects non-v3 headers honestly", () => {
    const bytes = encodeAnchor();
    bytes[4] = 2; // formatVersion
    expect(() => parseSnapshotBytes(bytes)).toThrow(SnapshotParseError);
  });

  it("rejects delta artifacts as standalone parses (chain storage, ADR-0009)", () => {
    const anchorHash = sha(encodeAnchor());
    const delta = encodeDelta({ baseHash: anchorHash, bases: [anchorHash], removedIds: [], added: [], changed: [] });
    expect(() => parseSnapshotBytes(delta)).toThrow(SnapshotParseError);
    expect(() => parseSnapshotBytes(delta)).toThrowError(/Delta chain capture/);
  });
});

describe("MDS theme manifest (ADR-0007)", () => {
  it("decodes manifest entries — present and deliberately-absent ones", () => {
    const manifestBytes = encodeManifest([
      ["6750a4ff", testTheme],
      ["00000000", null],
    ]);
    const decoded = decodeMdsBytes(manifestBytes, true) as { manifest: Array<{ hash: string; theme: Record<string, unknown> | null }> };
    expect(decoded.manifest).toHaveLength(2);
    expect(decoded.manifest[0]!.hash).toBe("6750a4ff");
    expect(decoded.manifest[0]!.theme?.["seedColor"]).toBe("#6750A4");
    expect(decoded.manifest[1]!.theme).toBeNull();
  });

  it("resolves a manifest-referenced theme through the service", async () => {
    const manifestBytes = encodeManifest([["6750a4ff", testTheme]]);
    const refBytes = encodeThemeRefAnchor("6750a4ff");
    const files = new Map<string, Uint8Array>([[sha(refBytes), refBytes]]);
    const byName = new Map<string, Uint8Array>([["theme-manifest-sess-1.mds", manifestBytes]]);
    const service = new SnapshotService(memoryStore(files, byName));
    const resolved = await service.resolve({ key: null, hash: sha(refBytes) });
    expect(resolved.parsed.themeRef).toBe("6750a4ff");
    expect(resolved.parsed.theme).not.toBeNull();
    expect(resolved.parsed.theme?.["palette"]).toEqual(testTheme.palette);
    expect(resolved.parsed.warnings).toEqual([]);
  });

  it("degrades with a warning when the manifest is missing (prune consequence)", async () => {
    const refBytes = encodeThemeRefAnchor("6750a4ff");
    const files = new Map<string, Uint8Array>([[sha(refBytes), refBytes]]);
    const service = new SnapshotService(memoryStore(files));
    const resolved = await service.resolve({ key: null, hash: sha(refBytes) });
    expect(resolved.parsed.themeRef).toBe("6750a4ff");
    expect(resolved.parsed.theme).toBeNull();
    expect(resolved.parsed.warnings.some((w) => w.includes("manifest"))).toBe(true);
  });
});

describe("MDS delta chain materialization (ADR-0009)", () => {
  const anchorBytes = encodeAnchor();
  const anchorHash = sha(anchorBytes);
  const deltaBytes = encodeDelta({
    baseHash: anchorHash,
    bases: [anchorHash],
    removedIds: ["label"],
    added: [
      { id: "label2", name: "PlayLabel", active: true, siblingIndex: 0, parentId: "root", rect: { x: 41, y: 80, width: 200, height: 24 } },
    ],
    changed: [
      { id: "btn", name: "PlayButton", active: true, siblingIndex: 1, parentId: "root", rect: { x: 100, y: 100, width: 160, height: 40 } },
    ],
  });
  const deltaHash = sha(deltaBytes);

  it("materializes anchor → delta into the replayed whole tree through the store alone", async () => {
    const files = new Map<string, Uint8Array>([
      [anchorHash, anchorBytes],
      [deltaHash, deltaBytes],
    ]);
    const service = new SnapshotService(memoryStore(files), 24);

    const resolved = await service.resolve({ key: null, hash: deltaHash });
    const parsed = resolved.parsed;
    expect(parsed.rootId).toBe("root");
    expect(parsed.nodes.map((node) => node["id"])).toEqual(["root", "label2", "btn"]); // pre-order, siblingIndex order
    expect(parsed.nodes.find((node) => node["id"] === "label")).toBeUndefined();
    const btn = parsed.nodes.find((node) => node["id"] === "btn");
    expect(btn?.rect?.width).toBe(160);
    const label2 = parsed.nodes.find((node) => node["id"] === "label2");
    expect(label2?.rect?.x).toBe(41);
    expect(parsed.childrenOf["root"]).toEqual(["label2", "btn"]);
    expect(parsed.warnings).toEqual([]);
  });

  it("fails honestly when a chain member is pruned (no silently wrong tree)", async () => {
    const brokenFiles = new Map<string, Uint8Array>([[deltaHash, deltaBytes]]); // anchor missing
    const brokenService = new SnapshotService(memoryStore(brokenFiles), 24);
    await expect(brokenService.resolve({ key: null, hash: deltaHash })).rejects.toMatchObject({
      code: "SNAPSHOT_CHAIN_MEMBER_MISSING",
      httpStatus: 409,
    });
  });

  it("verifies the segment invariant (segment must end at baseHash)", () => {
    const wrongSegment = encodeDelta({
      baseHash: sha(anchorBytes),
      bases: [], // corrupt: empty segment can't end at its base
      removedIds: [],
      added: [],
      changed: [],
    });
    const doc = decodeMdsBytes(wrongSegment) as MdsSnapshotDoc;
    expect(() => chainOf(doc)).toThrow(SnapshotParseError);
  });

  it("re-parses identical bytes from cache without re-resolving", async () => {
    const files = new Map<string, Uint8Array>([
      [anchorHash, anchorBytes],
      [deltaHash, deltaBytes],
    ]);
    service = new SnapshotService(memoryStore(files), 24);
    const first = await service.resolve({ key: null, hash: deltaHash });
    const second = await service.resolve({ key: null, hash: deltaHash });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.parsed.rootId).toBe(first.parsed.rootId);
    expect(service.cacheSize).toBeGreaterThan(0);
  });
});
