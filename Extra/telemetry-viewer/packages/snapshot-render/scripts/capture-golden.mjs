/**
 * Captures render goldens from the live standalone viewer page — the
 * "side-by-side check" of the P5 extraction (plan §5.4/§11-P5).
 *
 * One-off harness: loads `Extra/snapshot-viewer/index.html` (minus external
 * font links) into jsdom, evaluates the vendored js-yaml and `viewer.js`
 * exactly like a browser would, applies `fixtures/sample.yaml` through the
 * page's own pipeline (`applySnapshot`), and dumps
 *
 *   - the replica-mode stage DOM (a per-node signature tree),
 *   - the flex-mode stage DOM,
 *   - the status bar + tree text (they ride the shared normalization),
 *
 * into `test/fixtures/golden/*.json`. Those files were first captured from
 * the *pre-extraction* viewer (git history: the commit before P5's
 * `viewer.js` refactor), so the parity spec proves the shared-package
 * rendering is DOM-identical to the original standalone code.
 *
 * Regeneration (`node scripts/capture-golden.mjs`) always recurses through
 * viewer.js — if the output changes, a render behavior change happened and
 * the new golden must be reviewed consciously, never blindly accepted.
 *
 * Timestamps from the YAML document are parsed into Date objects by the
 * vendored js-yaml (YAML 1.1 timestamps), so the status line prints in the
 * process locale — run with `TZ=UTC` (the capture and the package test
 * script both pin it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { JSDOM } from "jsdom";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // packages/snapshot-render
const toolRoot = join(pkgDir, "..", ".."); // telemetry-viewer/
const extraRoot = join(toolRoot, ".."); // Extra/
const viewerDir = join(extraRoot, "snapshot-viewer");

const read = (path) => readFileSync(join(viewerDir, path), "utf8");

const indexHtml = read("index.html")
  // strip the Google-Fonts links; jsdom must not reach the network
  .replace(/^ *(<link [^>]*fonts\.g[^>]*>|<link rel="preconnect"[^>]*>)$/gim, "");

const dom = new JSDOM(indexHtml, {
  url: "http://localhost:8000/snapshot-viewer/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
});
const { window } = dom;

/** Run a snippet exactly like a classic inline <script> tag (page scope). */
function runInline(source, dom, document) {
  const script = document.createElement("script");
  script.textContent = source;
  document.body.appendChild(script);
}
runInline(read("vendor/js-yaml.min.js"), dom, window.document);
runInline(read("viewer.js"), dom, window.document);

// Apply the sample through the page's own pipeline (same as the sample button minus fetch).
window.applySnapshot(window.jsyaml.load(read("fixtures/sample.yaml")), "fixtures/sample.yaml");

/** Per-node signature tree — everything the viewer's rendering decides. */
function describe(el) {
  const node = {
    tag: el.tagName.toLowerCase(),
    class: el.className,
    style: el.getAttribute("style") ?? "",
    text: el.textContent,
  };
  const dataId = el.getAttribute("data-id");
  if (dataId !== null) node.dataId = dataId; // window.MduSnapshotRender adds data-node-id too (tool-only concern, deliberately not asserted here)
  const children = [...el.children].map(describe);
  if (children.length > 0) node.children = children;
  return node;
}

function capture() {
  const stage = window.document.querySelector("#stage");
  return {
    stageClass: stage.className,
    stageStyle: stage.getAttribute("style") ?? "",
    nodes: [...stage.children].map(describe),
    status: window.document.querySelector("#status").textContent,
  };
}

const golden = {
  _note: [
    "captured by packages/snapshot-render/scripts/capture-golden.mjs from Extra/snapshot-viewer",
    "sample fixture: fixtures/sample.yaml — replica + flex modes of the ORIGINAL viewer.js (pre-P5 extraction).",
  ],
  replica: capture(),
};

window.toggleMode("flex");
golden.flex = capture();

const outDir = join(pkgDir, "test", "fixtures", "golden");
writeFileSync(join(outDir, "sample.json"), JSON.stringify(golden, null, 2) + "\n");
console.log(`goldens captured: replica ${golden.replica.nodes.length} nodes, flex ${golden.flex.nodes.length} nodes`);

