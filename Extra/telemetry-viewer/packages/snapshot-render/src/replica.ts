/**
 * Replica renderer — elastic port of the standalone snapshot viewer's
 * `createNodeEl` path (Extra/snapshot-viewer/viewer.js): flat, root-relative
 * absolute positioning in export order, Material 3 styling from the snapshot
 * itself (or the default-light baseline), text/icon settings from resolved +
 * theme data with the same TMP quirk handling.
 *
 * The caller owns the CSS rule set (class names are identical between the
 * standalone viewer and this package: .node, .type-text, .type-button, …).
 */
import type { SnapshotNode, SnapshotTextStyle, UISnapshot } from "./model.js";
import { hex, paletteColor, typeBaseName, fontWeight, colorAlpha } from "./colors.js";
import { resolveTheme } from "./appliedTheme.js";

export interface ReplicaRenderResult {
  /** The stage element (position: relative, sized to the snapshot root). */
  stage: HTMLDivElement;
  rootId: string;
  width: number;
  height: number;
}

/** Build (or rebuild) the full replica stage for a snapshot. */
export function buildReplicaStage(snapshot: UISnapshot, container: HTMLElement, mode: "default-light" | "raw" = "default-light"): ReplicaRenderResult {
  const stage = document.createElement("div");
  stage.className = `replica-stage${snapshot.schemaVersion === 1 ? " schema-v1" : ""}`;

  const theme = resolveTheme(mode, snapshot.theme ?? null);
  // Token normalization: snapshot palettes use PascalCase roles ("OnPrimary");
  // lookup is case-insensitive and lowercased both ways.
  const palette = normalizePaletteKeys(theme.palette);
  const typography = theme.typography ?? null;

  const root = snapshot.nodes.find((node) => node.id === snapshot.rootId) ?? snapshot.nodes[0]!;
  const width = root.rect?.width ?? 800;
  const height = root.rect?.height ?? 600;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.background = palette.background ?? "#fef7ff";

  if (snapshot.warnings.length > 0) {
    stage.classList.add("has-warnings");
  }

  for (const node of snapshot.nodes) {
    stage.appendChild(createNodeElement(node, snapshot, palette, typography));
  }

  container.innerHTML = "";
  container.appendChild(stage);
  return { stage, rootId: snapshot.rootId, width, height };
}

/** Scale-to-fit the stage into a viewport-sized wrapper (shared fit logic). */
export function fitReplica(stage: HTMLDivElement, wrap: HTMLElement): number {
  const width = stage.offsetWidth || 1;
  const height = stage.offsetHeight || 1;
  const availWidth = Math.max(wrap.clientWidth - 24, 60);
  const availHeight = Math.max(wrap.clientHeight - 24, 60);
  const scale = Math.min(availWidth / width, availHeight / height, 1.5);
  stage.style.zoom = String(scale);
  return scale;
}

function normalizePaletteKeys(palette: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!palette) return out;
  for (const [role, value] of Object.entries(palette)) {
    out[role.toLowerCase()] = value;
  }
  return out;
}

/* ---------------------------------------------------------------- node factory */

function createNodeElement(
  node: SnapshotNode,
  snapshot: UISnapshot,
  palette: Record<string, string>,
  typography: Exclude<UISnapshot["theme"], null | undefined>["typography"] | null,
): HTMLDivElement {
  const type = typeBaseName(node.type);
  const el = document.createElement("div");
  const slugType = type.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  el.className = `node kind-${node.kind || "layout"} type-${slugType}`;
  // Node id for tool-side overlays (aggregate heatmaps key by canonical
  // element → template node id). Harmless for the standalone viewer.
  el.dataset.nodeId = node.id;

  if (node.rect) {
    el.style.left = `${node.rect.x ?? 0}px`;
    el.style.top = `${node.rect.y ?? 0}px`;
    el.style.width = `${node.rect.width ?? 0}px`;
    el.style.height = `${node.rect.height ?? 0}px`;
  }

  const resolved = node.resolved ?? {};
  const background = backgroundFor(palette, resolved);
  if (background) el.style.background = background;
  applyOutline(el, palette, resolved);
  if (typeof resolved.opacity === "number" && resolved.opacity !== 1) el.style.opacity = String(resolved.opacity);
  if (typeof resolved.cornerRadius === "number" && resolved.cornerRadius > 0) el.style.borderRadius = `${resolved.cornerRadius}px`;
  else if (type === "Button") applyButtonShape(el, node);

  if (node.isView) {
    el.style.background = background || palette.background || "transparent";
  }

  switch (type) {
    case "Text": applyTextStyles(el, node, palette, typography); break;
    case "Icon": applyIconStyles(el, node, palette); break;
    case "Button": applyButtonStyles(el, node, snapshot, palette, typography); break;
    case "Switch": applySwitch(el, node, snapshot); break;
    case "Chip": el.classList.add("type-chip"); break;
    case "ListItem": el.classList.add("type-listitem"); break;
    case "AppBar": el.classList.add("type-appbar"); break;
    default: break;
  }

  if (node.kind === "layout") el.classList.add("kind-layout");
  if (node.active === false) el.style.display = "none";
  return el;
}

function backgroundFor(
  palette: Record<string, string>,
  resolved: SnapshotNode["resolved"] | null | undefined,
): string | null {
  if (!resolved) return null;
  for (const value of [resolved.backgroundColor, resolved.fillColor]) {
    if (value && colorAlpha(value) > 0) return hex(value) as string;
  }
  void palette;
  return null;
}

/** SDF outline captured by the exporter (Button/Chip outlined shapes). */
function applyOutline(
  el: HTMLElement,
  palette: Record<string, string>,
  resolved: SnapshotNode["resolved"] | null | undefined,
): void {
  void palette;
  if (!resolved) return;
  const width = resolved.outlineWidth;
  if (typeof width !== "number" || !(width > 0)) return;
  const color = hex(resolved.outlineColor);
  if (!color || colorAlpha(color) <= 0) return;
  el.style.borderWidth = `${width}px`;
  el.style.borderStyle = "solid";
  el.style.borderColor = color;
}

/* -------------------------------------------------------------------- text */

function applyTextStyles(
  el: HTMLElement,
  node: SnapshotNode,
  palette: Record<string, string>,
  typography: Record<string, SnapshotTextStyle> | null | undefined,
): void {
  const resolved = node.resolved ?? {};
  const data = (node.data ?? {}) as Record<string, unknown>;
  el.textContent = resolved.text != null ? String(resolved.text) : (data.text != null ? String(data.text) : "");

  const role = resolved.textRole || data.textRole;
  const style = role && typography ? typography[String(role)] ?? null : null;

  // Instance truth first: resolved.fontSize is the actual TMP size (includes
  // per-prefab overrides); the theme role size is only the fallback.
  const effectiveFontSize =
    (typeof resolved.fontSize === "number" && resolved.fontSize > 0 ? resolved.fontSize : 0) ||
    (style && style.fontSize && style.fontSize > 0 ? style.fontSize : 0);
  if (effectiveFontSize > 0) el.style.fontSize = `${effectiveFontSize}px`;
  if (style) {
    // Baked SDF weight (resolved.fontWeight) is what Unity rendered — the
    // theme role weight is only a nominal request the single-weight SDF ignores.
    const bakedWeight = fontWeight(resolved.fontWeight);
    const weight = bakedWeight || fontWeight(style.fontWeight);
    if (weight) el.style.fontWeight = String(weight);
    // TMP applies characterSpacing in em-ish units (× fontSize × 0.01).
    if (style.characterSpacing && effectiveFontSize > 0) {
      el.style.letterSpacing = `${style.characterSpacing * effectiveFontSize * 0.01}px`;
    }
    if (style.lineSpacing) el.style.lineHeight = String(1 + style.lineSpacing / 100);
  }

  // TMP wrapping/overflow: Unity renders NoWrap labels on one line regardless
  // of rect width; ellipsis only when Unity itself truncated (resolved
  // textWidth measurement exceeds the rect).
  const wrapping = data.wrapping;
  const overflow = data.overflow;
  if (overflow === "Ellipsis") {
    el.style.whiteSpace = "nowrap";
    const rectWidth = node.rect?.width ?? 0;
    const unityTruncated =
      typeof resolved.textWidth === "number" ? resolved.textWidth > rectWidth + 0.5 : true;
    if (unityTruncated) {
      el.style.overflow = "hidden";
      el.style.textOverflow = "ellipsis";
    } else {
      el.style.overflow = "visible";
    }
  } else if (wrapping === "NoWrap") {
    el.style.whiteSpace = "nowrap";
    el.style.overflow = "visible";
  } else {
    el.style.whiteSpace = "pre-wrap"; // Standard / PreserveSpaces / unknown
  }

  // TMP HorizontalAlignmentOptions: None(0)/Left → left; Center/Right/Justified.
  const align = data.horizontalAlignment;
  if (align === "Center" || align === 32) el.style.textAlign = "center";
  else if (align === "Right" || align === 16) el.style.textAlign = "right";
  else if (align === "Justified" || align === 64) el.style.textAlign = "justify";

  const color =
    hex(resolved.color) ||
    paletteColor(palette, role as string) ||
    (data.colorRole === "Customized" ? hex(data.customColor) : null) ||
    palette.onSurface ||
    "#1d1b20";
  if (color) el.style.color = color;
}

/* -------------------------------------------------------------------- icon */

function applyIconStyles(el: HTMLElement, node: SnapshotNode, palette: Record<string, string>): void {
  el.classList.add("type-icon");
  const symbol = ((node.data ?? {}) as { symbol?: { code?: unknown; fill?: unknown } }).symbol ?? {};
  if (symbol.code != null) el.textContent = String.fromCharCode(Number(symbol.code));
  const size = node.rect ? Math.min(node.rect.width ?? 24, node.rect.height ?? 24) : 24;
  if (size > 0) el.style.fontSize = `${size}px`;
  el.style.fontVariationSettings = `'FILL' ${symbol.fill ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' ${size}`;
  const color =
    hex(node.resolved?.color) || paletteColor(palette, String((node.data as Record<string, unknown>)?.colorRole ?? "")) || palette.onSurface || "#1d1b20";
  if (color) el.style.color = color;
}

/* ------------------------------------------------------------------ button */

function applyButtonStyles(
  el: HTMLElement,
  node: SnapshotNode,
  snapshot: UISnapshot,
  palette: Record<string, string>,
  typography: Record<string, SnapshotTextStyle> | null | undefined,
): void {
  el.classList.add("type-button");
  const data = (node.data ?? {}) as Record<string, unknown>;
  const style = typeof data.style === "string" ? data.style : "Filled";
  const resolved = node.resolved ?? {};

  // True container paint is captured (SDF fill × ColorBlock tint) — only
  // fall back to style-variant palette guesses when the snapshot has none.
  const capturedBg = backgroundFor(palette, resolved);
  const capturedOutline = !!(
    resolved.outlineColor &&
    typeof resolved.outlineWidth === "number" &&
    resolved.outlineWidth > 0 &&
    colorAlpha(resolved.outlineColor) > 0
  );

  let bg: string | null = null;
  let fg: string | null = null;
  switch (style) {
    case "Elevated":
      if (!capturedBg) bg = palette.surfacecontainerlow || palette.surfacecontainer || "#f6f2fa";
      fg = palette.primary || "#6750a4";
      el.classList.add("style-elevated");
      break;
    case "Tonal":
      if (!capturedBg) bg = palette.secondarycontainer || "#e8def8";
      fg = palette.onsecondarycontainer || "#1d192b";
      break;
    case "Outlined":
      fg = palette.primary || "#6750a4";
      if (!capturedOutline && !capturedBg) {
        el.style.borderColor = palette.outline || "#79747e";
        el.style.borderWidth = "1px";
      }
      break;
    case "Text":
      fg = palette.primary || "#6750a4";
      break;
    case "Filled":
    default:
      if (!capturedBg) bg = palette.primary || "#6750a4";
      fg = palette.onprimary || "#ffffff";
      break;
  }
  if (bg) el.style.background = bg;
  if (fg) el.style.color = fg;
  if (data.enabled === false) el.style.opacity = "0.38";

  // Label/icon: only synthesize when the snapshot has no real child nodes
  // (the live UI always uses child Text/Icon components).
  const hasRealChildren = (snapshot.childrenOf[node.id] ?? []).length > 0;

  if (!hasRealChildren && data.showLabel !== false && data.text) {
    const label = document.createElement("span");
    label.textContent = String(data.text);
    const role = resolved.textRole || data.textRole || "LabelLarge";
    const typeStyle = typography && typography[String(role)] ? typography[String(role)] : null;
    if (typeStyle) {
      label.style.fontSize = `${typeStyle.fontSize || 14}px`;
      label.style.fontWeight = String(fontWeight(typeStyle.fontWeight) || 500);
      if (typeStyle.characterSpacing) label.style.letterSpacing = `${typeStyle.characterSpacing}px`;
    }
    el.appendChild(label);
  }

  const icon = data.icon as { code?: unknown; fill?: unknown } | null | undefined;
  if (!hasRealChildren && data.showIcon !== false && icon && typeof icon.code === "number") {
    const iconFont = document.createElement("span");
    iconFont.className = "node type-icon";
    iconFont.textContent = String.fromCharCode(icon.code);
    const iconPx = iconSizeFor(data.size) || 24;
    iconFont.style.fontSize = `${iconPx}px`;
    iconFont.style.fontVariationSettings = `'FILL' ${icon.fill ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24`;
    iconFont.style.color = fg || "#fff";
    if (data.iconRight) el.appendChild(iconFont);
    else el.prepend(iconFont);
  }

  if (node.rect && (node.rect.height ?? 0) > 0) {
    el.style.height = `${node.rect.height}px`;
  }
}

function applyButtonShape(el: HTMLElement, node: SnapshotNode): void {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (data.shape === "Individual" && Array.isArray(data.individualCornerSize)) {
    const [tl, tr, br, bl] = data.individualCornerSize as number[];
    el.style.borderRadius = `${tl}px ${tr}px ${br}px ${bl}px`;
  } else if (data.shape === "Round") {
    el.style.borderRadius = "999px";
  } else {
    el.style.borderRadius = el.style.borderRadius || "4px";
  }
}

function iconSizeFor(size: unknown): number | null {
  const map: Record<string, number> = {
    XS: 16,
    SM: 20,
    MD: 24,
    LG: 32,
    XL: 40,
    XXL: 48,
    IconSm: 24,
    IconMd: 36,
    IconLg: 48,
  };
  const value = typeof size === "string" ? size : "MD";
  return map[value] ?? null;
}

/* ------------------------------------------------------------------ switch */

function applySwitch(el: HTMLElement, node: SnapshotNode, snapshot: UISnapshot): void {
  el.classList.add("type-switch");
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (data.checked || data.value || data.isOn) el.classList.add("checked");
  if ((snapshot.childrenOf[node.id] ?? []).length) return; // real track/handle nodes render themselves
  el.innerHTML = '<span class="switch-track"><span class="switch-thumb"></span></span>';
}
