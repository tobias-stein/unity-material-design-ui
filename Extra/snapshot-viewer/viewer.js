/* UI Snapshot Viewer — parses YAML snapshots exported by Unity
   (Assets/Runtime/Telemetry) and renders them with Material Design styling
   in two modes: absolute "replica" (pixel-faithful) and semantic "flex".
   No build step; js-yaml is vendored under vendor/. */

'use strict';

/* ------------------------------------------------------------------ state */

const state = {
  snapshot: null,
  sourceName: null,
  byId: new Map(),
  childrenOf: new Map(),   // id -> [childId] (derived from parentId/siblingIndex)
  rootId: null,
  palette: {},             // ColorRole -> hex
  mode: 'replica',
  selectedId: null,
  scale: 1,
  warning: null,
};

const $ = (sel) => document.querySelector(sel);

/* ----------------------------------------------------------------- loading */

async function loadFile(file) {
  setStatus(`Loading ${file.name}…`);
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let text;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder('utf-8').decode(buffer);
    }
    applySnapshot(window.jsyaml.load(text), file.name);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message}`, 'error');
  }
}

function applySnapshot(snapshot, sourceName) {
  let warning = null;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('not a YAML mapping');
  }
  if (snapshot.schemaVersion == null) {
    warning = 'missing schemaVersion — best-effort render';
  } else if (snapshot.schemaVersion > 1) {
    warning = `schemaVersion ${snapshot.schemaVersion} newer than supported (1) — best-effort render`;
  }
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) {
    throw new Error('snapshot contains no nodes');
  }

  state.snapshot = snapshot;
  state.sourceName = sourceName;
  state.warning = warning;
  state.selectedId = null;
  state.byId = new Map();
  state.childrenOf = new Map();

  for (const node of snapshot.nodes) {
    if (node.id == null) node.id = `anon:${state.byId.size}`;
    if (state.byId.has(node.id)) node.id = `${node.id}#${state.byId.size}`; // defensive de-dup
    state.byId.set(node.id, node);
  }

  // derive hierarchy from parentId + siblingIndex (robust against missing `children`)
  const roots = [];
  for (const node of snapshot.nodes) {
    if (node.parentId != null && state.byId.has(node.parentId)) {
      let list = state.childrenOf.get(node.parentId);
      if (!list) state.childrenOf.set(node.parentId, list = []);
      list.push(node.id);
    } else {
      roots.push(node.id);
    }
  }
  for (const list of state.childrenOf.values()) {
    list.sort((a, b) => (state.byId.get(a).siblingIndex || 0) - (state.byId.get(b).siblingIndex || 0));
  }
  state.rootId = roots[0] || snapshot.nodes[0].id;
  if (roots.length > 1) {
    // orphan nodes: attach visually under root so nothing disappears
    for (const id of roots.slice(1)) {
      const node = state.byId.get(id);
      node.parentId = state.rootId;
      state.childrenOf.get(state.rootId).push(id);
    }
  }

  const geometry = geometryWarning(snapshot);
  if (geometry) warning = warning ? `${warning} · ${geometry}` : geometry;

  state.palette = {};
  if (snapshot.theme && snapshot.theme.palette) {
    for (const [role, value] of Object.entries(snapshot.theme.palette)) {
      state.palette[role.toLowerCase()] = value; // raw; roleColor() normalizes via hex()
    }
  }

  injectTheme(snapshot.theme);
  buildTree();
  render();
  $('#empty').classList.add('hidden');
  updateStatus(null);
  if (warning) setStatus(`⚠ ${warning}`, 'warn');
}

function injectTheme(theme) {
  const rootStyle = document.documentElement.style;
  if (!theme || !theme.palette) return;
  for (const [role, hexValue] of Object.entries(theme.palette)) {
    const value = hex(hexValue);
    if (!value) continue;
    rootStyle.setProperty(`--m3-${camel(role)}`, value);
    rootStyle.setProperty(`--m3-${kebab(role)}`, value); // viewer.css uses kebab-case tokens
  }
}

/**
 * Detects the classic "captured before layout ran" snapshot: most active nodes
 * sit outside the root rect (Unity layout not applied yet → prefab-authored
 * rects), which renders as an essentially empty stage.
 */
function geometryWarning(snapshot) {
  const root = state.byId.get(state.rootId);
  const r = root && root.rect;
  if (!r || !r.width || !r.height) return null;

  let outOfBounds = 0;
  let active = 0;
  for (const node of snapshot.nodes) {
    if (node.active === false || !node.rect) continue;
    active++;
    const rect = node.rect;
    const outside = rect.x >= r.width || rect.y >= r.height
      || rect.x + rect.width <= 0 || rect.y + rect.height <= 0;
    if (outside) outOfBounds++;
  }

  if (active > 0 && outOfBounds / active > 0.2) {
    return `${outOfBounds} of ${active} nodes lie outside the root — capture likely ran before layout was applied`;
  }
  return null;
}

/**
 * Normalizes a snapshot color into CSS "#RRGGBB[AA]".
 *
 * Tolerates three producer quirks:
 *  - hex emitted without '#' (older exports: "BFC2FF")
 *  - YAML parsing digit-only hex as a number ("454654" → 454654, "000000" → 0)
 *  - hex YAML parsed as float/scientific ("3E2652" → Infinity) — unrecoverable,
 *    returns null so callers fall back to palette defaults.
 */
function hex(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    value = String(value);
  }
  if (typeof value !== 'string') return null;
  value = value.trim();
  if (value.startsWith('#')) value = value.slice(1);
  if (!/^[0-9a-f]+$/i.test(value)) return null;
  if (value.length < 6) value = value.padStart(6, '0'); // leading zeros lost to YAML int parsing
  return `#${value}`;
}

/** Alpha of a normalized hex color: 1 for #RRGGBB, the AA channel for #RRGGBBAA. */
function colorAlpha(value) {
  const c = hex(value);
  if (!c) return 0;
  return c.length >= 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1;
}

/* ---------------------------------------------------------------- rendering */

function render() {
  const stage = $('#stage');
  stage.innerHTML = '';
  stage.className = state.mode === 'flex' ? 'flex' : 'replica';
  if ($('#debugOutline').checked) stage.classList.add('show-layout-outlines');

  const root = state.byId.get(state.rootId);
  const width = (root.rect && root.rect.width) || 800;
  const height = (root.rect && root.rect.height) || 600;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;

  if (state.mode === 'replica') {
    // flat, root-relative absolute positioning in export order (parents first)
    for (const node of state.snapshot.nodes) {
      stage.appendChild(createNodeEl(node));
    }
  } else {
    buildFlexNode(root, stage, true);
  }

  fitStage();
}

function buildFlexNode(node, parentEl, isRoot) {
  const el = createNodeEl(node);

  const rect = node.rect || { width: 0, height: 0 };
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  if (!isRoot) el.style.flex = '0 0 auto';

  if (node.layout) {
    const dir = node.layout.type === 'Horizontal' ? 'row' : 'column';
    el.style.display = 'flex';
    el.style.flexDirection = dir;
    if (node.layout.spacing > 0) el.style.gap = `${node.layout.spacing}px`;
    const p = node.layout;
    el.style.padding =
      `${p.paddingTop || 0}px ${p.paddingRight || 0}px ${p.paddingBottom || 0}px ${p.paddingLeft || 0}px`;
    Object.assign(el.style, alignmentStyles(node.layout.childAlignment, dir));

    // controlled dimensions stretch instead of using the fixed runtime size
    if (dir === 'column' && node.layout.controlChildWidth) el.style.width = 'auto';
    if (dir === 'row' && node.layout.controlChildHeight) el.style.height = 'auto';
  }

  if (node.layoutElement) {
    const le = node.layoutElement;
    if (le.minWidth > 0) el.style.minWidth = `${le.minWidth}px`;
    if (le.minHeight > 0) el.style.minHeight = `${le.minHeight}px`;
    if (le.preferredHeight > 0) el.style.height = `${le.preferredHeight}px`;
    if (le.preferredWidth > 0 && !node.layout) el.style.width = `${le.preferredWidth}px`;
  }

  if (node.contentSizeFitter) {
    if (/Preferred|MinAndMax/.test(node.contentSizeFitter.horizontalMode || '')) el.style.width = 'fit-content';
    if (/Preferred|MinAndMax/.test(node.contentSizeFitter.verticalMode || '')) el.style.height = 'fit-content';
  }

  parentEl.appendChild(el);

  for (const childId of state.childrenOf.get(node.id) || []) {
    buildFlexNode(state.byId.get(childId), el, false);
  }
  return el;
}

function alignmentStyles(alignment, dir) {
  const match = /^(Upper|Middle|Lower)(Left|Center|Right)$/.exec(alignment || '');
  if (!match) return {};
  const [, vertical, horizontal] = match;
  const pick = (part) => (part === 'Center' ? 'center' : (part === 'Left' || part === 'Upper') ? 'flex-start' : 'flex-end');
  return dir === 'row'
    ? { justifyContent: pick(horizontal), alignItems: pick(vertical) }
    : { justifyContent: pick(vertical), alignItems: pick(horizontal) };
}

/* ------------------------------------------------------------ node factory */

function createNodeEl(node) {
  const type = typeBaseName(node.type);
  const el = document.createElement('div');
  el.className = `node kind-${node.kind || 'layout'} type-${slug(type)}`;
  el.dataset.id = node.id;
  el.classList.add('selectable');
  if (node.active === false) el.style.display = 'none';

  // geometry (replica mode; flex mode overrides with its own sizing)
  if (state.mode === 'replica' && node.rect) {
    el.style.left = `${node.rect.x}px`;
    el.style.top = `${node.rect.y}px`;
    el.style.width = `${node.rect.width}px`;
    el.style.height = `${node.rect.height}px`;
    el.style.zIndex = String(zIndexOf(node));
  }

  const resolved = node.resolved || {};
  const background = backgroundFor(node);
  if (background) el.style.background = background;
  applyOutline(el, resolved);
  if (resolved.opacity != null && resolved.opacity !== 1) el.style.opacity = String(resolved.opacity);
  if (resolved.cornerRadius > 0) el.style.borderRadius = `${resolved.cornerRadius}px`;
  else if (type === 'Button') applyButtonShape(el, node);

  if (node.isView) {
    el.style.background = background || paletteColor('Background') || 'transparent';
  }

  switch (type) {
    case 'Text': applyTextStyles(el, node); break;
    case 'Icon': applyIconStyles(el, node); break;
    case 'Button': applyButtonStyles(el, node); break;
    case 'Switch': applySwitch(el, node); break;
    case 'Chip': el.classList.add('type-chip'); break;
    case 'ListItem': el.classList.add('type-listitem'); break;
    case 'AppBar': el.classList.add('type-appbar'); break;
    default: break;
  }

  if (node.kind === 'layout') el.classList.add('kind-layout');
  return el;
}

function zIndexOf(node) {
  // DOM order already yields correct stacking in replica mode; zIndex kept low
  // so .selected can override.
  return 1;
}

function applyTextStyles(el, node) {
  const resolved = node.resolved || {};
  const data = node.data || {};
  el.textContent = resolved.text != null ? resolved.text : (data.text != null ? data.text : '');

  const role = resolved.textRole || data.textRole;
  const style = role && state.snapshot.theme && state.snapshot.theme.typography
    ? state.snapshot.theme.typography[role] : null;

  // Instance truth first: resolved.fontSize is the actual TMP size (includes
  // per-prefab overrides); the theme role size is only the fallback.
  const effectiveFontSize = resolved.fontSize > 0
    ? resolved.fontSize
    : (style && style.fontSize > 0 ? style.fontSize : 0);
  if (effectiveFontSize > 0) el.style.fontSize = `${effectiveFontSize}px`;
  if (style) {
    // Baked SDF weight (resolved.fontWeight) is what Unity rendered — the theme
    // role weight is only a nominal request the single-weight SDF ignores.
    const bakedWeight = fontWeight(resolved.fontWeight);
    const weight = bakedWeight || fontWeight(style.fontWeight);
    if (weight) el.style.fontWeight = String(weight);
    // TMP applies characterSpacing in em-ish units (× fontSize × 0.01), not raw px.
    if (style.characterSpacing && effectiveFontSize > 0) {
      el.style.letterSpacing = `${style.characterSpacing * effectiveFontSize * 0.01}px`;
    }
    if (style.lineSpacing) el.style.lineHeight = String(1 + style.lineSpacing / 100);
  }

  // TMP wrapping/overflow are captured on data (TextData) — Unity renders
  // NoWrap labels on one line regardless of rect width; without this the CSS
  // default (pre-wrap) wraps them on browser-font metric drift.
  // Ellipsis: only clip when Unity itself truncated — i.e. its own text
  // measurement (resolved.textWidth, TMP preferredWidth) exceeds the rect.
  // The browser's Roboto can't match the SDF-baked glyph advances exactly
  // (±1–5px per string), which would otherwise show "..." on text Unity drew
  // in full.
  const wrapping = data.wrapping;
  const overflow = data.overflow;
  if (overflow === 'Ellipsis') {
    el.style.whiteSpace = 'nowrap';
    const rectWidth = node.rect ? node.rect.width : 0;
    const unityTruncated = resolved.textWidth != null
      ? resolved.textWidth > rectWidth + 0.5
      : true; // old snapshot without textWidth: preserve previous behavior
    if (unityTruncated) {
      el.style.overflow = 'hidden';
      el.style.textOverflow = 'ellipsis';
    } else {
      el.style.overflow = 'visible';
    }
  } else if (wrapping === 'NoWrap') {
    el.style.whiteSpace = 'nowrap';
    el.style.overflow = 'visible';
  } else {
    el.style.whiteSpace = 'pre-wrap';  // Standard / PreserveSpaces / unknown
  }

  // TMP HorizontalAlignmentOptions: None(0)/Left -> left; Center/Right/Justified.
  // The dump serializes enum names, but a raw 0/"0" (None) also appears.
  const align = data.horizontalAlignment;
  if (align === 'Center' || align === 32) el.style.textAlign = 'center';
  else if (align === 'Right' || align === 16) el.style.textAlign = 'right';
  else if (align === 'Justified' || align === 64) el.style.textAlign = 'justify';

  const color = hex(resolved.color)
    || roleColor(data.colorRole)
    || (data.colorRole === 'Customized' ? hex(data.customColor) : null)
    || paletteColor('OnSurface');
  if (color) el.style.color = color;
}

function applyIconStyles(el, node) {
  const symbol = (node.data && node.data.symbol) || {};
  if (symbol.code != null) el.textContent = String.fromCharCode(symbol.code);
  const size = node.rect ? Math.min(node.rect.width, node.rect.height) : 24;
  if (size > 0) el.style.fontSize = `${size}px`;
  el.style.fontVariationSettings = `'FILL' ${symbol.fill ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' ${size}`;
  const color = hex((node.resolved && node.resolved.color) || null)
    || roleColor(node.data && node.data.colorRole)
    || paletteColor('OnSurface');
  if (color) el.style.color = color;
}

function applyButtonStyles(el, node) {
  el.classList.add('type-button');
  const data = node.data || {};
  const style = data.style || 'Filled';
  const resolved = node.resolved || {};

  // True container paint is captured (SDF fill × ColorBlock tint, SDF outline) —
  // only fall back to style-variant palette guesses when the snapshot has none.
  const capturedBg = backgroundFor(node);
  const capturedOutline = !!(resolved.outlineColor && resolved.outlineWidth > 0
    && colorAlpha(resolved.outlineColor) > 0);

  let bg = null, fg = null;
  switch (style) {
    case 'Elevated':
      if (!capturedBg) bg = paletteColor('SurfaceContainerLow') || paletteColor('SurfaceContainer') || '#f6f2fa';
      fg = paletteColor('Primary') || '#6750a4';
      el.classList.add('style-elevated');
      break;
    case 'Tonal':
      if (!capturedBg) bg = paletteColor('SecondaryContainer') || '#e8def8';
      fg = paletteColor('OnSecondaryContainer') || '#1d192b';
      break;
    case 'Outlined':
      fg = paletteColor('Primary') || '#6750a4';
      if (!capturedOutline && !capturedBg) {
        el.style.borderColor = paletteColor('Outline') || '#79747e';
        el.style.borderWidth = '1px';
      }
      break;
    case 'Text':
      fg = paletteColor('Primary') || '#6750a4';
      break;
    case 'Filled':
    default:
      if (!capturedBg) bg = paletteColor('Primary') || '#6750a4';
      fg = paletteColor('OnPrimary') || '#ffffff';
      break;
  }
  if (bg) el.style.background = bg;
  if (fg) el.style.color = fg;
  if (data.enabled === false) el.style.opacity = '0.38';

  // Label/icon: only synthesize when the snapshot has no real child nodes
  // (the live UI always uses child Text/Icon components).
  const hasRealChildren = (state.childrenOf.get(node.id) || []).length > 0;

  // label
  if (!hasRealChildren && data.showLabel !== false && data.text) {
    const label = document.createElement('span');
    label.textContent = data.text;
    const role = (node.resolved && node.resolved.textRole) || data.textRole || 'LabelLarge';
    const typeStyle = state.snapshot.theme && state.snapshot.theme.typography
      ? state.snapshot.theme.typography[role] : null;
    if (typeStyle) {
      label.style.fontSize = `${typeStyle.fontSize || 14}px`;
      label.style.fontWeight = String(fontWeight(typeStyle.fontWeight) || 500);
      if (typeStyle.characterSpacing) label.style.letterSpacing = `${typeStyle.characterSpacing}px`;
    }
    el.appendChild(label);
  }

  // icon
  if (!hasRealChildren && data.showIcon !== false && data.icon && data.icon.code != null) {
    const icon = document.createElement('span');
    icon.className = 'node type-icon';
    icon.dataset.id = node.id; // clicks on the glyph select the whole button
    icon.textContent = String.fromCharCode(data.icon.code);
    const size = data.size && data.size !== 'MD' ? null : 24;
    const iconPx = iconSizeFor(data.size) || size || 24;
    icon.style.fontSize = `${iconPx}px`;
    icon.style.fontVariationSettings = `'FILL' ${data.icon.fill ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24`;
    icon.style.color = fg || '#fff';
    if (data.iconRight) el.appendChild(icon); else el.prepend(icon);
  }

  if (node.rect && node.rect.height > 0 && state.mode === 'replica') {
    el.style.height = `${node.rect.height}px`;
  }
}

function applyButtonShape(el, node) {
  const data = node.data || {};
  if (data.shape === 'Individual' && Array.isArray(data.individualCornerSize)) {
    const [tl, tr, br, bl] = data.individualCornerSize;
    el.style.borderRadius = `${tl}px ${tr}px ${br}px ${bl}px`;
  } else if (data.shape === 'Round') {
    el.style.borderRadius = '999px';
  } else {
    el.style.borderRadius = el.style.borderRadius || '4px';
  }
}

function applySwitch(el, node) {
  el.classList.add('type-switch');
  const data = node.data || {};
  if (data.checked || data.value || data.isOn) el.classList.add('checked');
  if ((state.childrenOf.get(node.id) || []).length) return; // real track/handle nodes render themselves
  el.innerHTML = '<span class="switch-track"><span class="switch-thumb"></span></span>';
}

function iconSizeFor(size) {
  const map = { XS: 16, SM: 20, MD: 24, LG: 32, XL: 40, XXL: 48, IconSm: 24, IconMd: 36, IconLg: 48 };
  return map[size] || null;
}

/* ------------------------------------------------------ style resolution */

/**
 * The node's painted container color, from captured component state only:
 *  - Image.color (StateLayers, Surfaces)          -> resolved.backgroundColor
 *  - SDF fill (Button/Chip/ListItem containers)   -> resolved.fillColor
 * Foreground color roles (Text/Icon colorRole) are never a background —
 * role-based guessing here used to paint text-colored boxes behind text.
 */
function backgroundFor(node) {
  const resolved = node.resolved || {};
  for (const value of [resolved.backgroundColor, resolved.fillColor]) {
    if (value && colorAlpha(value) > 0) return hex(value);
  }
  return null;
}

/** SDF outline captured by the exporter (Button/Chip outlined shapes). */
function applyOutline(el, resolved) {
  if (!resolved || !resolved.outlineColor || !(resolved.outlineWidth > 0)) return;
  const color = hex(resolved.outlineColor);
  if (!color || colorAlpha(color) <= 0) return;
  el.style.borderWidth = `${resolved.outlineWidth}px`;
  el.style.borderStyle = 'solid';
  el.style.borderColor = color;
}

function roleColor(role) {
  if (!role || role === 'Customized') return null;
  return hex(state.palette[String(role).toLowerCase()] || null);
}

function paletteColor(role) {
  return roleColor(role);
}

function fontWeight(name) {
  const map = {
    Thin: 100, ExtraLight: 200, UltraLight: 200, Light: 300, Normal: 400, Regular: 400,
    Medium: 500, SemiBold: 600, Demi: 600, Bold: 700, Heavy: 800, ExtraBold: 800, Black: 900,
  };
  return map[name] || null;
}

/* ------------------------------------------------------------------- tree */

function buildTree() {
  const container = $('#tree');
  container.classList.remove('empty-state');
  container.innerHTML = '';

  const root = state.byId.get(state.rootId);
  const ul = document.createElement('ul');
  ul.appendChild(treeItem(root, 0));
  container.appendChild(ul);
}

function treeItem(node, depth) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.dataset.id = node.id;
  if (node.active === false) btn.classList.add('inactive');

  const dot = document.createElement('span');
  dot.className = `dot kind-${node.kind || 'layout'}`;
  const name = document.createElement('span');
  name.className = 'tname';
  name.textContent = node.name || typeBaseName(node.type);
  const type = document.createElement('span');
  type.className = 'ttype';
  type.textContent = typeBaseName(node.type);

  btn.append(dot, name, type);
  btn.addEventListener('click', () => select(node.id, true));
  li.appendChild(btn);

  const childIds = state.childrenOf.get(node.id) || [];
  if (childIds.length) {
    const ul = document.createElement('ul');
    for (const childId of childIds) ul.appendChild(treeItem(state.byId.get(childId), depth + 1));
    li.appendChild(ul);
  }
  return li;
}

/* -------------------------------------------------------------- inspector */

function select(id, scrollIntoView) {
  state.selectedId = id;
  document.querySelectorAll('#stage .node.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('#tree button.selected').forEach((el) => el.classList.remove('selected'));

  const node = state.byId.get(id);
  if (!node) return;

  const stageEl = document.querySelector(`#stage .node[data-id="${cssEscape(id)}"]`);
  if (stageEl) {
    stageEl.classList.add('selected');
    if (scrollIntoView) stageEl.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  const treeBtn = document.querySelector(`#tree button[data-id="${cssEscape(id)}"]`);
  if (treeBtn) {
    treeBtn.classList.add('selected');
    if (scrollIntoView) treeBtn.scrollIntoView?.({ block: 'nearest' });
  }
  renderInspector(node);
}

function deselect() {
  state.selectedId = null;
  document.querySelectorAll('.node.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('#tree button.selected').forEach((el) => el.classList.remove('selected'));
  const body = $('#inspectorBody');
  body.className = 'inspector empty-state';
  body.textContent = 'Select an element to inspect its id, roles, layout and data.';
}

function renderInspector(node) {
  const body = $('#inspectorBody');
  body.className = 'inspector';
  const sections = [];

  const identity = [['id', node.id], ['kind', node.kind], ['name', node.name],
    ['type', node.type], ['parentId', node.parentId ?? '(root)'], ['siblingIndex', node.siblingIndex],
    ['active', node.active], ['view', node.isView ? (node.layer || 'yes') : null]];
  sections.push(section('Identity', identity));

  const geometry = [];
  if (node.rect) geometry.push(['rect', `${node.rect.x}, ${node.rect.y}  ${node.rect.width}×${node.rect.height}`]);
  if (node.rectLocal) geometry.push(['rectLocal', `${node.rectLocal.x}, ${node.rectLocal.y}  ${node.rectLocal.width}×${node.rectLocal.height}`]);
  if (node.anchor) {
    geometry.push(['anchorMin/Max', `${node.anchor.anchorMinX},${node.anchor.anchorMinY} → ${node.anchor.anchorMaxX},${node.anchor.anchorMaxY}`]);
    geometry.push(['pivot', `${node.anchor.pivotX}, ${node.anchor.pivotY}`]);
    geometry.push(['anchoredPos', `${node.anchor.anchoredX}, ${node.anchor.anchoredY}`]);
  }
  if (node.contentSizeFitter) geometry.push(['contentSizeFitter', `${node.contentSizeFitter.horizontalMode} / ${node.contentSizeFitter.verticalMode}`]);
  if (geometry.length) sections.push(section('Geometry', geometry));

  if (node.layout) {
    const l = node.layout;
    sections.push(section('Layout', [
      ['type', l.type + (l.runtimeSwitchable ? ' (runtime-switchable)' : '')],
      ['padding', `${l.paddingTop} ${l.paddingRight} ${l.paddingBottom} ${l.paddingLeft}`],
      ['spacing', l.spacing],
      ['alignment', l.childAlignment],
      ['control size', `w:${l.controlChildWidth} h:${l.controlChildHeight}`],
      ['force expand', `w:${l.childForceExpandWidth} h:${l.childForceExpandHeight}`],
      ['reverse', l.reverseArrangement],
    ]));
  } else if (node.layoutElement) {
    const le = node.layoutElement;
    sections.push(section('LayoutElement', [
      ['min', `${le.minWidth} × ${le.minHeight}`],
      ['preferred', `${le.preferredWidth} × ${le.preferredHeight}`],
      ['flexible', `${le.flexibleWidth} × ${le.flexibleHeight}`],
      ['ignoreLayout', le.ignoreLayout],
    ]));
  }

  const resolved = node.resolved;
  if (resolved) {
    const rows = [];
    if (resolved.textRole) rows.push(['textRole', resolved.textRole]);
    if (resolved.fontSize > 0) rows.push(['fontSize', resolved.fontSize]);
    if (resolved.fontName) rows.push(['font', resolved.fontName]);
    if (resolved.text != null) rows.push(['text', JSON.stringify(resolved.text)]);
    if (resolved.color) rows.push(['color', swatch(resolved.color)]);
    if (resolved.backgroundColor) rows.push(['background', swatch(resolved.backgroundColor)]);
    if (resolved.fillColor) rows.push(['fill', swatch(resolved.fillColor)]);
    if (resolved.outlineColor) rows.push(['outline', `${swatch(resolved.outlineColor)} ${resolved.outlineWidth != null ? resolved.outlineWidth + 'px' : ''}`]);
    if (resolved.opacity != null && resolved.opacity !== 1) rows.push(['opacity', resolved.opacity]);
    if (resolved.cornerRadius > 0) rows.push(['cornerRadius', resolved.cornerRadius]);
    if (resolved.colorRoles) {
      rows.push(['colorRoles', Object.entries(resolved.colorRoles)
        .map(([k, v]) => `<span class="chip">${escapeHtml(k)} → ${swatch(roleColor(v) || 'transparent')}${escapeHtml(v)}</span>`).join('')]);
    }
    if (rows.length) sections.push(section('Resolved', rows, true));
  }

  if (node.data && Object.keys(node.data).length) {
    const rows = Object.entries(node.data).map(([k, v]) => [k, formatValue(v)]);
    sections.push(section('Data', rows));
  }

  if (node.error) sections.push(section('Capture error', [['error', node.error]]));

  body.innerHTML = sections.join('');
}

function section(title, rows, raw) {
  const items = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div class="k">${escapeHtml(String(k))}</div><div class="v">${raw ? v : formatValue(v)}</div>`)
    .join('');
  return `<div class="section"><h3>${escapeHtml(title)}</h3><div class="kv">${items}</div></div>`;
}

function formatValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  if (typeof value === 'string' && /^#?[0-9a-f]{6,8}$/i.test(value)) return `${swatch(value)}${escapeHtml(value)}`;
  if (typeof value === 'boolean') return String(value);
  return escapeHtml(String(value));
}

function swatch(value) {
  return `<span class="swatch" style="background:${escapeHtml(hex(value) || 'transparent')}"></span>`;
}

/* ------------------------------------------------------------- chrome/UI */

function updateStatus(error) {
  const el = $('#status');
  el.className = 'status' + (error ? ` ${error.kind}` : '');
  if (error) { el.textContent = error.text; return; }

  const s = state.snapshot;
  if (!s) { el.textContent = 'No snapshot loaded'; return; }
  const view = s.view || {};
  const bits = [
    view.name || '(unnamed view)',
    view.type,
    `${s.nodes.length} nodes`,
    s.timestampUtc,
    s.theme ? (s.theme.isDark ? 'dark' : 'light') : null,
    state.sourceName,
  ].filter(Boolean);
  let text = bits.join('  ·  ');
  if (state.warning) text += `  ⚠ ${state.warning}`;
  el.textContent = text;
}

function setStatus(text, kind) {
  updateStatus({ text, kind: kind || '' });
}

function fitStage() {
  if (!state.snapshot) return;
  const stage = $('#stage');
  const wrap = $('#stageWrap');
  const root = state.byId.get(state.rootId);
  const width = (root.rect && root.rect.width) || 800;
  const height = (root.rect && root.rect.height) || 600;

  const availW = Math.max(wrap.clientWidth - 48, 100);
  const availH = Math.max(wrap.clientHeight - 48, 100);
  const scale = Math.min(availW / width, availH / height, 1.5);
  state.scale = scale;

  stage.style.zoom = scale;
  const badge = $('#zoomBadge');
  badge.classList.remove('hidden');
  badge.textContent = `${Math.round(scale * 100)}%`;
}

function toggleMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modeToggle button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  render();
  if (state.selectedId) select(state.selectedId, false);
}

/* ---------------------------------------------------------------- utils */

function typeBaseName(type) {
  if (!type) return 'Unknown';
  const base = type.split('.').pop() || type;
  return base.replace(/`\d+$/, '');
}

function slug(text) {
  return String(text).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function camel(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function kebab(text) {
  return String(text).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

/* ---------------------------------------------------------------- wiring */

function wire() {
  const fileInput = $('#fileInput');
  const open = () => fileInput.click();
  $('#openBtn').addEventListener('click', open);
  $('#emptyOpenBtn').addEventListener('click', open);
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  $('#sampleBtn').addEventListener('click', async () => {
    try {
      const response = await fetch('fixtures/sample.yaml');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applySnapshot(window.jsyaml.load(await response.text()), 'fixtures/sample.yaml');
    } catch (err) {
      setStatus('Could not load sample — serve this folder over HTTP (python3 -m http.server)', 'error');
    }
  });

  document.querySelectorAll('#modeToggle button').forEach((btn) => {
    btn.addEventListener('click', () => toggleMode(btn.dataset.mode));
  });

  $('#debugOutline').addEventListener('change', () => {
    $('#stage').classList.toggle('show-layout-outlines', $('#debugOutline').checked);
  });

  $('#stage').addEventListener('click', (event) => {
    const nodeEl = event.target.closest('.node');
    if (nodeEl && nodeEl.dataset.id) select(nodeEl.dataset.id, false);
    else deselect();
  });

  window.addEventListener('resize', fitStage);

  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    $('#dropOverlay').classList.remove('hidden');
  });
  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget == null) $('#dropOverlay').classList.add('hidden');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    $('#dropOverlay').classList.add('hidden');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') deselect();
  });
}

wire();
