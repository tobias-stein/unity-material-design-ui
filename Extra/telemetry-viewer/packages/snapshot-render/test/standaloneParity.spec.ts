/**
 * Standalone-viewer parity — the P5 "side-by-side check" as a permanent test.
 *
 * Boots the real `Extra/snapshot-viewer` page (index.html + vendored js-yaml +
 * viewer.js) inside jsdom, with the *built* `@mdu/snapshot-render` IIFE bundle
 * loaded exactly like the page's classic script tag does, applies
 * `fixtures/sample.yaml` through the page's own `applySnapshot` pipeline, and
 * compares the replica + flex stage DOM against `fixtures/golden/sample.json`
 * — which was captured from the ORIGINAL viewer.js *before* the extraction
 * (see scripts/capture-golden.mjs; captured with TZ=UTC).
 *
 * Anything that regresses the standalone rendering ("Load sample", drag-drop,
 * flex mode) fails here — the golden pins operation order down to the
 * serialized inline `style` attribute.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// The goldens were captured with TZ=UTC (YAML timestamps become Date objects
// and the status line prints them locale-formatted) — pin the same zone here
// so the suite is env-independent.
process.env.TZ = "UTC";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolRoot = join(pkgDir, "..", ".."); // Extra/telemetry-viewer
const extraRoot = join(toolRoot, ".."); // Extra/
const viewerDir = join(extraRoot, "snapshot-viewer");

const read = (path: string): string => readFileSync(join(viewerDir, path), "utf8");

/** Per-node signature tree — everything the page's rendering decides. */
type NodeDescriptor = Record<string, unknown>;

function describeNode(el: Element): NodeDescriptor {
  const node: NodeDescriptor = {
    tag: el.tagName.toLowerCase(),
    class: el.className,
    style: el.getAttribute("style") ?? "",
    text: el.textContent,
  };
  const dataId = el.getAttribute("data-id");
  if (dataId !== null) node.dataId = dataId;
  const children = [...el.children].map(describeNode);
  if (children.length > 0) node.children = children;
  return node;
}

interface PageHarness {
  window: JSDOM["window"];
  replica: ReturnType<typeof capture>;
  flex: ReturnType<typeof capture>;
}

function capture(window: JSDOM["window"]) {
  // The package stages render into #stage; unwrap the shared stage element so
  // the comparison covers the rendered nodes, not the container the caller owns.
  const stage = window.document.querySelector("#stage")!;
  const inner = stage.querySelector(":scope > .replica-stage");
  const root: Element = inner ?? stage;
  return {
    nodes: [...root.children].map((el) => describeNode(el)),
    status: window.document.querySelector("#status")!.textContent,
  };
}

function bootViewer(): PageHarness {
  const dom = new JSDOM(
    read("index.html").replace(
      /^ *(<link [^>]*fonts\.g[^>]*>|<link rel="preconnect"[^>]*>)$/gim,
      "",
    ),
    { url: "http://localhost:8000/snapshot-viewer/", runScripts: "dangerously", pretendToBeVisual: true },
  );
  const { window } = dom;

  // Classic scripts in page order: vendored js-yaml, built shared package bundle, viewer chrome.
  for (const source of [
    read("vendor/js-yaml.min.js"),
    readFileSync(join(pkgDir, "dist", "snapshot-render.global.js"), "utf8"),
    read("viewer.js"),
  ]) {
    const script = window.document.createElement("script");
    script.textContent = source;
    window.document.body.appendChild(script);
  }

  // Load sample through the page's own pipeline (the sample button minus fetch).
  window.applySnapshot(window.jsyaml.load(read("fixtures/sample.yaml")), "fixtures/sample.yaml");
  return {
    window,
    replica: capture(window),
    flex: (window.toggleMode("flex"), capture(window)),
  };
}

const goldens = JSON.parse(readFileSync(join(pkgDir, "test", "fixtures", "golden", "sample.json"), "utf8")) as {
  replica: { nodes: NodeDescriptor[]; status: string };
  flex: { nodes: NodeDescriptor[]; status: string };
};

describe("standalone viewer parity (P5 side-by-side check)", () => {
  it("replica mode is DOM-identical to the pre-extraction viewer.js", () => {
    expect(harness.replica.nodes).toEqual(goldens.replica.nodes);
  });

  it("flex mode is DOM-identical to the pre-extraction viewer.js", () => {
    expect(harness.flex.nodes).toEqual(goldens.flex.nodes);
  });

  it("status line carries the same merged warnings state", () => {
    expect(harness.replica.status).toBe(goldens.replica.status);
    expect(harness.flex.status).toBe(goldens.flex.status);
  });

  it("every render symbol resolves from the shared bundle — no render code left in viewer.js", () => {
    const page = harness.window;
    expect(page.MduSnapshotRender).toBeTypeOf("object");
    for (const symbol of ["buildReplicaStage", "buildFlexStage", "normalizeSnapshot", "injectTheme", "paletteColor", "hex", "typeBaseName"]) {
      expect((page.MduSnapshotRender as Record<string, unknown>)[symbol], symbol).toBeTypeOf("function");
    }
    // The chrome file must not redefine what the package owns (grep-level
    // guard: render symbols live only in the package).
    const viewerSource = read("viewer.js");
    for (const banned of ["function hex(", "function typeBaseName(", "function roleColor(", "function paletteColor(", "function fontWeight(", "function injectTheme(", "function createNodeEl(", "function buildFlexNode(", "function applyTextStyles(", "function applyIconStyles(", "function applyButtonStyles(", "function applySwitch(", "function geometryWarning("]) {
      expect(viewerSource).not.toContain(banned);
    }
  });
});

// The page boots once for the whole suite (the load itself is the assertion
// that the declared import chain works end to end).
const harness = bootViewer();
