/* UI Snapshot Viewer — dev-tool shell over the shared @mdu/snapshot-render
   package (Extra/telemetry-viewer/packages/snapshot-render). All rendering —
   replica DOM, flex re-layout, theme token injection, color/text-style
   resolution — lives in that package; this file keeps the tool chrome:
   file loading, tree + inspector, selection, status, wiring.

   The shared package is loaded as `window.MduSnapshotRender` from
   ../telemetry-viewer/packages/snapshot-render/dist/snapshot-render.global.js
   (single declared import — never vendor this code; see README).
   Snapshots are parsed client-side with the vendored js-yaml (vendor/). */

'use strict';

/* ------------------------------------------------------------------ state */

const render = window.MduSnapshotRender;
if (!render) throw new Error('shared render package missing — build @mdu/snapshot-render first (see README)');

const state = {
  snapshot: null,
  sourceName: null,
  byId: new Map(),
  childrenOf: new Map(),   // id -> [childId]
  rootId: null,
  palette: {},             // lowered ColorRole -> hex (inspector display)
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

/**
 * Loads a parsed YAML document: normalization (schema warnings, id fill,
 * hierarchy, geometry warning) and rendering both happen in the shared
 * package — this only maintains the tool state and chrome. Throws on
 * unusable input (same messages as before the package existed).
 */
function applySnapshot(rawSnapshot, sourceName) {
  state.snapshot = render.normalizeSnapshot(rawSnapshot);
  const snapshot = state.snapshot;
  state.sourceName = sourceName;
  state.warning = snapshot.warnings.length ? snapshot.warnings.join(' · ') : null;
  state.selectedId = null;
  state.byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  state.childrenOf = new Map(Object.entries(snapshot.childrenOf));
  state.rootId = snapshot.rootId;

  // Inspector display table (the renderers normalize their own palettes).
  state.palette = {};
  if (snapshot.theme && snapshot.theme.palette) {
    for (const [role, value] of Object.entries(snapshot.theme.palette)) {
      state.palette[String(role).toLowerCase()] = value; // raw; paletteColor() normalizes via hex()
    }
  }

  render.injectTheme(snapshot.theme, document.documentElement);
  buildTree();
  renderStage();
  $('#empty').classList.add('hidden');
  updateStatus(null);
  if (state.warning) setStatus(`⚠ ${state.warning}`, 'warn');
}

/* ---------------------------------------------------------------- rendering */

/**
 * Delegate rendering to the shared package. Stage interaction flags keep the
 * standalone contract: `.selectable` + `data-id` hooks and `z-index: 1`
 * stacking; the telemetry viewer renders the same snapshot without them.
 */
function renderStage() {
  const stage = $('#stage');
  stage.innerHTML = '';
  stage.className = state.mode;
  // layout-box outlines ride the outer stage (CSS rule is ancestor-scoped)
  if ($('#debugOutline').checked) stage.classList.add('show-layout-outlines');
  if (state.mode === 'replica') {
    render.buildReplicaStage(state.snapshot, stage, 'raw', {
      selectable: true,
      zIndex: true,
    });
  } else {
    render.buildFlexStage(state.snapshot, stage, { selectable: true });
  }
  fitStage();
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
  name.textContent = node.name || render.typeBaseName(node.type);
  const type = document.createElement('span');
  type.className = 'ttype';
  type.textContent = render.typeBaseName(node.type);

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
        .map(([k, v]) => `<span class="chip">${escapeHtml(k)} → ${swatch(render.paletteColor(state.palette, v) || 'transparent')}${escapeHtml(v)}</span>`).join('')]);
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
  return `<span class="swatch" style="background:${escapeHtml(render.hex(value) || 'transparent')}"></span>`;
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
  renderStage();
  if (state.selectedId) select(state.selectedId, false);
}

/* ---------------------------------------------------------------- utils */

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
      setStatus('Could not load sample — serve the Extra/ directory over HTTP (see README)', 'error');
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
