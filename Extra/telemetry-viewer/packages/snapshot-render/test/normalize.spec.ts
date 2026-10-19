/**
 * Unit coverage for the shared normalization pipeline (the one implementation
 * that used to be duplicated between the standalone viewer's applySnapshot and
 * the server's parse.ts). Semantics here are the exact legacy ones:
 *
 *   - missing ids → `anon:<n>` fallbacks by byId.size, duplicate ids → `#<n>` suffixes,
 *   - hierarchy from `parentId` + `siblingIndex`, orphans re-attached under the root,
 *   - geometry warning at the > 0.2 out-of-bounds ratio,
 *   - `SnapshotShapeError` codes for unusable documents.
 */
import { describe, expect, it } from "vitest";
import { geometryWarningForNodes, normalizeNodeIds, normalizeSnapshot, SnapshotShapeError } from "../src/normalize.js";

function doc(nodes: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, nodes, ...extra };
}

describe("normalizeNodeIds (the legacy viewer semantics)", () => {
  it("fills missing ids with anon:<byId.size> and suffixes duplicates in insertion order", () => {
    const nodes = [{ id: "a" }, { kind: "text" }, { id: "a" }, { id: undefined }] as Record<string, unknown>[];
    const byId = normalizeNodeIds(nodes);
    expect(nodes.map((n) => n.id)).toEqual(["a", "anon:1", "a#2", "anon:3"]);
    expect([...byId.keys()]).toEqual(["a", "anon:1", "a#2", "anon:3"]);
  });

  it("normalizes ids in place (same node objects, like the legacy byId map)", () => {
    const nodes = [{ id: null as unknown, kind: "layout" }];
    const byId = normalizeNodeIds(nodes);
    expect(byId.get("anon:0")!).toBe(nodes[0]);
    expect(nodes[0]!.id).toBe("anon:0");
  });

  it("normalizeSnapshot never aliases the caller's objects — copies carry the normalization", () => {
    const original = { id: null as unknown, kind: "layout", parentId: "x" };
    const snapshot = normalizeSnapshot({ schemaVersion: 1, nodes: [original] });
    expect(original.id).toBeNull(); // untouched
    expect(snapshot.nodes[0]!.id).toBe("anon:0"); // the copy is normalized
    expect(snapshot.nodes[0]).not.toBe(original);
  });
});

describe("normalizeSnapshot", () => {
  it("derives hierarchy from parentId + siblingIndex and reports the rootId", () => {
    const snapshot = normalizeSnapshot(
      doc([
        { id: "root", kind: "layout", rect: { x: 0, y: 0, width: 800, height: 600 } },
        { id: "b", parentId: "root", siblingIndex: 1 },
        { id: "a", parentId: "root", siblingIndex: 0 },
      ]),
    );
    expect(snapshot.rootId).toBe("root");
    expect(snapshot.childrenOf["root"]).toEqual(["a", "b"]);
    expect(snapshot.warnings).toEqual([]);
  });

  it("re-attaches orphan nodes under the root and updates their parentId", () => {
    const snapshot = normalizeSnapshot(
      doc([
        { id: "root", rect: { x: 0, y: 0, width: 800, height: 600 } },
        { id: "a", parentId: "root", siblingIndex: 0 },
        { id: "orphan", parentId: "gone", siblingIndex: 9 },
      ]),
    );
    expect(snapshot.childrenOf["root"]).toEqual(["a", "orphan"]);
    expect(snapshot.nodes[2]!.parentId).toBe("root");
  });

  it("throws SnapshotShapeError with stable codes", () => {
    expect(() => normalizeSnapshot(null)).toThrowError(expect.objectContaining({ code: "SNAPSHOT_NOT_MAPPING" }));
    expect(() => normalizeSnapshot([])).toThrowError(expect.objectContaining({ code: "SNAPSHOT_NOT_MAPPING" }));
    expect(() => normalizeSnapshot({ schemaVersion: 1, nodes: [] })).toThrowError(
      expect.objectContaining({ code: "SNAPSHOT_EMPTY" }),
    );
    expect(() => normalizeSnapshot({ schemaVersion: 1, nodes: [] })).toThrow("snapshot contains no nodes");
  });

  it("schema drift wording is parametrized (viewer default vs server (2)/parse)", () => {
    const missing = normalizeSnapshot({ nodes: [{ id: "a" }] });
    expect(missing.schemaVersion).toBeNull();
    expect(missing.warnings).toEqual(["missing schemaVersion — best-effort render"]);

    const newer = normalizeSnapshot(doc([{ id: "a" }], { schemaVersion: 3 }));
    expect(newer.warnings).toEqual(["schemaVersion 3 newer than supported (1) — best-effort render"]);

    const server = normalizeSnapshot(doc([{ id: "a" }], { schemaVersion: 3 }), {
      supportedSchemaVersion: 2,
      bestEffortKind: "parse",
    });
    expect(server.warnings).toEqual(["schemaVersion 3 newer than supported (2) — best-effort parse"]);
  });

  it("timestampUtc passes the raw YAML value through (vendored js-yaml Date parity)", () => {
    const iso = "2026-10-17T14:30:00Z";
    const stringDoc = normalizeSnapshot(doc([{ id: "a" }], { timestampUtc: iso }));
    expect(stringDoc.timestampUtc).toBe(iso);
    const date = new Date(Date.UTC(2026, 9, 17, 14, 30));
    const dateDoc = normalizeSnapshot(doc([{ id: "a" }], { timestampUtc: date }));
    expect(dateDoc.timestampUtc).toBe(date);
  });
});

describe("geometryWarningForNodes", () => {
  const rootRect = { id: "root", rect: { x: 0, y: 0, width: 100, height: 100 } };

  it("is null when nodes sit inside the root", () => {
    expect(geometryWarningForNodes([rootRect, { id: "a", rect: { x: 10, y: 10, width: 50, height: 50 } }], "root")).toBeNull();
  });

  it("fires above the 20% out-of-bounds ratio with the legacy message", () => {
    const nodes = [rootRect];
    for (let i = 0; i < 3; i++) {
      nodes.push({ id: `o${i}`, rect: { x: 900, y: 0, width: 10, height: 10 } });
    }
    expect(geometryWarningForNodes(nodes, "root")).toBe("3 of 4 nodes lie outside the root — capture likely ran before layout was applied");
  });

  it("skips inactive and non-numeric-rect nodes", () => {
    const nodes = [rootRect, { id: "a", rect: { x: 900, y: 0, width: 10, height: 10 } }, { id: "b", active: false, rect: { x: 900, y: 0, width: 10, height: 10 } }, { id: "c", rect: { x: "nope" } }];
    expect(geometryWarningForNodes(nodes, "root")).toBe("1 of 2 nodes lie outside the root — capture likely ran before layout was applied");
  });
});
