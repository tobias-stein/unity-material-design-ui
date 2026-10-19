/**
 * Structure fingerprint tests (P3 scope of plan §7.1): identical trees under
 * different node ids share a fingerprint; pure layout/visual tweaks never
 * bump it; adding/removing/moving elements does; mode A hidden-key math
 * (union − intersection) and version clustering are deterministic.
 */
import { describe, expect, it } from "vitest";
import { buildCanonicalIndex } from "../src/core/canonical.js";
import { clusterPerViewKey, hiddenKeysOf, structureVersionOf, type VersionedSnapshotRef } from "../src/core/fingerprint.js";
import { parseSnapshotText, type ParsedSnapshot } from "../src/snapshots/parse.js";

function parse(nodesYaml: string, viewType = "mdu.ui.Menu(Clone)"): { parsed: ParsedSnapshot; index: ReturnType<typeof buildCanonicalIndex> } {
  const text = `
schemaVersion: 2
view: { id: v, name: Menu(Clone), type: ${viewType} }
nodes:
${nodesYaml}`;
  const parsed = parseSnapshotText(text);
  return { parsed, index: buildCanonicalIndex(parsed) };
}

const TREE = `
  - id: r1
    kind: ui
    isView: true
    name: Menu
    type: mdu.ui.Menu
    rect: { x: 0, y: 0, width: 800, height: 600 }
  - id: b1
    kind: ui
    name: OK
    type: mdu.ui.Button
    parentId: r1
    rect: { x: 10, y: 10, width: 48, height: 40 }
  - id: t1
    kind: ui
    type: mdu.ui.Switch
    parentId: r1
    rect: { x: 10, y: 60, width: 48, height: 28 }
`;

describe("structure fingerprints", () => {
  const a = parse(TREE);

  it("different runtime ids of the same tree → same fingerprint", () => {
    const renamed = parse(TREE.replace(/r1/g, "XXXX").replace(/b1/g, "YYYY").replace(/t1/g, "ZZZZ"));
    expect(structureVersionOf(renamed.index)).toEqual(structureVersionOf(a.index));
  });

  it("layout/visual-only differences (rects) never bump the fingerprint", () => {
    const moved = parse(TREE.replace("x: 10, y: 10", "x: 400, y: 100"));
    expect(structureVersionOf(moved.index)).toEqual(structureVersionOf(a.index));
  });

  it("adding an element bumps the fingerprint; removing moves it too", () => {
    const added = parse(`${TREE}
  - id: c9
    kind: ui
    name: Cancel
    type: mdu.ui.Button
    parentId: r1
    rect: { x: 10, y: 110, width: 48, height: 40 }
`);
    expect(structureVersionOf(added.index).fingerprint).not.toBe(structureVersionOf(a.index).fingerprint);

    const removed = parse(TREE.replace(/  - id: t1[\s\S]*rect: \{ x: 10, y: 60, width: 48, height: 28 \}/, ""));
    expect(structureVersionOf(removed.index).keys).not.toEqual(structureVersionOf(a.index).keys);
  });

  it("hiddenKeysOf: modes-A intersection over 2 versions (union − intersection)", () => {
    const base = new Set(["a", "b"]);
    const v1 = { fingerprint: "f1", keys: ["a", "b", "gone"] };
    const v2 = { fingerprint: "f2", keys: ["a", "b", "new"] };
    const single = hiddenKeysOf([{ fingerprint: "f", keys: ["x"] }]);
    expect(single.hidden.size).toBe(0);
    expect(single.intersection).toEqual(new Set(["x"]));

    const drift = hiddenKeysOf([v1, v2, { fingerprint: "f3", keys: [...base] }]);
    expect(drift.intersection).toEqual(base); // common across all three
    expect(drift.hidden).toEqual(new Set(["gone", "new"]));

    // Empty edge cases answer honestly (badge absent).
    expect(hiddenKeysOf([]).intersection.size).toBe(0);
  });

  it("clusterPerViewKey groups by viewKey and sorts deterministically", () => {
    const other = parse(TREE, "mdu.ui.Dialog(Clone)");
    const added = parse(`${TREE}
  - id: c9
    kind: ui
    name: Cancel
    type: mdu.ui.Button
    parentId: r1
    rect: { x: 10, y: 110, width: 48, height: 40 }
`);
    const ref = (snapshot: typeof a, ts: number, hash: string): VersionedSnapshotRef => ({
      hash,
      viewKey: snapshot.index.viewKey,
      timestampNs: BigInt(ts) * 1_000_000n,
      index: snapshot.index,
    });
    const clusters = clusterPerViewKey([
      ref(added!, 3, "c"),
      ref(a, 1, "a"),
      ref(other, 0, "z"),
      ref(added!, 2, "b"),
    ]);

    expect([...clusters.keys()].sort()).toEqual(["mdu.ui.Dialog", "mdu.ui.Menu"]);
    const menu = clusters.get("mdu.ui.Menu")!;
    expect(menu).toHaveLength(2); // base version + drift version
    expect(menu[0]!.snapshots.every((snap) => snap.hash === "a")).toBe(true);
    expect(menu[1]!.snapshots.map((snap) => snap.hash)).toEqual(["b", "c"]); // ts, then hash order
  });
});
