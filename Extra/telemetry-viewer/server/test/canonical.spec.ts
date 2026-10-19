/**
 * Canonical key tests (plan §6.2): viewKey "(Clone)" stripping, path
 * segments (name vs `{kind}:{type}[{siblingIndex}]` fallback), exact vs
 * approximate confidence, root-only elements, and anonymous node names.
 */
import { describe, expect, it } from "vitest";
import {
  buildCanonicalIndex,
  canonicalKeyFromSegments,
  isFallbackSegment,
  nodeIdForCanonicalKey,
  pathSegmentOf,
  stripCloneSuffix,
  viewKeyOf,
  UNKNOWN_VIEW,
} from "../src/core/canonical.js";
import { parseSnapshotText } from "../src/snapshots/parse.js";

const MENU_YAML = `
schemaVersion: 2
view:
  id: v1
  name: UIDemoMainMenu(Clone)
  type: mdu.ui.UIDemoMainMenu(Clone)
nodes:
  - id: root1
    kind: ui
    isView: true
    name: MainMenu
    type: mdu.ui.MainMenu
    siblingIndex: 0
    rect: { x: 0, y: 0, width: 800, height: 600 }
  - id: deepParent
    kind: layout
    name: BodyPanel
    type: LayoutGroup
    parentId: root1
    siblingIndex: 0
  - id: namedLeaf
    kind: ui
    name: PlayButton
    type: mdu.ui.Button
    parentId: deepParent
    siblingIndex: 0
  - id: ${"anon:7"}
    kind: ui
    type: mdu.ui.Button
    parentId: deepParent
    siblingIndex: 1
  - id: weirdName
    kind: ui
    name: "  "
    type: mdu.ui.Switch
    parentId: root1
    siblingIndex: 2
`;

describe("canonical keys", () => {
  const snapshot = parseSnapshotText(MENU_YAML);
  const index = buildCanonicalIndex(snapshot);

  it("strips a trailing (Clone) from the viewKey", () => {
    expect(viewKeyOf(snapshot)).toBe("mdu.ui.UIDemoMainMenu");
    expect(stripCloneSuffix("MainMenu(Clone)")).toBe("MainMenu");
    expect(stripCloneSuffix("(Clone)")).toBe("");
  });

  it("namesWIN: full named path with the elementType terminator (exact)", () => {
    const entry = index.byNodeId.get("namedLeaf")!;
    expect(entry.key).toBe("mdu.ui.UIDemoMainMenu › BodyPanel › PlayButton › mdu.ui.Button");
    expect(entry.confidence).toBe("exact");
    expect(entry.elementType).toBe("mdu.ui.Button");
    expect(entry.leafLabel).toBe("PlayButton");
  });

  it("anonymous ids and blank names fall back to {kind}:{type}[{siblingIndex}] (approximate)", () => {
    const anon = index.byNodeId.get("anon:7")!;
    expect(anon.key).toBe("mdu.ui.UIDemoMainMenu › BodyPanel › ui:mdu.ui.Button[1] › mdu.ui.Button");
    expect(anon.confidence).toBe("approximate");
    expect(anon.leafLabel).toBe("ui:mdu.ui.Button[1]");

    // exporter snapshot ids minted `anon:<n>` are anonymous *and* the node
    // name may be blank — the id check must not treat `anon:` as a name.
    expect(pathSegmentOf({ kind: "ui", type: "mdu.ui.Button", siblingIndex: 3 }, "anon:7")).toBe("ui:mdu.ui.Button[3]");
    expect(pathSegmentOf({ name: "  ", kind: "ui", type: "mdu.ui.Switch", siblingIndex: 2 }, "weirdName")).toBe("ui:mdu.ui.Switch[2]");

    const fallbackSwitch = index.byNodeId.get("weirdName")!;
    expect(fallbackSwitch.confidence).toBe("approximate");
  });

  it("elements sitting on the view root terminate at elementType right after the viewKey", () => {
    const rootEntry = index.byNodeId.get("root1")!;
    expect(rootEntry.key).toBe("mdu.ui.UIDemoMainMenu › mdu.ui.MainMenu");
    expect(rootEntry.confidence).toBe("exact");
  });

  it("remembers which node each key came from (first occurrence wins)", () => {
    expect(nodeIdForCanonicalKey(index, "mdu.ui.UIDemoMainMenu › BodyPanel › PlayButton › mdu.ui.Button")).toBe("namedLeaf");
    expect(nodeIdForCanonicalKey(index, "mdu.ui.UIDemoMainMenu › (missing) › x")).toBeNull();
  });

  it("isFallbackSegment detects exactly the fallback shape", () => {
    expect(isFallbackSegment("ui:mdu.ui.Button[3]")).toBe(true);
    expect(isFallbackSegment("layout:LayoutGroup[0]")).toBe(true);
    expect(isFallbackSegment("BodyPanel")).toBe(false);
    expect(isFallbackSegment("Play Button")).toBe(false);
  });

  it("canonicalKeyFromSegments joins with the plan separator", () => {
    expect(canonicalKeyFromSegments("mdu.ui.MainMenu", ["A", "ui:X[1]"], "t")).toBe("mdu.ui.MainMenu › A › ui:X[1] › t");
  });

  it("snapshots without a usable view identity fall back to (unknown view)", () => {
    const anonymous = parseSnapshotText(`
schemaVersion: 2
nodes:
  - id: only
    kind: ui
    type: mdu.ui.Button
    siblingIndex: 0
`);
    const anonymousIndex = buildCanonicalIndex(anonymous);
    expect(anonymousIndex.viewKey).toBe(UNKNOWN_VIEW);
    expect(anonymousIndex.byNodeId.get("only")!.key).toBe("(unknown view) › mdu.ui.Button");
  });
});
