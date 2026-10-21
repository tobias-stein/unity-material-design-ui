/**
 * Overlay placement + transparent-stage composite rendering.
 *
 * The placement math turns a popup snapshot's captured root anchor shape into
 * a CSS top/left position over a canvas-sized base stage — Unity anchors run
 * bottom→top, exported node rects are CSS top-down, so this locks the flip.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  buildReplicaStage,
  canvasViewportOf,
  overlayPlacementFor,
  type SnapshotNode,
  type UISnapshot,
} from "../src/index.js";

function makeSnapshot(rootOverrides: Partial<SnapshotNode> = {}): UISnapshot {
  const root: SnapshotNode = {
    id: "root",
    kind: "view",
    name: "View",
    type: "mdu.ui.View",
    parentId: null,
    siblingIndex: 0,
    active: true,
    isView: true,
    layer: "POPUP",
    rect: { x: 0, y: 0, width: 200, height: 80 },
    rectLocal: { x: 0, y: 0, width: 200, height: 80 },
    anchor: null,
    data: null,
    resolved: null,
    ...rootOverrides,
  };
  return {
    schemaVersion: 2,
    timestampUtc: null,
    app: { screenWidth: 1_280, screenHeight: 960, scaleFactor: 1 },
    view: { id: "view-1", name: "Popup", type: "mdu.ui.Popup", layer: "POPUP" },
    theme: null,
    nodes: [root],
    childrenOf: {},
    rootId: root.id,
    warnings: [],
  };
}

describe("canvasViewportOf", () => {
  it("divides the app screen by the canvas scale factor", () => {
    const snapshot = makeSnapshot();
    snapshot.app = { screenWidth: 1_280, screenHeight: 960, scaleFactor: 2 };
    expect(canvasViewportOf(snapshot)).toEqual({ width: 640, height: 480 });
  });

  it("returns null for legacy snapshots without app info", () => {
    const snapshot = makeSnapshot();
    snapshot.app = null;
    expect(canvasViewportOf(snapshot)).toBeNull();
  });
});

describe("overlayPlacementFor", () => {
  const viewport = { width: 800, height: 600 };

  it("places a full-screen dialog at 0,0 (stretch anchors, no size delta)", () => {
    const snapshot = makeSnapshot({
      rect: { x: 0, y: 0, width: 800, height: 600 },
      anchor: {
        pivotX: 0.5, pivotY: 0.5,
        anchorMinX: 0, anchorMinY: 0, anchorMaxX: 1, anchorMaxY: 1,
        anchoredX: 0, anchoredY: 0, sizeX: 0, sizeY: 0,
      },
    });
    expect(overlayPlacementFor(snapshot, viewport)).toEqual({
      left: 0, top: 0, width: 800, height: 600, mode: "anchor",
    });
  });

  it("y-flips a bottom-anchored snackbar above the screen bottom", () => {
    // Snackbar: stretch-x, anchored to the bottom edge with 16pt offset,
    // pivot at the bottom of a 80pt-tall strip.
    const snapshot = makeSnapshot({
      anchor: {
        pivotX: 0.5, pivotY: 0,
        anchorMinX: 0, anchorMinY: 0, anchorMaxX: 1, anchorMaxY: 0,
        anchoredX: 0, anchoredY: 16, sizeX: 0, sizeY: 80,
      },
    });
    const placement = overlayPlacementFor(snapshot, viewport);
    const anchorX = 0.5 * viewport.width; // anchorMin/Max x = 0/1 + anchored 0
    expect(placement.mode).toBe("anchor");
    expect(placement.width).toBe(200);
    expect(placement.height).toBe(80);
    // centered on x by the pivot
    expect(placement.left).toBeCloseTo(anchorX - 100, 6);
    // Unity y-up: bottom edge sits 16pt above the screen bottom → CSS top = 600 − (16 + 80)
    expect(placement.top).toBeCloseTo(viewport.height - (16 + 80), 6);
  });

  it("handles a top-anchored banner without a bottom reference", () => {
    const snapshot = makeSnapshot({
      rect: { x: 0, y: 0, width: 200, height: 56 },
      anchor: {
        pivotX: 0.5, pivotY: 1,
        anchorMinX: 0.5, anchorMinY: 1, anchorMaxX: 0.5, anchorMaxY: 1,
        anchoredX: 0, anchoredY: -10, sizeX: 200, sizeY: 56,
      },
    });
    const placement = overlayPlacementFor(snapshot, viewport);
    // pivot at top (y-up): bottomUp = anchorYUp + anchoredY − pivot·h = 600 − 10 − 56 = 534,
    // CSS top = 600 − (bottomUp + 56) = 600 − 590 = 10.
    expect(placement.top).toBeCloseTo(10, 6);
  });

  it("centers when the anchor data is missing (legacy captures)", () => {
    const snapshot = makeSnapshot({ anchor: null });
    const placement = overlayPlacementFor(snapshot, viewport);
    expect(placement.mode).toBe("center");
    expect(placement.left).toBeCloseTo((viewport.width - 200) / 2, 6);
    expect(placement.top).toBeCloseTo((viewport.height - 80) / 2, 6);
  });
});

describe("composite stage rendering", () => {
  it("transparentStage keeps the stage and an unpainted root see-through", () => {
    const holder = document.createElement("div");
    const replica = buildReplicaStage(makeSnapshot(), holder, "raw", { transparentStage: true });
    expect(replica.stage.style.background).toBe("transparent");
    const rootNode = replica.stage.querySelector<HTMLElement>('[data-node-id="root"]')!;
    expect(rootNode.style.background).toBe("transparent");
  });

  it("normal mode keeps the palette backdrop on the stage and the root view", () => {
    const holder = document.createElement("div");
    const replica = buildReplicaStage(makeSnapshot(), holder, "default-light");
    expect(replica.stage.style.background).not.toBe("transparent");
    const rootNode = replica.stage.querySelector<HTMLElement>('[data-node-id="root"]')!;
    expect(rootNode.style.background).not.toBe("transparent");
  });

  it("keeps captured root paint (dialog scrim alpha) even in overlay mode", () => {
    const snapshot = makeSnapshot({
      resolved: { backgroundColor: "#1d1b2080" },
    });
    const holder = document.createElement("div");
    const replica = buildReplicaStage(snapshot, holder, "raw", { transparentStage: true });
    const rootNode = replica.stage.querySelector<HTMLElement>('[data-node-id="root"]')!;
    expect(rootNode.style.background).toBe("rgba(29, 27, 32, 0.5)"); // alpha kept, not flattened
  });
});
