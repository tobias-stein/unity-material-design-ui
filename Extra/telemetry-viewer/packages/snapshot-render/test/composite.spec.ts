/**
 * Composite replica resolution — layer stacking + per-span capture pick rules.
 * `resolveComposite` is DOM-free; these tests only shape plain objects.
 */
import { describe, expect, it } from "vitest";
import {
  canvasLayerRank,
  resolveComposite,
  type CompositeAnchorLike,
  type CompositeSpanLike,
} from "../src/composite.js";

function span(overrides: Partial<CompositeSpanLike> & { index: number; openMs: number }): CompositeSpanLike {
  return {
    viewId: null,
    closeMs: null,
    layer: "DEFAULT",
    row: 0,
    ...overrides,
  } as CompositeSpanLike;
}

function anchor(index: number, ms: number, viewId: string | null): CompositeAnchorLike {
  return { index, ms, viewId };
}

const MAIN = 8; // global index of the menu capture

describe("canvasLayerRank", () => {
  it("orders the CanvasLayer enum exactly (UI.cs z-order)", () => {
    expect(canvasLayerRank("BACKGROUND")).toBeLessThan(canvasLayerRank("DEFAULT"));
    expect(canvasLayerRank("DEFAULT")).toBeLessThan(canvasLayerRank("MENU"));
    expect(canvasLayerRank("MENU")).toBeLessThan(canvasLayerRank("POPUP"));
  });

  it("rides DEFAULT for null/unknown layer names", () => {
    expect(canvasLayerRank(null)).toBe(canvasLayerRank("DEFAULT"));
    expect(canvasLayerRank("SOMETHING_NEW")).toBe(canvasLayerRank("DEFAULT"));
  });
});

describe("resolveComposite", () => {
  it("stacks every covering span bottom→top by canvas layer", () => {
    // Main menu open the whole clip; dialog + snackbar open over it.
    const spans = [
      span({ index: 0, viewId: "main", openMs: 0, closeMs: 10_000, layer: "DEFAULT", row: 0 }),
      span({ index: 1, viewId: "snack", openMs: 4_000, closeMs: 6_000, layer: "POPUP", row: 2 }),
      span({ index: 2, viewId: "dialog", openMs: 3_000, closeMs: 5_000, layer: "POPUP", row: 1 }),
    ];
    const anchors = [anchor(MAIN, 100, "main"), anchor(9, 3_100, "dialog"), anchor(5, 4_100, "snack")];

    const result = resolveComposite(spans, anchors, 4_500);
    expect(result.reason).toBeNull();
    expect(result.fallback).toBe(false);
    expect(result.layers.map((layer) => layer.span?.viewId)).toEqual(["main", "dialog", "snack"]);
    expect(result.layers.map((layer) => layer.anchor.index)).toEqual([MAIN, 9, 5]);
  });

  it("picks the latest anchor ≤ t within each covering span", () => {
    const spans = [span({ index: 0, viewId: "main", openMs: 0, closeMs: 10_000 })];
    const anchors = [anchor(MAIN, 100, "main"), anchor(2, 2_000, "main"), anchor(3, 8_000, "main")];
    const result = resolveComposite(spans, anchors, 5_000);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.anchor.index).toBe(2);
  });

  it("applies the opening-capture grace: view_open selection (t = openMs) shows the span's opening capture", () => {
    // Runtime truth: the capture is taken asynchronously, its ledger point
    // lands a few ms AFTER the view_open event the playhead rests on.
    const spans = [span({ index: 0, viewId: "main", openMs: 1_000, closeMs: 9_000 })];
    const anchors = [anchor(4, 1_005, "main")];
    const result = resolveComposite(spans, anchors, 1_000);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.anchor.index).toBe(4);
  });

  it("ignores captures outside the span's own window", () => {
    const spans = [
      span({ index: 0, viewId: "v", openMs: 0, closeMs: 1_000, row: 0 }),
      span({ index: 1, viewId: "v", openMs: 5_000, closeMs: 6_000, row: 0 }),
    ];
    const anchors = [anchor(1, 500, "v"), anchor(2, 5_500, "v")];
    // t inside the first cycle → its capture; the second's capture rides its own span.
    const first = resolveComposite(spans, anchors, 800);
    expect(first.layers[0]!.anchor.index).toBe(1);
    const second = resolveComposite(spans, anchors, 5_800);
    expect(second.layers[0]!.anchor.index).toBe(2);
  });

  it("falls back to the global chain when the playhead sits in no span (between cycles)", () => {
    const spans = [
      span({ index: 0, viewId: "main", openMs: 0, closeMs: 1_000 }),
      span({ index: 1, viewId: "other", openMs: 5_000 }),
    ];
    const anchors = [anchor(MAIN, 500, "main")];
    // t in the gap after the first cycle closed, before the second opens.
    const result = resolveComposite(spans, anchors, 3_000);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.span).toBeNull();
    expect(result.layers[0]!.anchor.index).toBe(MAIN);
  });

  it("prefer real covering spans over the global chain", () => {
    const spans = [
      span({ index: 0, viewId: "stale", openMs: 0, closeMs: 1_000 }),
      span({ index: 1, viewId: "dialog", openMs: 4_000, closeMs: 6_000, layer: "POPUP" }),
    ];
    const anchors = [anchor(1, 500, "stale"), anchor(2, 4_100, "dialog")];
    const result = resolveComposite(spans, anchors, 5_000);
    expect(result.layers.map((layer) => layer.span?.viewId)).toEqual(["dialog"]);
  });

  it("honest empty reason when nothing covers and no capture ever", () => {
    const spans = [span({ index: 0, viewId: "main", openMs: 2_000 })];
    const result = resolveComposite(spans, [], 1_000);
    expect(result.layers).toHaveLength(0);
    expect(result.reason).toContain("No snapshot");
  });

  it("spans without captures contribute no layer but the composite still renders from other spans", () => {
    // Legacy dedupe-era session: the popup's re-opened cycles hold no captures.
    const spans = [
      span({ index: 0, viewId: "main", openMs: 0, closeMs: 10_000 }),
      span({ index: 1, viewId: "snack2", openMs: 4_000, closeMs: 6_000, layer: "POPUP", row: 1 }),
    ];
    const anchors = [anchor(MAIN, 100, "main")];
    const result = resolveComposite(spans, anchors, 5_000);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]!.span?.viewId).toBe("main");
  });

  it("same layer rank ties break by server row then open time", () => {
    const spans = [
      span({ index: 0, viewId: "a", openMs: 5_000, closeMs: 8_000, layer: "POPUP", row: 2 }),
      span({ index: 1, viewId: "b", openMs: 4_000, closeMs: 8_000, layer: "POPUP", row: 1 }),
      span({ index: 2, viewId: "c", openMs: 4_500, closeMs: 8_000, layer: "POPUP", row: 1 }),
    ];
    const anchors = [
      anchor(1, 4_100, "b"),
      anchor(2, 4_600, "c"),
      anchor(0, 5_100, "a"),
    ];
    const result = resolveComposite(spans, anchors, 6_000);
    expect(result.layers.map((layer) => layer.span?.viewId)).toEqual(["b", "c", "a"]);
  });

  it("stateMs resolves the consequence capture: a click's debounced mutation capture is its state", () => {
    // The playhead rests on the click at 1_000; the capture it *caused* lands
    // at 1_300 (debounce + settle). With plain "latest ≤ t" the visitor sees
    // the pre-click state until the next event moves time past the capture.
    const spans = [span({ index: 0, viewId: "main", openMs: 0, closeMs: 10_000 })];
    const anchors = [
      anchor(MAIN, 100, "main"), // opening capture (pre-click state)
      anchor(7, 1_300, "main"), // the click's consequence capture
    ];
    const withoutWindow = resolveComposite(spans, anchors, 1_000);
    expect(withoutWindow.layers[0]!.anchor.index).toBe(MAIN); // unchanged legacy semantics
    const withWindow = resolveComposite(spans, anchors, 1_000, 2_000); // next event at 2_000
    expect(withWindow.layers[0]!.anchor.index).toBe(7);
  });

  it("stateMs at the session tail (last event) reveals the trailing capture", () => {
    // Live auto-step: the playhead rests on the final event; the mutation
    // capture it triggered lands after it and must still show.
    const spans = [span({ index: 0, viewId: "main", openMs: 0, closeMs: 10_000 })];
    const anchors = [anchor(MAIN, 100, "main"), anchor(7, 5_050, "main")];
    const result = resolveComposite(spans, anchors, 5_000, Number.POSITIVE_INFINITY);
    expect(result.layers[0]!.anchor.index).toBe(7);
  });

  it("stateMs keeps span coverage at the playhead: anchors outside a covered span stay out", () => {
    // t covers the first cycle; the state window may run long, but captures
    // belonging to a later cycle of the same view do not leak into it.
    const spans = [
      span({ index: 0, viewId: "v", openMs: 0, closeMs: 1_000, row: 0 }),
      span({ index: 1, viewId: "v", openMs: 5_000, closeMs: 6_000, row: 0 }),
    ];
    const anchors = [anchor(1, 500, "v"), anchor(2, 5_500, "v")];
    const result = resolveComposite(spans, anchors, 800, Number.POSITIVE_INFINITY);
    expect(result.layers[0]!.anchor.index).toBe(1);
  });
});
