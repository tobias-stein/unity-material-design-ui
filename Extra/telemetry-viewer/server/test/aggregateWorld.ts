/**
 * Deterministic aggregate fixture world (P3): two sessions capturing the
 * *same logical menu* under different runtime `_id`s (the §2 identity
 * problem), a two-version drifted Dialog view for the divergence badge, and
 * an unresolvable ledger artifact for the snapshot-unavailable path.
 *
 * Everything is content-derived: snapshot hashes are the real sha256 of the
 * YAML bytes, so re-running this file always produces the same fixture.
 */
import { createHash } from "node:crypto";
import { dump as yamlDump } from "js-yaml";
import { parseLpDocuments } from "../src/sources/lp.js";
import type { RawEvent } from "../../src/domain.js";

export const SESSION_A = "sess-alpha0000000000000000000000000";
export const SESSION_B = "sess-beta00000000000000000000000000";
export const SESSION_D1 = "sess-dlgone00000000000000000000000";
export const SESSION_D2 = "sess-dlgtwo00000000000000000000000";

/** ids the events carry per session (unstable runtime `_id`s by design). */
export const ALIAS = {
  playA: "eAlp3",
  playB: "eBet3",
  switchA: "eAlp4",
  switchB: "eBet4",
  closeA: "eAlp5",
  okD1: "okD1",
  okD2: "okD2",
  cancelD2: "cancelD2",
} as const;

/** Hand-computed canonical keys (the aggregate must land exactly here). */
export const KEY = {
  play: "mdu.ui.MainMenu › BodyPanel › Play › mdu.ui.Button",
  switch: "mdu.ui.MainMenu › BodyPanel › ui:mdu.ui.Switch[1] › mdu.ui.Switch",
  close: "mdu.ui.MainMenu › Close, all › mdu.ui.Button",
  ok: "mdu.ui.Dialog › OK › mdu.ui.Button",
  cancel: "mdu.ui.Dialog › Cancel › mdu.ui.Button",
} as const;

interface NodeSpec {
  ref: string;
  parent?: string;
  name?: string;
  type: string;
  kind?: string;
  isView?: boolean;
  siblingIndex?: number;
  rect?: { x: number; y: number; width: number; height: number };
}

interface SnapshotSpec {
  file: string;
  tsMs: number;
  viewId: string;
  viewName: string;
  viewType: string;
  nodes: NodeSpec[];
  /** Written to the store? false ⇒ ledger-only artifact (unresolvable). */
  write?: boolean;
}

interface EventSpec {
  session: string;
  tMs: number;
  type: string;
  element?: string;
  elementType?: string;
  view?: string;
  viewId?: string;
  on?: boolean;
}

export const MAIN_NODES_A: NodeSpec[] = [
  { ref: "rAlp1", name: "MainMenu", type: "mdu.ui.MainMenu(Clone)", kind: "ui", isView: true, siblingIndex: 0, rect: { x: 0, y: 0, width: 800, height: 600 } },
  { ref: "pAlp2", parent: "rAlp1", name: "BodyPanel", type: "LayoutGroup", kind: "layout", siblingIndex: 0, rect: { x: 0, y: 72, width: 800, height: 500 } },
  { ref: ALIAS.playA, parent: "pAlp2", name: "Play", type: "mdu.ui.Button", kind: "ui", siblingIndex: 0, rect: { x: 10, y: 20, width: 120, height: 48 } },
  { ref: ALIAS.switchA, parent: "pAlp2", type: "mdu.ui.Switch", kind: "ui", siblingIndex: 1, rect: { x: 10, y: 78, width: 48, height: 28 } },
  { ref: ALIAS.closeA, parent: "rAlp1", name: "Close, all", type: "mdu.ui.Button", kind: "ui", siblingIndex: 1, rect: { x: 640, y: 550, width: 96, height: 40 } },
];

/** Session B: identical *tree*, different runtime ids (cross-session drift). */
const MAIN_NODES_B: NodeSpec[] = [
  { ref: "rBet1", name: "MainMenu", type: "mdu.ui.MainMenu(Clone)", kind: "ui", isView: true, siblingIndex: 0, rect: { x: 0, y: 0, width: 800, height: 600 } },
  { ref: "pBet2", parent: "rBet1", name: "BodyPanel", type: "LayoutGroup", kind: "layout", siblingIndex: 0, rect: { x: 0, y: 72, width: 800, height: 500 } },
  { ref: ALIAS.playB, parent: "pBet2", name: "Play", type: "mdu.ui.Button", kind: "ui", siblingIndex: 0, rect: { x: 10, y: 20, width: 120, height: 48 } },
  { ref: ALIAS.switchB, parent: "pBet2", type: "mdu.ui.Switch", kind: "ui", siblingIndex: 1, rect: { x: 10, y: 78, width: 48, height: 28 } },
  { ref: "eBet5", parent: "rBet1", name: "Close, all", type: "mdu.ui.Button", kind: "ui", siblingIndex: 1, rect: { x: 640, y: 550, width: 96, height: 40 } },
];

const DIALOG_V1: NodeSpec[] = [
  { ref: "dlgR1", name: "Dialog", type: "mdu.ui.Dialog(Clone)", kind: "ui", isView: true, siblingIndex: 0, rect: { x: 100, y: 100, width: 400, height: 220 } },
  { ref: ALIAS.okD1, parent: "dlgR1", name: "OK", type: "mdu.ui.Button", kind: "ui", siblingIndex: 0, rect: { x: 216, y: 160, width: 48, height: 40 } },
];

const DIALOG_V2: NodeSpec[] = [
  { ref: "dlgR2", name: "Dialog", type: "mdu.ui.Dialog(Clone)", kind: "ui", isView: true, siblingIndex: 0, rect: { x: 100, y: 100, width: 400, height: 220 } },
  { ref: ALIAS.okD2, parent: "dlgR2", name: "OK", type: "mdu.ui.Button", kind: "ui", siblingIndex: 0, rect: { x: 160, y: 160, width: 48, height: 40 } },
  { ref: ALIAS.cancelD2, parent: "dlgR2", name: "Cancel", type: "mdu.ui.Button", kind: "ui", siblingIndex: 1, rect: { x: 132, y: 160, width: 48, height: 40 } },
];

const SNAPSHOTS: SnapshotSpec[] = [
  { file: "UIDemoMainMenu-141500.yaml", tsMs: 1_000, viewId: "vid-main-1", viewName: "UIDemoMainMenu(Clone)", viewType: "mdu.ui.MainMenu(Clone)", nodes: MAIN_NODES_A },
  { file: "UIDemoMainMenu-141459.yaml", tsMs: 900, viewId: "vid-main-2", viewName: "UIDemoMainMenu(Clone)", viewType: "mdu.ui.MainMenu(Clone)", nodes: MAIN_NODES_B },
  { file: "Dialog-152000.yaml", tsMs: 2_000, viewId: "vid-dlg-1", viewName: "Dialog(Clone)", viewType: "mdu.ui.Dialog(Clone)", nodes: DIALOG_V1 },
  { file: "Dialog-153000.yaml", tsMs: 3_000, viewId: "vid-dlg-2", viewName: "Dialog(Clone)", viewType: "mdu.ui.Dialog(Clone)", nodes: DIALOG_V2 },
  // Ledger-recorded but never written: the snapshot-unavailable path.
  { file: "UIDemoMainMenu-141505.yaml.gz", tsMs: 3_000, viewId: "vid-main-1", viewName: "UIDemoMainMenu(Clone)", viewType: "mdu.ui.MainMenu(Clone)", nodes: MAIN_NODES_A, write: false },
];

const EVENTS: EventSpec[] = [
  // alpha: Play ×2, Switch ×1, ghost (element-missing), close, post-fake-snapshot click
  { session: SESSION_A, tMs: 600, type: "view_open", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-1" },
  { session: SESSION_A, tMs: 2_000, type: "click", element: ALIAS.playA, elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-1" },
  { session: SESSION_A, tMs: 2_100, type: "click", element: ALIAS.playA, elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-1" },
  { session: SESSION_A, tMs: 2_200, type: "toggle", element: ALIAS.switchA, elementType: "mdu.ui.Switch", on: true, view: "UIDemoMainMenu(Clone)", viewId: "vid-main-1" },
  { session: SESSION_A, tMs: 2_300, type: "click", element: "ghostDoesNotExist", elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-1" },
  { session: SESSION_A, tMs: 2_400, type: "close", element: ALIAS.closeA, elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-1" },
  // after the fake snapshot anchor: resolvable to nothing (snapshot-unavailable)
  { session: SESSION_A, tMs: 3_100, type: "click", element: ALIAS.playA, elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-1" },
  // beta: pre-snapshot toggle (no-snapshot), Play ×3, Switch on/off
  { session: SESSION_B, tMs: 610, type: "view_open", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-2" },
  { session: SESSION_B, tMs: 899, type: "toggle", element: ALIAS.switchB, elementType: "mdu.ui.Switch", on: false, view: "UIDemoMainMenu(Clone)", viewId: "vid-main-2" },
  { session: SESSION_B, tMs: 1_000, type: "click", element: ALIAS.playB, elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-2" },
  { session: SESSION_B, tMs: 1_050, type: "click", element: ALIAS.playB, elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-2" },
  { session: SESSION_B, tMs: 1_100, type: "click", element: ALIAS.playB, elementType: "mdu.ui.Button", view: "UIDemoMainMenu(Clone)", viewId: "vid-main-2" },
  { session: SESSION_B, tMs: 1_150, type: "toggle", element: ALIAS.switchB, elementType: "mdu.ui.Switch", on: true, view: "UIDemoMainMenu(Clone)", viewId: "vid-main-2" },
  { session: SESSION_B, tMs: 1_200, type: "toggle", element: ALIAS.switchB, elementType: "mdu.ui.Switch", on: false, view: "UIDemoMainMenu(Clone)", viewId: "vid-main-2" },
  // dialog v1: OK ×3
  { session: SESSION_D1, tMs: 1_600, type: "view_open", view: "Dialog(Clone)", viewId: "vid-dlg-1" },
  { session: SESSION_D1, tMs: 2_100, type: "click", element: ALIAS.okD1, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-1" },
  { session: SESSION_D1, tMs: 2_200, type: "click", element: ALIAS.okD1, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-1" },
  { session: SESSION_D1, tMs: 2_300, type: "click", element: ALIAS.okD1, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-1" },
  // dialog v2: OK ×4 + Cancel ×2 (hidden in mode A)
  { session: SESSION_D2, tMs: 2_600, type: "view_open", view: "Dialog(Clone)", viewId: "vid-dlg-2" },
  { session: SESSION_D2, tMs: 3_100, type: "click", element: ALIAS.okD2, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-2" },
  { session: SESSION_D2, tMs: 3_200, type: "click", element: ALIAS.okD2, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-2" },
  { session: SESSION_D2, tMs: 3_300, type: "click", element: ALIAS.okD2, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-2" },
  { session: SESSION_D2, tMs: 3_400, type: "click", element: ALIAS.okD2, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-2" },
  { session: SESSION_D2, tMs: 3_500, type: "click", element: ALIAS.cancelD2, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-2" },
  { session: SESSION_D2, tMs: 3_600, type: "click", element: ALIAS.cancelD2, elementType: "mdu.ui.Button", view: "Dialog(Clone)", viewId: "vid-dlg-2" },
];

const BASE_EPOCH_MS = 1_700_000_000_000;

function snapshotBytes(spec: SnapshotSpec): Buffer {
  const document = {
    schemaVersion: 2,
    timestampUtc: new Date(BASE_EPOCH_MS + spec.tsMs).toISOString(),
    app: { productName: "Unity-MaterialDesign-UI", sessionId: "unknown" },
    view: { id: spec.viewId, name: spec.viewName, type: spec.viewType },
    // Deliberately a *dark-seeded* palette: the aggregate client must ignore
    // captured themes and always render the default-light baseline.
    theme: {
      seedColor: "#101010",
      isDark: true,
      palette: { Primary: "#101010", OnPrimary: "#00FF00", Background: "#0A0A0A", Surface: "#111111" },
    },
    nodes: spec.nodes.map((node) => ({
      id: node.ref,
      ...(node.parent !== undefined ? { parentId: node.parent } : {}),
      ...(node.name !== undefined ? { name: node.name } : {}),
      type: node.type,
      kind: node.kind ?? "ui",
      siblingIndex: node.siblingIndex ?? 0,
      active: true,
      ...(node.isView === true ? { isView: true } : {}),
      ...(node.rect !== undefined ? { rect: node.rect } : {}),
    })),
  };
  return Buffer.from(yamlDump(document, { lineWidth: 400 }), "utf8");
}

export interface WorldSnapshot {
  file: string;
  bytes: Buffer;
  sha256: string;
  spec: SnapshotSpec;
}

export interface World {
  snapshots: WorldSnapshot[];
  /** All fixture sessions, parsed from the generated `.lp` text. */
  events: RawEvent[];
  lp: string;
}

export function buildWorld(): World {
  const parsed = parseLpDocuments([{ file: "world.lp", content: lpText() }]);
  return { snapshots: snapshotFiles(), events: parsed.events, lp: lpText() };
}

let lpCache: string | null = null;

export function lpText(): string {
  if (lpCache !== null) return lpCache;
  const lines: string[] = [];
  for (const session of [SESSION_A, SESSION_B, SESSION_D1, SESSION_D2]) {
    const startMs = BASE_EPOCH_MS + (session === SESSION_A ? 500 : session === SESSION_B ? 500 : session === SESSION_D1 ? 1_500 : 2_500);
    lines.push(`session,session=${session},type=start value=1i ${msNs(startMs)}`);
    for (const event of EVENTS) {
      if (event.session !== session) continue;
      const tags = [
        `session=${session}`,
        `type=${event.type}`,
        ...(event.view !== undefined ? [`view=${event.view}`] : []),
        ...(event.viewId !== undefined ? [`view_id=${event.viewId}`] : []),
        ...(event.element !== undefined ? [`element=${event.element}`] : []),
        ...(event.elementType !== undefined ? [`element_type=${event.elementType}`] : []),
      ].join(",");
      const fields: string[] = ["value=1i"];
      if (event.on !== undefined) fields.push(`on=${event.on ? "true" : "false"}`);
      lines.push(`ui_event,${tags} ${fields.join(",")} ${msNs(BASE_EPOCH_MS + event.tMs)}`);
    }
    for (const spec of SNAPSHOTS) {
      if (specTargets(spec) !== session) continue;
      const bytes = snapshotBytes(spec);
      const hash = sha256Of(bytes);
      const tags = `session=${session},view=${spec.viewName},view_id=${spec.viewId}`;
      const fields =
        `key="snapshots/2026/04/01/${spec.file}",hash="${hash}",nodes=1i,width=800,height=600,` +
        `owner="Unity-MaterialDesign-UI",platform="OSXEditor",screen="1728x1117"`;
      lines.push(`ui_snapshot_taken,${tags} ${fields} ${msNs(BASE_EPOCH_MS + spec.tsMs)}`);
    }
    lines.push(`session,session=${session},type=end value=1i ${msNs(BASE_EPOCH_MS + 60_000)}`);
  }
  lpCache = `${lines.join("\n")}\n`;
  return lpCache;
}

/** The session a snapshot spec's ledger point belongs to (its viewId maps). */
function specTargets(spec: SnapshotSpec): string {
  if (spec.viewId === "vid-main-1") return SESSION_A;
  if (spec.viewId === "vid-main-2") return SESSION_B;
  if (spec.viewId === "vid-dlg-1") return SESSION_D1;
  if (spec.viewId === "vid-dlg-2") return SESSION_D2;
  throw new Error(`unmapped snapshot spec ${spec.file}`);
}

export function snapshotFiles(): WorldSnapshot[] {
  return SNAPSHOTS.filter((spec) => spec.write !== false).map((spec) => {
    const bytes = snapshotBytes(spec);
    return { file: spec.file, bytes, sha256: sha256Of(bytes), spec };
  });
}

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function msNs(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}
