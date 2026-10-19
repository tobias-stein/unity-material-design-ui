/**
 * Flex re-layout — direct port of the standalone snapshot viewer's
 * `buildFlexNode` path: semantic reconstruction of the Unity layout from the
 * captured LayoutGroup / LayoutElement / ContentSizeFitter data
 * (flex-direction, gap, padding, child alignment, controlled dimensions).
 *
 * Sizing/style-operation order mirrors the original viewer.js exactly; DOM
 * parity is asserted by `test/standaloneParity.spec.ts` (flex goldens) — this
 * is the *single* implementation; the standalone page renders through it.
 */
import type { UISnapshot } from "./model.js";
import { createNodeElement, type NodeContext, type ReplicaRenderResult, type StageOptions } from "./replica.js";

/** Build (or rebuild) the flex re-layout stage for a snapshot. */
export function buildFlexStage(
  snapshot: UISnapshot,
  container: HTMLElement,
  options: StageOptions = {},
): ReplicaRenderResult {
  const stage = document.createElement("div");
  stage.className = "replica-stage";
  if (snapshot.warnings.length > 0) stage.classList.add("has-warnings");
  if (options.stageClassName) stage.classList.add(options.stageClassName);

  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const root = byId.get(snapshot.rootId) ?? snapshot.nodes[0]!;
  const width = root.rect?.width ?? 800;
  const height = root.rect?.height ?? 600;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;

  const context: NodeContext = {
    snapshot,
    // flex mode keeps the captured theme (the standalone page has no
    // default-light toggle); keys are normalized case-insensitively inside
    // the node factory consumers below via the raw palette table.
    palette: normalizePalette(snapshot.theme?.palette ?? null),
    typography: snapshot.theme?.typography ?? null,
    options,
    geometry: "flow",
  };

  buildFlexNode(root, stage, true, byId, context);

  container.innerHTML = "";
  container.appendChild(stage);
  return { stage, rootId: snapshot.rootId, width, height };
}

/** Color-role table (lowercased lookup is done via `paletteColor`). */
function normalizePalette(palette: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!palette) return out;
  for (const [role, value] of Object.entries(palette)) out[role.toLowerCase()] = value;
  return out;
}

function buildFlexNode(
  node: UISnapshot["nodes"][number],
  parentEl: HTMLElement,
  isRoot: boolean,
  byId: Map<string, UISnapshot["nodes"][number]>,
  context: NodeContext,
): void {
  const el = createNodeElement(node, context);

  const rect = node.rect || { width: 0, height: 0 };
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  if (!isRoot) el.style.flex = "0 0 auto";

  if (node.layout) {
    const layout = node.layout;
    const dir = layout.type === "Horizontal" ? "row" : "column";
    el.style.display = "flex";
    el.style.flexDirection = dir;
    if (typeof layout.spacing === "number" && layout.spacing > 0) el.style.gap = `${layout.spacing}px`;
    el.style.padding =
      `${layout.paddingTop || 0}px ${layout.paddingRight || 0}px ${layout.paddingBottom || 0}px ${layout.paddingLeft || 0}px`;
    Object.assign(el.style, alignmentStyles(layout.childAlignment, dir));

    // controlled dimensions stretch instead of using the fixed runtime size
    if (dir === "column" && layout.controlChildWidth) el.style.width = "auto";
    if (dir === "row" && layout.controlChildHeight) el.style.height = "auto";
  }

  if (node.layoutElement) {
    const le = node.layoutElement;
    if (typeof le.minWidth === "number" && le.minWidth > 0) el.style.minWidth = `${le.minWidth}px`;
    if (typeof le.minHeight === "number" && le.minHeight > 0) el.style.minHeight = `${le.minHeight}px`;
    if (typeof le.preferredHeight === "number" && le.preferredHeight > 0) el.style.height = `${le.preferredHeight}px`;
    if (typeof le.preferredWidth === "number" && le.preferredWidth > 0 && !node.layout) el.style.width = `${le.preferredWidth}px`;
  }

  if (node.contentSizeFitter) {
    if (/Preferred|MinAndMax/.test(node.contentSizeFitter.horizontalMode ?? "")) el.style.width = "fit-content";
    if (/Preferred|MinAndMax/.test(node.contentSizeFitter.verticalMode ?? "")) el.style.height = "fit-content";
  }

  parentEl.appendChild(el);

  for (const childId of context.snapshot.childrenOf[node.id] ?? []) {
    const child = byId.get(childId);
    if (child) buildFlexNode(child, el, false, byId, context);
  }
}

function alignmentStyles(alignment: string | null | undefined, dir: string): Partial<CSSStyleDeclaration> {
  const match = /^(Upper|Middle|Lower)(Left|Center|Right)$/.exec(alignment ?? "");
  if (!match) return {};
  const [, vertical, horizontal] = match;
  const pick = (part: string | undefined): string =>
    part === "Center" ? "center" : part === "Left" || part === "Upper" ? "flex-start" : "flex-end";
  return dir === "row"
    ? { justifyContent: pick(horizontal), alignItems: pick(vertical) }
    : { justifyContent: pick(vertical), alignItems: pick(horizontal) };
}
