#!/usr/bin/env node
/*
 * Validate the hand-written telemetry documentation against the repo.
 *
 *   node docs/telemetry/check-links.mjs
 *
 * It loads every data.*.js file in a tiny browser-like VM, then checks:
 *  - unique node ids and valid edge/timeline endpoints
 *  - every cited file exists and contains the cited symbol
 *  - every documented route exists in the viewer API
 *  - every documented config field exists in TelemetryConfig.cs
 *  - every ADR file exists
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const fail = [];
const warn = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

const sandbox = { window: {}, console };
vm.createContext(sandbox);
for (const file of [
  "data.js",
  "data.nodes.runtime.js",
  "data.nodes.viewer.js",
  "data.edges.js",
  "data.timelines.js",
  "data.reference.js",
]) {
  const full = path.join(here, file);
  if (!fs.existsSync(full)) {
    fail.push(`missing data file: docs/telemetry/${file}`);
    continue;
  }
  try {
    vm.runInContext(fs.readFileSync(full, "utf8"), sandbox, { filename: file });
  } catch (error) {
    fail.push(`cannot evaluate ${file}: ${error.message}`);
  }
}

const doc = sandbox.window.TELEMETRY_DOC;
if (!doc) {
  console.error("TELEMETRY_DOC was not created");
  process.exit(1);
}

const nodes = doc.nodes || [];
const edges = doc.edges || [];
const nodeIds = new Set();
const planeIds = new Set((doc.planes || []).map((plane) => plane.id));
const scenarioIds = new Set((doc.scenarios || []).map((scenario) => scenario.id));

for (const node of nodes) {
  if (!node.id) fail.push("node without id");
  else if (nodeIds.has(node.id)) fail.push(`duplicate node id: ${node.id}`);
  else nodeIds.add(node.id);
  if (!planeIds.has(node.plane)) fail.push(`node ${node.id} uses unknown plane ${node.plane}`);
  for (const file of node.files || []) {
    if (!exists(file.path)) {
      fail.push(`node ${node.id}: missing file ${file.path}`);
      continue;
    }
    if (file.symbol) {
      const content = read(file.path);
      if (!content.includes(file.symbol)) {
        fail.push(`node ${node.id}: symbol not found in ${file.path}: ${file.symbol}`);
      }
    }
  }
}

for (const edge of edges) {
  if (!nodeIds.has(edge.from)) fail.push(`edge from unknown node: ${edge.from}`);
  if (!nodeIds.has(edge.to)) fail.push(`edge to unknown node: ${edge.to}`);
  for (const scenario of edge.scenarios || []) {
    if (!scenarioIds.has(scenario)) fail.push(`edge ${edge.from}->${edge.to} uses unknown scenario ${scenario}`);
  }
}

for (const [tabId, timeline] of Object.entries(doc.timelines || {})) {
  const lanes = new Set((timeline.lanes || []).map((lane) => lane.id));
  for (const variant of timeline.variants || []) {
    for (const item of variant.items || []) {
      if (!lanes.has(item.lane)) fail.push(`timeline ${tabId}/${variant.id}: unknown lane ${item.lane}`);
      for (const component of item.components || []) {
        if (!nodeIds.has(component)) {
          fail.push(`timeline ${tabId}/${variant.id}/${item.id}: unknown component ${component}`);
        }
      }
    }
  }
}

for (const item of doc.reference?.routes || []) {
  const haystack = [read("Extra/telemetry-viewer/server/src/api/app.ts"), read("Extra/telemetry-viewer/server/src/api/sourcesConfig.ts")].join("\n");
  if (!haystack.includes(`"${item.path}"`)) {
    fail.push(`route not found in server API: ${item.method} ${item.path}`);
  }
}

const telemetryConfig = read("Assets/Runtime/Telemetry/TelemetryConfig.cs");
for (const item of doc.reference?.config || []) {
  if (!telemetryConfig.includes(item.field)) {
    fail.push(`config field not found in TelemetryConfig.cs: ${item.field}`);
  }
}

for (const adr of doc.reference?.adrs || []) {
  if (!exists(adr.file)) fail.push(`ADR file missing: ${adr.file}`);
}

for (const file of doc.reference?.files || []) {
  if (!exists(file.path)) warn.push(`source-map path missing: ${file.path}`);
}

const html = read("docs/telemetry/index.html");
for (const script of html.matchAll(/<script src="([^"]+)"/g)) {
  if (!exists(path.join("docs/telemetry", script[1]))) fail.push(`index.html references missing script: ${script[1]}`);
}
for (const link of html.matchAll(/<link([^>]*)>/g)) {
  const attributes = link[1];
  const href = (attributes.match(/href="([^"]+)"/) || [])[1];
  if (!href) continue;
  const rel = (attributes.match(/rel="([^"]+)"/) || [])[1] || "asset";
  if (!exists(path.join("docs/telemetry", href))) fail.push(`index.html references missing ${rel}: ${href}`);
}

if (warn.length) {
  console.warn("Warnings:");
  for (const item of warn) console.warn(`  - ${item}`);
}
if (fail.length) {
  console.error(`\n${fail.length} documentation check(s) failed:`);
  for (const item of fail) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(`OK: ${nodes.length} nodes, ${edges.length} edges, ${Object.keys(doc.timelines || {}).length} timelines, ${(doc.reference?.routes || []).length} routes, ${(doc.reference?.config || []).length} config fields.`);
