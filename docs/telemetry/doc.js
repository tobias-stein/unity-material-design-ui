/* Telemetry architecture field guide — renderer and interactions. */
(function () {
  "use strict";

  var DATA = window.TELEMETRY_DOC;
  if (!DATA || !DATA.nodes || !DATA.edges) {
    document.body.innerHTML = "<p style='padding:2rem;font-family:sans-serif'>The telemetry documentation data failed to load.</p>";
    return;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  var MAP_W = 1660;
  var MAP_H = 1260;
  var PLANE_Y = 46;
  var PLANE_H = 1170;

  var nodeById = new Map(DATA.nodes.map(function (n) { return [n.id, n]; }));
  var planeById = new Map(DATA.planes.map(function (p) { return [p.id, p]; }));
  var edgeList = DATA.edges.map(function (e, i) { return Object.assign({ index: i }, e); });
  var adjacency = new Map(DATA.nodes.map(function (n) { return [n.id, new Set()]; }));
  edgeList.forEach(function (e) {
    if (adjacency.has(e.from)) adjacency.get(e.from).add(e.to);
    if (adjacency.has(e.to)) adjacency.get(e.to).add(e.from);
  });

  var NODE_SUBS = {
    pending: "write-ahead queue",
    archive: "per-session archive",
    influxdb: "bucket ui · v2",
    snapshotfiles: ".mds · .yaml[.gz]",
    manifestfile: "theme-manifest-<sid>.mds",
    retention: "count / size caps",
    api: "read-only JSON + SPA",
    sourceruntime: "mode · roots · imports",
    catalog: "union · wire dedupe",
    projection: "RawEvent → Session",
    timeline: "spans · rows · latest ≤ t",
    aggregate: "canonical · versions · CSV",
    snapshotservice: "resolve · chain · manifest",
    snapshotstore: "local FS · read-only",
    parse: "MDS v3 · YAML v2",
    spa: "hash router",
    sessionsview: "search · sources",
    timelineview: "NLE · playhead · live",
    aggregateview: "heatmap · modes A/B/C",
    render: "one renderer",
    replica: "stack by canvas layer",
    filmstrip: "lazy · bounded 4",
    builder: "walk · fingerprint",
    delta: "sparse chain member",
    exporter: "bytes → hash → ledger",
    timing: "one line per capture",
    layoutgate: "dirt gate + latch",
    thememanifest: "one theme per session",
    binarywriter: "string table · varints",
    lpserializer: "event → one line",
    outbox: "persist → send → ack",
    filesink: "session-*.lp append",
    eventstore: "resolve · prune",
    uiinteractions: "raise hub",
    eventcollector: "session · spans · ledger",
    snapshottriggers: "settle · debounce · pace",
    viewmanager: "visibility lifecycle",
    telemetryhost: "tick driver",
    telemetry: "config · bootstrap",
    uilayout: "dirt flag"
  };

  var NODE_TIMELINE = {
    uiinteractions: ["view", "cycle"],
    eventcollector: ["view", "cycle"],
    viewmanager: ["view", "popup"],
    snapshottriggers: ["capture", "transition"],
    builder: ["capture", "transition"],
    delta: ["capture", "mutation"],
    exporter: ["capture", "transition"],
    binarywriter: ["capture", "transition"],
    thememanifest: ["capture", "transition"],
    layoutgate: ["capture", "transition"],
    timing: ["capture", "transition"],
    outbox: ["delivery", "offline"],
    pending: ["delivery", "offline"],
    filesink: ["delivery", "online"],
    archive: ["delivery", "online"],
    lpprovider: ["viewer", "miss"],
    catalog: ["viewer", "miss"],
    projection: ["viewer", "miss"],
    timeline: ["viewer", "miss"],
    aggregate: ["viewer", "miss"],
    snapshotservice: ["viewer", "miss"],
    snapshotstore: ["viewer", "miss"],
    parse: ["viewer", "miss"],
    api: ["viewer", "miss"],
    timelineview: ["viewer", "miss"],
    render: ["viewer", "miss"],
    replica: ["viewer", "miss"],
    filmstrip: ["viewer", "miss"]
  };

  var state = {
    selected: null,
    hoverEdge: null,
    scenario: "all",
    search: "",
    flowStep: 0,
    focusNode: null,
    trace: false,
    timelineTab: "capture",
    timelineVariant: "transition",
    timelineSelected: null,
    playhead: 0,
    playing: false,
    view: { x: 0, y: 0, w: MAP_W, h: MAP_H },
    dragging: false,
    dragMoved: false
  };

  var dom = {};
  var map = {
    nodeEls: new Map(),
    edgeEls: [],
    edgeLabelEls: new Map(),
    playhead: null,
    animation: null
  };
  var playback = { frame: null, stop: null };

  function $(selector, root) { return (root || document).querySelector(selector); }
  function $$(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

  function esc(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "text") node.textContent = attrs[key];
        else if (key === "class") node.setAttribute("class", attrs[key]);
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function htmlEl(tag, attrs, parent) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "text") node.textContent = attrs[key];
        else if (key === "class") node.className = attrs[key];
        else if (key === "html") node.innerHTML = attrs[key];
        else if (key === "dataset") Object.assign(node.dataset, attrs[key]);
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function fileHref(path) { return "../../" + path.replace(/^\/+/, ""); }

  function truncate(value, max) {
    var text = String(value === undefined ? "" : value);
    return text.length > max ? text.slice(0, Math.max(1, max - 1)) + "…" : text;
  }

  function chip(text, extraClass, attrs) {
    return htmlEl("span", {
      class: "chip" + (extraClass ? " " + extraClass : ""),
      text: text
    }, null);
  }

  function nodeChip(id, options) {
    var node = nodeById.get(id);
    if (!node) return document.createTextNode(id);
    var attributes = {
      class: "chip node-chip",
      type: "button",
      text: node.label,
      title: node.tagline || node.role || node.label
    };
    if (options && options.jump) attributes.dataset = { node: id, jump: "map" };
    else attributes.dataset = { node: id };
    return htmlEl("button", attributes);
  }

  function setChipList(container, values, kind) {
    if (!container) return;
    container.innerHTML = "";
    (values || []).forEach(function (value) {
      container.appendChild(chip(value, kind === "config" ? "config" : ""));
    });
  }

  /* ------------------------------------------------------------------- theme */

  function initTheme() {
    var button = $("#theme-toggle");
    var stored = null;
    try { stored = localStorage.getItem("telemetry-doc-theme"); } catch (_) { /* file:// privacy mode */ }
    var initial = stored || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    setTheme(initial);
    if (button) {
      button.addEventListener("click", function () {
        setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
      });
    }
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var icon = $(".theme-icon");
    if (icon) icon.textContent = theme === "light" ? "☀" : "☾";
    try { localStorage.setItem("telemetry-doc-theme", theme); } catch (_) { /* ignore */ }
  }

  /* --------------------------------------------------------------- mechanics */

  function renderMechanics() {
    var grid = $("#mechanics-grid");
    if (!grid) return;
    DATA.mechanics.forEach(function (mechanic) {
      var card = htmlEl("button", {
        class: "mechanic-card",
        type: "button",
        dataset: { node: mechanic.node, jump: "map" }
      }, grid);
      card.innerHTML =
        '<p class="card-kicker">' + esc(mechanic.kicker) + '</p>' +
        '<h3>' + esc(mechanic.title) + '</h3>' +
        '<p>' + esc(mechanic.body) + '</p>' +
        '<div class="tags">' + (mechanic.tags || []).map(function (tag) {
          return '<span class="tag">' + esc(tag) + '</span>';
        }).join("") + '</div>';
    });
  }

  function renderHeroStats() {
    var target = $("#hero-stats");
    if (!target) return;
    var values = [
      [DATA.nodes.length, "components"],
      [DATA.planes.length, "planes"],
      [DATA.edges.length, "hand-offs"],
      [DATA.timelines ? Object.keys(DATA.timelines).length : 0, "timelines"]
    ];
    target.innerHTML = values.map(function (value) {
      return '<span class="hero-stat"><strong>' + value[0] + '</strong>' + esc(value[1]) + '</span>';
    }).join("");
  }

  /* ---------------------------------------------------------------- scenarios */

  function renderScenarios() {
    var target = $("#scenario-pills");
    if (!target) return;
    var all = [{ id: "all", label: "All", short: "All", description: "Show every component and every hand-off." }].concat(DATA.scenarios);
    all.forEach(function (scenario) {
      var button = htmlEl("button", {
        class: "scenario-pill" + (scenario.id === state.scenario ? " active" : ""),
        type: "button",
        text: scenario.short || scenario.label,
        dataset: { scenario: scenario.id },
        title: scenario.description || scenario.label,
        "aria-pressed": scenario.id === state.scenario ? "true" : "false"
      }, target);
      button.addEventListener("click", function () { setScenario(scenario.id); });
    });
  }

  function setScenario(id, options) {
    if (id !== "all" && !DATA.scenarios.some(function (s) { return s.id === id; })) id = "all";
    state.scenario = id;
    if (state.selected) clearSelection();
    $$(".scenario-pill").forEach(function (button) {
      var active = button.dataset.scenario === id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    var banner = $("#scenario-banner");
    var scenario = DATA.scenarios.find(function (s) { return s.id === id; });
    if (banner) {
      if (!scenario) {
        banner.hidden = true;
        banner.innerHTML = "";
      } else {
        banner.hidden = false;
        banner.innerHTML = '<strong>' + esc(scenario.label) + '</strong><span>' + esc(scenario.description) + '</span>';
      }
    }
    applyMapState();
    updateMapStatus();
    if (!(options && options.silentHash)) updateHash();
  }

  /* --------------------------------------------------------------------- map */

  function buildMap() {
    var root = $("#system-map");
    if (!root) return;
    dom.mapRoot = root;
    dom.mapWrap = $("#map-wrap");
    dom.mapTip = $("#map-tooltip");
    root.innerHTML = "";

    var defs = svgEl("defs", {}, root);
    var marker = svgEl("marker", {
      id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5",
      markerWidth: "5", markerHeight: "5", orient: "auto-start-reverse"
    }, defs);
    svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#53677c" }, marker);
    var activeMarker = svgEl("marker", {
      id: "arrow-active", viewBox: "0 0 10 10", refX: "9", refY: "5",
      markerWidth: "5", markerHeight: "5", orient: "auto-start-reverse"
    }, defs);
    svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--accent)" }, activeMarker);

    var planesGroup = svgEl("g", { class: "planes" }, root);
    DATA.planes.forEach(function (plane) {
      var planeNodes = DATA.nodes.filter(function (node) { return node.plane === plane.id; });
      var planeBottom = planeNodes.reduce(function (bottom, node) {
        return Math.max(bottom, node.y + node.h);
      }, PLANE_Y + 440) + 28;
      var planeHeight = Math.min(PLANE_H, planeBottom - PLANE_Y);
      svgEl("rect", {
        class: "plane-bg", x: plane.x, y: PLANE_Y, width: plane.w, height: planeHeight, rx: 16
      }, planesGroup);
      svgEl("text", { class: "plane-head", x: plane.x + 16, y: PLANE_Y + 23, text: plane.label }, planesGroup);
      svgEl("text", { class: "plane-caption", x: plane.x + 16, y: PLANE_Y + 39, text: plane.caption }, planesGroup);
    });

    var edgeGroup = svgEl("g", { class: "edges" }, root);
    edgeList.forEach(function (edge) {
      var geometry = edgeGeometry(edge);
      var group = svgEl("g", { class: "edge-group", "data-edge": edge.index }, edgeGroup);
      var path = svgEl("path", {
        class: "edge", d: geometry.d, "data-edge": edge.index,
        "aria-label": edge.from + " to " + edge.to + ": " + edge.label
      }, group);
      svgEl("title", { text: edgeLabel(edge) }, path);
      path.addEventListener("pointerenter", function () {
        state.hoverEdge = edge.index;
        applyMapState();
        updateMapStatus();
        showMapTip("<strong>" + esc(nodeById.get(edge.from).label) + " → " + esc(nodeById.get(edge.to).label) + "</strong><span>" + esc(edge.label) + "</span>", lastPointerEvent);
      });
      path.addEventListener("pointerleave", function () {
        state.hoverEdge = null;
        applyMapState();
        updateMapStatus();
        hideMapTip();
      });
      map.edgeEls.push(path);

      var labelWidth = Math.max(46, edge.label.length * 5.1 + 10);
      var bg = svgEl("rect", {
        class: "edge-label-bg", x: geometry.lx - labelWidth / 2, y: geometry.ly - 8,
        width: labelWidth, height: 15, rx: 3
      }, group);
      var text = svgEl("text", {
        class: "edge-label", x: geometry.lx, y: geometry.ly + 3,
        "text-anchor": "middle", text: edge.label
      }, group);
      map.edgeLabelEls.set(edge.index, { bg: bg, text: text });
    });

    var nodeGroup = svgEl("g", { class: "nodes" }, root);
    DATA.nodes.forEach(function (node) {
      var group = svgEl("g", {
        class: "node plane-" + node.plane,
        transform: "translate(" + node.x + " " + node.y + ")",
        "data-id": node.id,
        tabindex: "0",
        role: "button",
        "aria-label": node.label + ", " + (planeById.get(node.plane) ? planeById.get(node.plane).label : node.plane)
      }, nodeGroup);
      svgEl("rect", { class: "node-box", width: node.w, height: node.h, rx: 9 }, group);
      svgEl("circle", { class: "node-dot", cx: 13, cy: 25, r: 3.2 }, group);
      var sub = node.sub || NODE_SUBS[node.id];
      svgEl("text", {
        class: "node-label", x: 24, y: sub ? 21 : 30,
        text: truncate(node.label, Math.floor((node.w - 34) / 8.1))
      }, group);
      if (sub) {
        svgEl("text", {
          class: "node-sub", x: 24, y: 37,
          text: truncate(sub, Math.floor((node.w - 34) / 6.2))
        }, group);
      }
      map.nodeEls.set(node.id, group);

      group.addEventListener("click", function (event) {
        event.stopPropagation();
        selectNode(node.id);
      });
      group.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectNode(node.id);
        }
      });
      group.addEventListener("pointerenter", function (event) {
        lastPointerEvent = event;
        showMapTip("<strong>" + esc(node.label) + "</strong><span>" + esc(node.tagline) + "</span>", event);
        updateMapStatus(node.id);
      });
      group.addEventListener("pointermove", function (event) { lastPointerEvent = event; positionMapTip(event); });
      group.addEventListener("pointerleave", function () {
        hideMapTip();
        updateMapStatus();
      });
    });

    installMapGestures(root);
    setView({ x: 0, y: 0, w: MAP_W, h: MAP_H }, true);
  }

  var lastPointerEvent = null;

  function renderMapLegend() {
    var target = $("#map-legend");
    if (!target) return;
    var parts = DATA.planes.map(function (plane) {
      return '<span><i class="legend-dot" style="background:var(--' + esc(plane.color) + ')"></i>' + esc(plane.label) + '</span>';
    });
    parts.push('<span><i class="legend-dot" style="background:var(--accent-2)"></i>current flow step</span>');
    parts.push('<span><i class="legend-dot" style="background:transparent;border:1px solid var(--accent)"></i>selected + direct neighbours</span>');
    target.innerHTML = parts.join("");
  }

  function edgeLabel(edge) {
    var from = nodeById.get(edge.from);
    var to = nodeById.get(edge.to);
    return (from ? from.label : edge.from) + " → " + (to ? to.label : edge.to) + " · " + edge.label;
  }

  function edgeGeometry(edge) {
    var a = nodeById.get(edge.from);
    var b = nodeById.get(edge.to);
    var ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    var bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    var adx = bc.x - ac.x;
    var sy = ac.y;
    var ty = bc.y;
    var sx;
    var tx;
    var c1x;
    var c2x;
    var d;
    if (Math.abs(adx) > 46) {
      var direction = adx > 0 ? 1 : -1;
      sx = direction > 0 ? a.x + a.w : a.x;
      tx = direction > 0 ? b.x : b.x + b.w;
      var offset = ((edge.index % 5) - 2) * 2.5;
      sy += offset;
      ty += offset;
      c1x = sx + direction * Math.max(30, Math.abs(tx - sx) * 0.32);
      c2x = tx - direction * Math.max(30, Math.abs(tx - sx) * 0.32);
      d = "M" + sx + "," + sy + " C" + c1x + "," + sy + " " + c2x + "," + ty + " " + tx + "," + ty;
    } else {
      var left = a.plane === "runtime" || a.plane === "capture" || a.plane === "transport";
      var side = left ? -1 : 1;
      sx = side > 0 ? a.x + a.w : a.x;
      tx = side > 0 ? b.x + b.w : b.x;
      var gap = 18 + (edge.index % 6) * 4;
      c1x = sx + side * gap;
      c2x = tx + side * gap;
      d = "M" + sx + "," + sy + " C" + c1x + "," + sy + " " + c2x + "," + ty + " " + tx + "," + ty;
    }
    var lx = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * tx;
    var ly = 0.125 * sy + 0.375 * sy + 0.375 * ty + 0.125 * ty;
    return { d: d, lx: lx, ly: ly };
  }

  function selectNode(id, options) {
    if (!nodeById.has(id)) return;
    state.selected = id;
    state.focusNode = options && options.focus ? id : null;
    if (options && options.trace) state.trace = true;
    renderInspector();
    applyMapState();
    updateMapStatus();
    var node = nodeById.get(id);
    if (node) {
      var plane = planeById.get(node.plane);
      var status = $("#map-status");
      if (status) status.textContent = "Selected " + node.label + (plane ? " · " + plane.label : "") + ".";
    }
    if (!(options && options.silentHash)) updateHash();
    if (options && options.scroll) {
      var section = $("#map");
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function clearSelection() {
    state.selected = null;
    state.focusNode = null;
    state.trace = false;
    var traceButton = $("#map-trace");
    if (traceButton) traceButton.setAttribute("aria-pressed", "false");
    renderInspector();
    applyMapState();
    updateMapStatus();
    updateHash();
  }

  function focusSelected() {
    if (!state.selected) {
      var status = $("#map-status");
      if (status) status.textContent = "Select a component first, then focus its neighbourhood.";
      return;
    }
    state.focusNode = state.selected;
    var ids = new Set([state.selected]);
    (adjacency.get(state.selected) || []).forEach(function (id) { ids.add(id); });
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(function (id) {
      var node = nodeById.get(id);
      if (!node) return;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.w);
      maxY = Math.max(maxY, node.y + node.h);
    });
    var pad = 70;
    var width = Math.max(430, maxX - minX + pad * 2);
    var height = Math.max(330, maxY - minY + pad * 2);
    var ratio = MAP_W / MAP_H;
    if (width / height > ratio) height = width / ratio;
    else width = height * ratio;
    setView({
      x: Math.max(0, Math.min(MAP_W - width, (minX + maxX) / 2 - width / 2)),
      y: Math.max(0, Math.min(MAP_H - height, (minY + maxY) / 2 - height / 2)),
      w: width,
      h: height
    });
    applyMapState();
    var status = $("#map-status");
    if (status) status.textContent = "Focused " + nodeById.get(state.selected).label + " and its direct neighbours.";
  }

  function applyMapState() {
    if (!dom.mapRoot) return;
    var query = state.search.trim().toLowerCase();
    var matches = new Set();
    if (query) {
      searchMatches(query).forEach(function (node) { matches.add(node.id); });
    }

    var scenarioEdges = new Set();
    var scenarioNodes = new Set();
    if (state.scenario !== "all") {
      edgeList.forEach(function (edge) {
        if (edge.scenarios.indexOf(state.scenario) !== -1) {
          scenarioEdges.add(edge.index);
          scenarioNodes.add(edge.from);
          scenarioNodes.add(edge.to);
        }
      });
    }

    var focusNodes = new Set();
    if (state.focusNode) {
      focusNodes.add(state.focusNode);
      (adjacency.get(state.focusNode) || []).forEach(function (id) { focusNodes.add(id); });
    }

    var flowNodes = new Set();
    if (DATA.flow[state.flowStep]) {
      (DATA.flow[state.flowStep].components || []).forEach(function (id) { flowNodes.add(id); });
    }

    var selectionNodes = new Set();
    if (state.selected) {
      selectionNodes.add(state.selected);
      (adjacency.get(state.selected) || []).forEach(function (id) { selectionNodes.add(id); });
    }
    var hasSelection = !!state.selected;
    var contextActive = hasSelection;

    DATA.nodes.forEach(function (node) {
      var element = map.nodeEls.get(node.id);
      if (!element) return;
      var dim = false;
      var contextDim = false;
      if (hasSelection && selectionNodes.has(node.id)) {
        dim = false;
      } else if (contextActive) {
        contextDim = true;
        dim = true;
      } else {
        if (query && !matches.has(node.id)) dim = true;
        if (state.scenario !== "all" && !scenarioNodes.has(node.id)) dim = true;
        if (state.focusNode && !focusNodes.has(node.id)) dim = true;
      }
      element.classList.toggle("selected", state.selected === node.id);
      element.classList.toggle("neighbor", !!(state.selected && state.selected !== node.id && adjacency.get(state.selected) && adjacency.get(state.selected).has(node.id)));
      element.classList.toggle("flow", flowNodes.has(node.id));
      element.classList.toggle("match", !!query && matches.has(node.id));
      element.classList.toggle("dim", dim);
      element.classList.toggle("context-dim", contextDim);
    });

    edgeList.forEach(function (edge) {
      var element = map.edgeEls[edge.index];
      if (!element) return;
      var touched = state.selected && (edge.from === state.selected || edge.to === state.selected);
      var flowEdge = flowNodes.has(edge.from) && flowNodes.has(edge.to);
      var dim = false;
      var contextDim = false;
      if (hasSelection && touched) {
        dim = false;
      } else if (contextActive) {
        contextDim = state.hoverEdge !== edge.index;
        dim = contextDim;
      } else {
        if (query && !(matches.has(edge.from) || matches.has(edge.to))) dim = true;
        if (state.scenario !== "all" && !scenarioEdges.has(edge.index)) dim = true;
        if (state.focusNode && !(focusNodes.has(edge.from) && focusNodes.has(edge.to))) dim = true;
        if (touched || flowEdge) dim = false;
      }
      element.classList.toggle("related", !!touched || flowEdge);
      element.classList.toggle("active", state.hoverEdge === edge.index);
      element.classList.toggle("trace", !!(state.trace && touched));
      element.classList.toggle("dim", dim);
      element.classList.toggle("context-dim", contextDim);
      var label = map.edgeLabelEls.get(edge.index);
      if (label) {
        var visible = state.hoverEdge === edge.index || !!(state.trace && touched);
        label.bg.classList.toggle("visible", visible);
        label.text.classList.toggle("visible", visible);
      }
    });
  }

  function updateMapStatus(nodeId) {
    var status = $("#map-status");
    if (!status) return;
    if (nodeId && nodeById.has(nodeId)) {
      status.textContent = nodeById.get(nodeId).tagline || nodeById.get(nodeId).label;
      return;
    }
    if (state.search.trim()) {
      var count = searchMatches(state.search.trim().toLowerCase()).length;
      status.textContent = count + " component" + (count === 1 ? "" : "s") + " match “" + state.search.trim() + "”.";
      return;
    }
    if (state.selected) {
      status.textContent = "Selected " + nodeById.get(state.selected).label + ".";
      return;
    }
    if (state.scenario !== "all") {
      var scenario = DATA.scenarios.find(function (s) { return s.id === state.scenario; });
      status.textContent = scenario ? scenario.label + " · " + (scenario.short || "scenario") : "Scenario filter active.";
      return;
    }
    status.textContent = "Select a component to inspect it.";
  }

  function showMapTip(html, event) {
    var tip = dom.mapTip;
    if (!tip) return;
    tip.innerHTML = html;
    tip.hidden = false;
    positionMapTip(event);
  }

  function positionMapTip(event) {
    var tip = dom.mapTip;
    var wrap = dom.mapWrap;
    if (!tip || !wrap || !event || tip.hidden) return;
    var rect = wrap.getBoundingClientRect();
    var localX = event.clientX - rect.left;
    var localY = event.clientY - rect.top;
    var x = localX + 13;
    var y = localY + 15;
    if (x + 270 > rect.width) x = Math.max(8, localX - 275);
    if (y + 64 > rect.height) y = Math.max(8, localY - 70);
    tip.style.left = (x + wrap.scrollLeft) + "px";
    tip.style.top = (y + wrap.scrollTop) + "px";
  }

  function hideMapTip() {
    if (dom.mapTip) dom.mapTip.hidden = true;
  }

  function installMapGestures(root) {
    var wrap = dom.mapWrap;
    var drag = null;

    root.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 && event.pointerType !== "touch") return;
      if (event.pointerType === "touch" && window.innerWidth <= 760) return;
      if (event.target.closest && event.target.closest(".node")) return;
      var matrix = root.getScreenCTM && root.getScreenCTM();
      drag = {
        matrix: matrix ? matrix.inverse() : null,
        start: clientToSvg(event.clientX, event.clientY),
        view: { x: state.view.x, y: state.view.y, w: state.view.w, h: state.view.h },
        clientX: event.clientX,
        clientY: event.clientY
      };
      state.dragging = true;
      state.dragMoved = false;
      if (wrap) wrap.classList.add("dragging");
      try { root.setPointerCapture(event.pointerId); } catch (_) { /* older browsers */ }
      event.preventDefault();
    });

    root.addEventListener("pointermove", function (event) {
      if (!drag) return;
      var point = drag.matrix ? clientToSvgWithMatrix(drag.matrix, event.clientX, event.clientY) : clientToSvg(event.clientX, event.clientY);
      var dx = point.x - drag.start.x;
      var dy = point.y - drag.start.y;
      if (Math.abs(event.clientX - drag.clientX) + Math.abs(event.clientY - drag.clientY) > 3) state.dragMoved = true;
      setView({
        x: drag.view.x - dx,
        y: drag.view.y - dy,
        w: drag.view.w,
        h: drag.view.h
      }, true);
    });

    function endDrag(event) {
      if (!drag) return;
      var moved = state.dragMoved;
      drag = null;
      state.dragging = false;
      if (wrap) wrap.classList.remove("dragging");
      if (root.hasPointerCapture && root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      if (!moved && !(event.target.closest && event.target.closest(".node"))) {
        clearSelection();
      }
    }

    root.addEventListener("pointerup", endDrag);
    root.addEventListener("pointercancel", endDrag);

    root.addEventListener("wheel", function (event) {
      event.preventDefault();
      var point = clientToSvg(event.clientX, event.clientY);
      zoomAt(point, event.deltaY < 0 ? 0.885 : 1.13, true);
    }, { passive: false });

    root.addEventListener("dblclick", function (event) {
      if (event.target.closest && event.target.closest(".node")) return;
      setView({ x: 0, y: 0, w: MAP_W, h: MAP_H });
    });
  }

  function clientToSvg(clientX, clientY) {
    var root = dom.mapRoot;
    if (!root || !root.getScreenCTM) return { x: clientX, y: clientY };
    return clientToSvgWithMatrix(root.getScreenCTM().inverse(), clientX, clientY);
  }

  function clientToSvgWithMatrix(matrix, clientX, clientY) {
    var root = dom.mapRoot;
    if (!root || !root.createSVGPoint) return { x: clientX, y: clientY };
    var point = root.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix);
  }

  function zoomAt(point, factor, instant) {
    var current = state.view;
    var newW = Math.max(320, Math.min(MAP_W * 1.4, current.w * factor));
    var newH = newW * (MAP_H / MAP_W);
    var px = (point.x - current.x) / current.w;
    var py = (point.y - current.y) / current.h;
    setView({
      x: point.x - px * newW,
      y: point.y - py * newH,
      w: newW,
      h: newH
    }, !!instant);
  }

  function clampView(view) {
    var w = Math.max(320, Math.min(MAP_W * 1.4, view.w));
    var h = w * (MAP_H / MAP_W);
    var marginX = Math.min(120, w * 0.2);
    var marginY = Math.min(120, h * 0.2);
    var x = Math.min(Math.max(view.x, -marginX), MAP_W - w + marginX);
    var y = Math.min(Math.max(view.y, -marginY), MAP_H - h + marginY);
    if (w > MAP_W) x = (MAP_W - w) / 2;
    if (h > MAP_H) y = (MAP_H - h) / 2;
    return { x: x, y: y, w: w, h: h };
  }

  function setView(view, instant) {
    var next = clampView(view);
    if (instant) {
      if (map.animation) {
        cancelAnimationFrame(map.animation);
        map.animation = null;
      }
      state.view = next;
      applyView();
      return;
    }
    animateView(next);
  }

  function applyView() {
    if (dom.mapRoot) dom.mapRoot.setAttribute("viewBox", state.view.x + " " + state.view.y + " " + state.view.w + " " + state.view.h);
  }

  function animateView(target) {
    if (map.animation) cancelAnimationFrame(map.animation);
    var start = { x: state.view.x, y: state.view.y, w: state.view.w, h: state.view.h };
    var started = performance.now();
    var duration = 300;
    function step(now) {
      var t = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      state.view = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        w: start.w + (target.w - start.w) * eased,
        h: start.h + (target.h - start.h) * eased
      };
      applyView();
      if (t < 1) map.animation = requestAnimationFrame(step);
      else map.animation = null;
    }
    map.animation = requestAnimationFrame(step);
  }

  /* ---------------------------------------------------------------- inspector */

  function chipMarkup(id, options) {
    var node = nodeById.get(id);
    if (!node) return "";
    return '<button class="chip node-chip" type="button" data-node="' + esc(id) + '"' +
      (options && options.jump ? ' data-jump="map"' : "") +
      ' title="' + esc(node.tagline || node.label) + '">' + esc(node.label) + '</button>';
  }

  function fileLink(path, symbol) {
    return '<a class="file-link" href="' + esc(fileHref(path)) + '" target="_blank" rel="noreferrer">' +
      esc(path) + (symbol ? '<span>' + esc(symbol) + '</span>' : "") + '</a>';
  }

  function renderInspector() {
    var inspector = $("#inspector");
    if (!inspector) return;
    if (!state.selected) {
      inspector.innerHTML =
        '<div class="inspector-empty">' +
          '<div class="inspector-glyph" aria-hidden="true">⌁</div>' +
          '<h3>Pick a component</h3>' +
          '<p>The inspector shows what it owns, what it reads and writes, the files to open, and the invariants that make replay trustworthy.</p>' +
          '<p class="muted">Try <button class="inline-link" type="button" data-node="exporter">UISnapshotExporter</button> or <button class="inline-link" type="button" data-node="outbox">InfluxOutboxSink</button>.</p>' +
        '</div>';
      return;
    }

    var node = nodeById.get(state.selected);
    if (!node) return;
    var plane = planeById.get(node.plane);
    var adrs = DATA.reference && DATA.reference.adrs ? DATA.reference.adrs : [];
    var timeline = NODE_TIMELINE[node.id];

    var html = '<div class="inspector-head">' +
      '<div><p class="inspector-kicker">' + esc(plane ? plane.label : node.plane) + '</p><h3>' + esc(node.label) + '</h3></div>' +
      '<button class="inspector-close" type="button" data-action="close" aria-label="Close inspector">×</button>' +
      '</div>';
    html += '<p class="inspector-tagline">' + esc(node.tagline || "") + '</p>';
    if (node.role) html += '<div class="inspector-section"><h4>What it does</h4><p>' + esc(node.role) + '</p></div>';

    function listSection(title, values) {
      if (!values || !values.length) return "";
      return '<div class="inspector-section"><h4>' + esc(title) + '</h4><ul class="bullet-list">' +
        values.map(function (value) { return '<li>' + esc(value) + '</li>'; }).join("") + '</ul></div>';
    }
    html += listSection("Owns", node.owns);
    html += listSection("Inputs", node.inputs);
    html += listSection("Outputs", node.outputs);
    html += listSection("State", node.state);

    if (node.files && node.files.length) {
      html += '<div class="inspector-section"><h4>Files</h4><div class="file-list">' +
        node.files.map(function (file) { return fileLink(file.path, file.symbol); }).join("") + '</div></div>';
    }
    if (node.config && node.config.length) {
      html += '<div class="inspector-section"><h4>Configuration</h4><div class="chip-list">' +
        node.config.map(function (field) { return '<span class="chip config">' + esc(field) + '</span>'; }).join("") + '</div></div>';
    }
    html += listSection("Invariants", node.invariants);
    if (node.failure) {
      html += '<div class="inspector-section"><h4>Failure behaviour</h4><div class="inspector-callout">' + esc(node.failure) + '</div></div>';
    }
    if (node.adrs && node.adrs.length) {
      html += '<div class="inspector-section"><h4>Decisions</h4><div class="chip-list">' +
        node.adrs.map(function (id) {
          var adr = adrs.find(function (item) { return item.id === id; });
          if (!adr) return '<span class="chip">ADR-' + esc(id) + '</span>';
          return '<a class="chip" href="' + esc(fileHref(adr.file)) + '" target="_blank" rel="noreferrer" title="' + esc(adr.title) + '">ADR-' + esc(id) + '</a>';
        }).join("") + '</div></div>';
    }

    html += '<div class="inspector-actions">';
    html += '<button class="mini-button" type="button" data-action="focus">Focus subgraph</button>';
    html += '<button class="mini-button" type="button" data-action="trace" aria-pressed="' + (state.trace ? "true" : "false") + '">' + (state.trace ? "Stop trace" : "Trace edges") + '</button>';
    if (timeline) html += '<button class="mini-button" type="button" data-action="timeline">Open timeline</button>';
    html += '<button class="mini-button" type="button" data-action="copy">Copy link</button>';
    html += '</div>';
    inspector.innerHTML = html;
  }

  function initInspectorActions() {
    var inspector = $("#inspector");
    if (!inspector) return;
    inspector.addEventListener("click", function (event) {
      var action = event.target.closest("[data-action]");
      if (!action) return;
      var name = action.dataset.action;
      if (name === "close") clearSelection();
      else if (name === "focus") focusSelected();
      else if (name === "trace") toggleTrace();
      else if (name === "timeline") {
        var timeline = NODE_TIMELINE[state.selected];
        if (timeline) {
          setTimelineTab(timeline[0], timeline[1]);
          var section = $("#timelines");
          if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } else if (name === "copy") copyShareLink();
    });
  }

  function toggleTrace() {
    if (!state.selected) {
      var status = $("#map-status");
      if (status) status.textContent = "Select a component first, then trace its edges.";
      return;
    }
    state.trace = !state.trace;
    var button = $("#map-trace");
    if (button) button.setAttribute("aria-pressed", state.trace ? "true" : "false");
    renderInspector();
    applyMapState();
    updateMapStatus();
  }

  function copyShareLink() {
    updateHash();
    var url = window.location.href;
    var done = function () {
      var status = $("#map-status");
      if (status) status.textContent = "Link copied to the clipboard.";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt("Copy this link", url); });
    } else {
      window.prompt("Copy this link", url);
    }
  }

  /* --------------------------------------------------------------------- flow */

  function renderFlow() {
    var target = $("#flow-steps");
    if (!target) return;
    target.innerHTML = "";
    DATA.flow.forEach(function (step, index) {
      var button = htmlEl("button", {
        class: "flow-step" + (index === state.flowStep ? " active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": index === state.flowStep ? "true" : "false",
        dataset: { step: String(index) }
      }, target);
      button.innerHTML = '<span class="flow-num">' + String(index + 1).padStart(2, "0") + '</span>' +
        '<span><strong>' + esc(step.title) + '</strong><small>' + esc(step.short) + '</small></span>';
      button.addEventListener("click", function () { setFlowStep(index); });
    });
  }

  function setFlowStep(index, options) {
    if (!DATA.flow.length) return;
    index = Math.max(0, Math.min(DATA.flow.length - 1, Number(index) || 0));
    if (state.selected && !(options && options.silentHash)) clearSelection();
    state.flowStep = index;
    var step = DATA.flow[index];
    $$(".flow-step").forEach(function (button) {
      var active = Number(button.dataset.step) === index;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    var detail = $("#flow-detail");
    if (detail) {
      detail.innerHTML =
        '<p class="flow-detail-kicker">' + esc(step.kicker) + '</p>' +
        '<h3>' + esc(step.title) + '</h3>' +
        '<p>' + esc(step.detail) + '</p>' +
        '<div class="flow-payload">' + esc(step.payload) + '</div>' +
        '<div class="flow-branch"><strong>Branch.</strong> ' + esc(step.branch) + '</div>' +
        '<div class="chip-list">' + (step.components || []).map(function (id) { return chipMarkup(id); }).join("") + '</div>' +
        '<div class="flow-detail-footer">' +
          '<div class="flow-nav">' +
            '<button class="mini-button" type="button" data-flow="prev"' + (index === 0 ? " disabled" : "") + '>← Previous</button>' +
            '<button class="mini-button" type="button" data-flow="next"' + (index === DATA.flow.length - 1 ? " disabled" : "") + '>Next →</button>' +
          '</div>' +
          '<div class="flow-nav">' +
            '<button class="mini-button" type="button" data-flow="map">Show on map</button>' +
            (step.timeline ? '<button class="mini-button" type="button" data-flow="timeline">Open timeline</button>' : "") +
          '</div>' +
        '</div>';
    }
    applyMapState();
    if (!(options && options.silentHash)) updateHash();
  }

  function initFlowActions() {
    var detail = $("#flow-detail");
    if (!detail) return;
    detail.addEventListener("click", function (event) {
      var action = event.target.closest("[data-flow]");
      if (!action) return;
      var name = action.dataset.flow;
      if (name === "prev") setFlowStep(state.flowStep - 1);
      else if (name === "next") setFlowStep(state.flowStep + 1);
      else if (name === "map") {
        var section = $("#map");
        if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (name === "timeline") {
        var step = DATA.flow[state.flowStep];
        if (step && step.timeline) {
          setTimelineTab(step.timeline.tab, step.timeline.variant);
          var timelines = $("#timelines");
          if (timelines) timelines.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
  }

  /* ----------------------------------------------------------------- timelines */

  function formatMs(value) {
    var number = Number(value);
    if (!isFinite(number)) number = 0;
    if (Math.abs(number) >= 1000) {
      var seconds = number / 1000;
      return (seconds >= 10 ? Math.round(seconds) : seconds.toFixed(Math.abs(seconds % 1) > 0.01 ? 1 : 0)) + "s";
    }
    return Math.round(number) + "ms";
  }

  function niceTicks(max, count) {
    var span = Math.max(1, max);
    var rough = span / Math.max(1, count);
    var power = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var fraction = rough / power;
    var nice;
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 5) nice = 5;
    else nice = 10;
    var step = nice * power;
    var ticks = [];
    for (var value = 0; value <= span + step * 0.001; value += step) ticks.push(value);
    return ticks;
  }

  function renderTimelineTabs() {
    var target = $("#timeline-tabs");
    if (!target) return;
    target.innerHTML = "";
    var order = DATA.timelineOrder || Object.keys(DATA.timelines || {});
    order.forEach(function (key) {
      var timeline = DATA.timelines[key];
      if (!timeline) return;
      var tab = htmlEl("button", {
        class: "timeline-tab" + (key === state.timelineTab ? " active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": key === state.timelineTab ? "true" : "false",
        dataset: { timeline: key }
      }, target);
      tab.textContent = timeline.kicker || timeline.title || key;
      tab.addEventListener("click", function () { setTimelineTab(key); });
    });
  }

  function setTimelineTab(tab, variantId, options) {
    if (!DATA.timelines || !DATA.timelines[tab]) return;
    state.timelineTab = tab;
    var variants = DATA.timelines[tab].variants || [];
    var variant = variants.find(function (item) { return item.id === variantId; });
    if (!variant && state.timelineTab === tab) variant = variants.find(function (item) { return item.id === state.timelineVariant; });
    if (!variant) variant = variants[0];
    state.timelineVariant = variant ? variant.id : "";
    state.timelineSelected = null;
    stopPlayback();
    renderTimelineTabs();
    renderTimeline();
    if (!(options && options.silentHash)) updateHash();
  }

  function renderTimeline() {
    var timeline = DATA.timelines[state.timelineTab];
    if (!timeline) return;
    var variant = (timeline.variants || []).find(function (item) { return item.id === state.timelineVariant; }) || (timeline.variants || [])[0];
    if (!variant) return;
    state.timelineVariant = variant.id;

    var title = $("#timeline-title");
    var description = $("#timeline-description");
    var note = $("#timeline-note");
    if (title) title.textContent = timeline.title;
    if (description) description.textContent = timeline.description;
    if (note) note.textContent = "Illustrative durations · config values labelled";

    var variantsTarget = $("#timeline-variants");
    if (variantsTarget) {
      variantsTarget.innerHTML = "";
      (timeline.variants || []).forEach(function (item) {
        var button = htmlEl("button", {
          class: "timeline-variant" + (item.id === variant.id ? " active" : ""),
          type: "button",
          text: item.label,
          dataset: { variant: item.id },
          title: item.note || item.label
        }, variantsTarget);
        button.addEventListener("click", function () { setTimelineTab(state.timelineTab, item.id); });
      });
    }

    var root = $("#timeline-svg");
    if (!root) return;
    root.innerHTML = "";
    var lanes = timeline.lanes || [];
    var width = 1000;
    var labelWidth = 122;
    var padRight = 16;
    var plotWidth = width - labelWidth - padRight;
    var domain = variant.domain || [0, Math.max(1, Math.max.apply(null, (variant.items || []).map(function (item) { return item.start + item.dur; })))];
    var min = Number(domain[0]) || 0;
    var max = Math.max(min + 1, Number(domain[1]) || 1);
    var span = max - min;
    var top = 34;
    var laneHeight = 62;
    var height = top + lanes.length * laneHeight + 22;
    root.setAttribute("viewBox", "0 0 " + width + " " + height);
    root.setAttribute("preserveAspectRatio", "xMidYMid meet");

    var xFor = function (value) { return labelWidth + ((value - min) / span) * plotWidth; };

    lanes.forEach(function (lane, index) {
      var laneTop = top + index * laneHeight;
      svgEl("rect", {
        class: "tl-lane-band", x: 0, y: laneTop, width: width, height: 54,
        opacity: index % 2 === 0 ? "0.55" : "0.28"
      }, root);
      svgEl("line", { class: "tl-grid", x1: 0, y1: laneTop + 54, x2: width, y2: laneTop + 54 }, root);
      svgEl("text", { class: "tl-lane-label", x: 8, y: laneTop + 35, text: lane.label }, root);
    });

    niceTicks(max, 6).forEach(function (tick) {
      if (tick < min || tick > max + 0.001) return;
      var x = xFor(tick);
      svgEl("line", { class: "tl-grid", x1: x, y1: 28, x2: x, y2: height - 18 }, root);
      svgEl("text", {
        class: "tl-tick", x: x, y: 18, "text-anchor": tick === 0 ? "start" : "middle",
        text: formatMs(tick)
      }, root);
    });
    svgEl("line", { class: "tl-axis", x1: labelWidth, y1: height - 18, x2: width - padRight, y2: height - 18 }, root);

    var laneIndex = new Map(lanes.map(function (lane, index) { return [lane.id, index]; }));
    var itemGroups = [];
    var orderedItems = (variant.items || []).slice().sort(function (a, b) {
      var laneA = laneIndex.has(a.lane) ? laneIndex.get(a.lane) : 0;
      var laneB = laneIndex.has(b.lane) ? laneIndex.get(b.lane) : 0;
      if (laneA !== laneB) return laneA - laneB;
      var instantA = a.dur === 0 ? 1 : 0;
      var instantB = b.dur === 0 ? 1 : 0;
      if (instantA !== instantB) return instantA - instantB;
      return a.start - b.start;
    });

    orderedItems.forEach(function (item) {
      var index = laneIndex.has(item.lane) ? laneIndex.get(item.lane) : 0;
      var laneTop = top + index * laneHeight;
      var x = xFor(item.start);
      var xEnd = xFor(item.start + item.dur);
      var itemWidth = Math.max(3, xEnd - x);
      var kind = item.kind || "work";
      var group = svgEl("g", {
        class: "tl-item kind-" + kind + (item.id === state.timelineSelected ? " selected" : ""),
        "data-item": item.id,
        tabindex: "0",
        role: "button",
        "aria-label": item.label + (item.dur ? ", " + formatMs(item.dur) : "")
      }, root);
      var endLabel = item.dur ? " · " + formatMs(item.dur) : " · instant";
      svgEl("title", { text: item.label + endLabel + " — " + item.detail }, group);
      if (item.dur === 0) {
        svgEl("path", {
          class: "tl-marker kind-" + kind,
          d: "M" + x + "," + (laneTop + 9) + " L" + (x + 3.5) + "," + (laneTop + 13) +
            " L" + x + "," + (laneTop + 17) + " L" + (x - 3.5) + "," + (laneTop + 13) + " Z"
        }, group);
        var labelX = x + 7;
        var anchor = "start";
        if (labelX + 90 > width - padRight) { labelX = x - 7; anchor = "end"; }
        svgEl("text", {
          class: "tl-instant-label", x: labelX, y: laneTop + 16,
          "text-anchor": anchor, text: truncate(item.label, 22)
        }, group);
      } else {
        svgEl("rect", {
          x: x, y: laneTop + 23, width: itemWidth, height: 25, rx: 4
        }, group);
        if (itemWidth > 46) {
          svgEl("text", {
            x: x + 5, y: laneTop + 39,
            text: truncate(item.label, Math.max(4, Math.floor((itemWidth - 10) / 5.4)))
          }, group);
        }
      }
      group.addEventListener("pointerenter", function (event) { showTimelineTip(item, event); setTimelineReadout(item); });
      group.addEventListener("pointermove", function (event) { positionTimelineTip(event); });
      group.addEventListener("pointerleave", function () {
        hideTimelineTip();
        if (state.timelineSelected) {
          var selected = (variant.items || []).find(function (entry) { return entry.id === state.timelineSelected; });
          if (selected) setTimelineReadout(selected);
        } else {
          clearTimelineReadout(variant.note);
        }
      });
      group.addEventListener("click", function (event) {
        event.stopPropagation();
        selectTimelineItem(item);
      });
      group.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectTimelineItem(item);
        }
      });
      itemGroups.push(group);
    });

    var playheadGroup = svgEl("g", { class: "tl-playhead-group" }, root);
    var line = svgEl("line", {
      class: "tl-playhead", x1: labelWidth, y1: top - 4, x2: labelWidth, y2: height - 18
    }, playheadGroup);
    var head = svgEl("circle", {
      class: "tl-playhead-head", cx: labelWidth, cy: top - 4, r: 3.5
    }, playheadGroup);
    map.playhead = {
      line: line, head: head,
      xFor: xFor, min: min, max: max, plotLeft: labelWidth, plotRight: width - padRight,
      width: width, height: height, laneTop: top
    };
    state.playhead = Math.max(min, Math.min(max, state.playhead || min));
    updateTimelinePlayhead();
    clearTimelineReadout(variant.note);

    root.onclick = function (event) {
      if (event.target.closest && event.target.closest(".tl-item")) return;
      var point = clientToSvg(event.clientX, event.clientY);
      var localX = Number(point.x);
      if (!isFinite(localX) || localX < labelWidth || localX > width - padRight) return;
      stopPlayback();
      setTimelinePlayhead(min + ((localX - labelWidth) / plotWidth) * span, true);
    };
  }

  function updateTimelinePlayhead() {
    var info = map.playhead;
    if (!info) return;
    var value = Math.max(info.min, Math.min(info.max, state.playhead));
    var x = info.xFor(value);
    info.line.setAttribute("x1", x);
    info.line.setAttribute("x2", x);
    info.head.setAttribute("cx", x);
    var scrub = $("#timeline-scrub");
    if (scrub) {
      scrub.min = String(info.min);
      scrub.max = String(info.max);
      scrub.value = String(value);
    }
    var time = $("#timeline-time");
    if (time) time.textContent = formatMs(value);
  }

  function setTimelinePlayhead(value, fromUser) {
    var info = map.playhead;
    if (!info) return;
    if (fromUser) stopPlayback();
    state.playhead = Math.max(info.min, Math.min(info.max, Number(value) || 0));
    updateTimelinePlayhead();
  }

  function selectTimelineItem(item) {
    state.timelineSelected = item.id;
    $$(".tl-item").forEach(function (element) {
      element.classList.toggle("selected", element.dataset.item === item.id);
    });
    setTimelineReadout(item);
    stopPlayback();
    setTimelinePlayhead(item.dur ? item.start + item.dur / 2 : item.start, true);
    updateHash();
  }

  function setTimelineReadout(item) {
    var target = $("#timeline-readout");
    if (!target) return;
    if (!item) {
      clearTimelineReadout();
      return;
    }
    var chips = (item.components || []).map(function (id) { return chipMarkup(id); }).join("");
    target.innerHTML =
      '<span class="readout-kind">' + esc(item.kind || "work") + '</span>' +
      '<div class="readout-body">' +
        '<strong>' + esc(item.label) + '</strong>' +
        '<span>' + esc(item.detail) + ' · ' + (item.dur ? formatMs(item.dur) : "instant") + '</span>' +
        (chips ? '<div class="chip-list">' + chips + '</div>' : "") +
      '</div>';
  }

  function clearTimelineReadout(note) {
    var target = $("#timeline-readout");
    if (!target) return;
    target.innerHTML = '<span class="readout-empty">' + esc(note || "Hover or click an item to read its contract.") + '</span>';
  }

  function showTimelineTip(item, event) {
    var tip = $("#timeline-tooltip");
    if (!tip) return;
    tip.innerHTML = '<strong>' + esc(item.label) + '</strong><span>' +
      (item.dur ? formatMs(item.start) + " + " + formatMs(item.dur) : formatMs(item.start) + " · instant") +
      '</span>';
    tip.hidden = false;
    positionTimelineTip(event);
  }

  function positionTimelineTip(event) {
    var tip = $("#timeline-tooltip");
    var stage = tip ? tip.parentElement : null;
    if (!tip || !stage || !event || tip.hidden) return;
    var rect = stage.getBoundingClientRect();
    var x = event.clientX - rect.left + stage.scrollLeft + 12;
    var y = event.clientY - rect.top + stage.scrollTop + 14;
    if (x + 280 > rect.width) x = Math.max(6, event.clientX - rect.left - 286);
    if (y + 58 > rect.height) y = Math.max(6, event.clientY - rect.top - 64);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  function hideTimelineTip() {
    var tip = $("#timeline-tooltip");
    if (tip) tip.hidden = true;
  }

  function stopPlayback() {
    state.playing = false;
    if (playback.frame) cancelAnimationFrame(playback.frame);
    playback.frame = null;
    var button = $("#timeline-play");
    if (button) {
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = '<span aria-hidden="true">▶</span> Play';
    }
  }

  function startPlayback() {
    var info = map.playhead;
    if (!info) return;
    stopPlayback();
    if (state.playhead >= info.max) state.playhead = info.min;
    state.playing = true;
    var button = $("#timeline-play");
    if (button) {
      button.setAttribute("aria-pressed", "true");
      button.innerHTML = '<span aria-hidden="true">❚❚</span> Pause';
    }
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var duration = reduced ? 700 : Math.max(1200, Math.min(9000, info.max - info.min));
    var started = performance.now();
    var startValue = state.playhead;
    function step(now) {
      if (!state.playing) return;
      var t = Math.min(1, (now - started) / duration);
      state.playhead = startValue + (info.max - startValue) * t;
      updateTimelinePlayhead();
      if (t >= 1) {
        stopPlayback();
        return;
      }
      playback.frame = requestAnimationFrame(step);
    }
    playback.frame = requestAnimationFrame(step);
  }

  function initTimeline() {
    if (!DATA.timelines) return;
    renderTimelineTabs();
    var play = $("#timeline-play");
    if (play) {
      play.addEventListener("click", function () {
        if (state.playing) stopPlayback();
        else startPlayback();
      });
    }
    var scrub = $("#timeline-scrub");
    if (scrub) {
      scrub.addEventListener("input", function () {
        setTimelinePlayhead(Number(scrub.value), true);
      });
    }
    setTimelineTab(state.timelineTab, state.timelineVariant, { silentHash: true });
  }

  /* ------------------------------------------------------------------- tables */

  function tableHtml(headers, rows) {
    return '<table><thead><tr>' + headers.map(function (header) {
      return '<th scope="col">' + esc(header) + '</th>';
    }).join("") + '</tr></thead><tbody>' + rows.join("") + '</tbody></table>';
  }

  function chipCell(values) {
    return '<div class="chip-list">' + (values || []).map(function (value) {
      return '<span class="chip">' + esc(value) + '</span>';
    }).join("") + '</div>';
  }

  function renderTables() {
    var reference = DATA.reference;
    if (!reference) return;

    var measurements = $("#measurement-table");
    if (measurements) {
      measurements.innerHTML = tableHtml(["Measurement", "Tags", "Fields", "Contract"], reference.measurements.map(function (item) {
        return '<tr><td><strong><code>' + esc(item.name) + '</code></strong></td>' +
          '<td>' + chipCell(item.tags) + '</td>' +
          '<td>' + chipCell(item.fields) + '</td>' +
          '<td>' + esc(item.note) + '</td></tr>';
      }));
    }

    var formats = $("#format-table");
    if (formats) {
      formats.innerHTML = tableHtml(["Format", "Extension", "Magic", "Schema", "Compression", "Members", "Notes"], reference.formats.map(function (item) {
        return '<tr><td><strong>' + esc(item.name) + '</strong></td>' +
          '<td><code>' + esc(item.ext) + '</code></td>' +
          '<td><code>' + esc(item.magic) + '</code></td>' +
          '<td>' + esc(item.schema) + '</td>' +
          '<td>' + esc(item.compression) + '</td>' +
          '<td>' + esc(item.members) + '</td>' +
          '<td>' + esc(item.note) + '</td></tr>';
      }));
    }

    var routes = $("#routes-table");
    if (routes) {
      routes.innerHTML = tableHtml(["Method", "Route", "Purpose", "Source"], reference.routes.map(function (item) {
        return '<tr><td><span class="method ' + esc(item.method.toLowerCase()) + '">' + esc(item.method) + '</span></td>' +
          '<td><code>' + esc(item.path) + '</code></td>' +
          '<td>' + esc(item.purpose) + '</td>' +
          '<td><span class="tiny">' + esc(item.source) + '</span></td></tr>';
      }));
    }

    var env = $("#env-table");
    if (env) {
      env.innerHTML = tableHtml(["Variable", "Default", "Contract"], reference.env.map(function (item) {
        return '<tr><td><code>' + esc(item.name) + '</code></td>' +
          '<td><code>' + esc(item.default) + '</code></td>' +
          '<td>' + esc(item.note) + '</td></tr>';
      }));
    }

    var failures = $("#failure-table");
    if (failures) {
      failures.innerHTML = tableHtml(["Signal", "Owner", "What survives", "Recovery"], reference.failures.map(function (item) {
        return '<tr><td><strong>' + esc(item.signal) + '</strong><div class="tiny">' + esc(item.surface) + '</div></td>' +
          '<td><span class="chip">' + esc(item.code) + '</span></td>' +
          '<td>' + esc(item.behaviour) + '</td>' +
          '<td>' + esc(item.recovery) + '</td></tr>';
      }));
    }

    var files = $("#files-table");
    if (files) {
      files.innerHTML = tableHtml(["Path", "Purpose"], reference.files.map(function (item) {
        return '<tr><td><a class="file-link" href="' + esc(fileHref(item.path)) + '" target="_blank" rel="noreferrer">' +
          esc(item.path) + '</a></td><td>' + esc(item.purpose) + '</td></tr>';
      }));
    }

    var adrs = $("#adr-table");
    if (adrs) {
      adrs.innerHTML = tableHtml(["ADR", "Decision", "Status", "Record"], reference.adrs.map(function (item) {
        var statusClass = /declined/i.test(item.status) ? "warn" : (/shipped/i.test(item.status) ? "ok" : "");
        return '<tr><td><strong>ADR-' + esc(item.id) + '</strong></td>' +
          '<td><strong>' + esc(item.title) + '</strong><div class="tiny">' + esc(item.summary) + '</div></td>' +
          '<td><span class="status ' + statusClass + '">' + esc(item.status) + '</span></td>' +
          '<td><a href="' + esc(fileHref(item.file)) + '" target="_blank" rel="noreferrer">open</a></td></tr>';
      }));
    }

    renderConfigTable("");
  }

  function renderConfigTable(filter) {
    var reference = DATA.reference;
    if (!reference) return;
    var query = String(filter || "").trim().toLowerCase();
    var rows = reference.config.filter(function (item) {
      if (!query) return true;
      return [item.group, item.field, item.default, item.effect].join(" ").toLowerCase().indexOf(query) !== -1;
    });
    var target = $("#config-table");
    if (target) {
      target.innerHTML = rows.length
        ? tableHtml(["Group", "Field", "Default", "Effect"], rows.map(function (item) {
            return '<tr><td><span class="chip">' + esc(item.group) + '</span></td>' +
              '<td><code>' + esc(item.field) + '</code></td>' +
              '<td><code>' + esc(item.default) + '</code></td>' +
              '<td>' + esc(item.effect) + '</td></tr>';
          }))
        : tableHtml(["Group", "Field", "Default", "Effect"], ['<tr class="empty-row"><td colspan="4">No configuration field matches “' + esc(filter) + '”.</td></tr>']);
    }
    var count = $("#config-count");
    if (count) count.textContent = rows.length + " of " + reference.config.length + " fields";
  }

  function renderRecipes() {
    var target = $("#recipe-grid");
    if (!target) return;
    target.innerHTML = "";
    DATA.recipes.forEach(function (recipe, index) {
      var article = htmlEl("article", { class: "recipe", id: "recipe-" + (index + 1) }, target);
      article.innerHTML = '<h3>' + esc(recipe.title) + '</h3>' +
        '<ol>' + recipe.steps.map(function (step) { return '<li>' + esc(step) + '</li>'; }).join("") + '</ol>' +
        '<div class="file-list">' + recipe.files.map(function (path) { return fileLink(path, ""); }).join("") + '</div>';
    });
  }

  function renderDeepRefs() {
    $$("[data-refs]").forEach(function (container) {
      var ids = container.dataset.refs.split(",").map(function (id) { return id.trim(); }).filter(Boolean);
      container.innerHTML = ids.map(function (id) { return chipMarkup(id, { jump: true }); }).join("");
    });
  }

  /* ------------------------------------------------------------------- search */

  function searchMatches(query) {
    if (!query) return [];
    var scored = [];
    DATA.nodes.forEach(function (node, index) {
      var label = node.label.toLowerCase();
      var id = node.id.toLowerCase();
      var score = -1;
      if (label === query || id === query) score = 0;
      else if (label.indexOf(query) === 0 || id.indexOf(query) === 0) score = 1;
      else if (label.indexOf(query) !== -1 || id.indexOf(query) !== -1) score = 2;
      else if ([node.tagline, node.role, node.plane].join(" ").toLowerCase().indexOf(query) !== -1) score = 3;
      if (score !== -1) scored.push({ node: node, score: score, index: index });
    });
    scored.sort(function (a, b) { return a.score - b.score || a.index - b.index; });
    return scored.map(function (entry) { return entry.node; });
  }

  function updateSearchCount() {
    var target = $("#search-count");
    if (!target) return;
    var query = state.search.trim().toLowerCase();
    if (!query) {
      target.textContent = "";
      return;
    }
    var count = searchMatches(query).length;
    target.textContent = count + " match" + (count === 1 ? "" : "es");
  }

  function initSearch() {
    var input = $("#node-search");
    if (!input) return;
    input.addEventListener("input", function () {
      state.search = input.value;
      if (state.selected) clearSelection();
      applyMapState();
      updateMapStatus();
      updateSearchCount();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        input.value = "";
        state.search = "";
        applyMapState();
        updateMapStatus();
        updateSearchCount();
        input.blur();
      } else if (event.key === "Enter") {
        var query = state.search.trim().toLowerCase();
        var match = searchMatches(query)[0];
        if (match) {
          selectNode(match.id, { scroll: true });
          input.blur();
        }
      }
    });
    document.addEventListener("keydown", function (event) {
      var tag = (event.target && event.target.tagName || "").toLowerCase();
      var typing = tag === "input" || tag === "textarea" || (event.target && event.target.isContentEditable);
      if ((event.key === "/" && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  /* --------------------------------------------------------------- map controls */

  function initMapControls() {
    var trace = $("#map-trace");
    if (trace) {
      trace.addEventListener("click", function () {
        if (!state.selected) {
          var status = $("#map-status");
          if (status) status.textContent = "Select a component first, then trace its edges.";
          return;
        }
        toggleTrace();
      });
    }
    var focus = $("#map-focus");
    if (focus) focus.addEventListener("click", focusSelected);
    var zoomIn = $("#map-zoom-in");
    if (zoomIn) {
      zoomIn.addEventListener("click", function () {
        zoomAt({ x: state.view.x + state.view.w / 2, y: state.view.y + state.view.h / 2 }, 0.8);
      });
    }
    var zoomOut = $("#map-zoom-out");
    if (zoomOut) {
      zoomOut.addEventListener("click", function () {
        zoomAt({ x: state.view.x + state.view.w / 2, y: state.view.y + state.view.h / 2 }, 1.25);
      });
    }
    var fit = $("#map-fit");
    if (fit) {
      fit.addEventListener("click", function () {
        state.focusNode = null;
        setView({ x: 0, y: 0, w: MAP_W, h: MAP_H });
        applyMapState();
        updateMapStatus();
      });
    }
    var clear = $("#map-clear");
    if (clear) {
      clear.addEventListener("click", function () {
        state.search = "";
        var input = $("#node-search");
        if (input) input.value = "";
        updateSearchCount();
        state.scenario = "all";
        setScenario("all", { silentHash: true });
        state.focusNode = null;
        clearSelection();
        setView({ x: 0, y: 0, w: MAP_W, h: MAP_H });
      });
    }
    var configFilter = $("#config-filter");
    if (configFilter) configFilter.addEventListener("input", function () { renderConfigTable(configFilter.value); });

    document.addEventListener("click", function (event) {
      var target = event.target.closest("[data-node]");
      if (!target) return;
      event.preventDefault();
      selectNode(target.dataset.node, { scroll: target.dataset.jump === "map" });
    });
  }

  /* ---------------------------------------------------------------------- toc */

  function initToc() {
    var links = $$("#toc a").filter(function (link) { return (link.getAttribute("href") || "").charAt(0) === "#"; });
    if (!links.length) return;
    var entries = links.map(function (link) {
      var id = link.getAttribute("href").slice(1);
      var section = document.getElementById(id);
      return section ? { link: link, section: section } : null;
    }).filter(Boolean);
    var ticking = false;
    function update() {
      ticking = false;
      var offset = 110;
      var active = entries[0];
      entries.forEach(function (entry) {
        if (entry.section.getBoundingClientRect().top <= offset) active = entry;
      });
      entries.forEach(function (entry) {
        entry.link.classList.toggle("active", entry === active);
        if (entry === active) entry.link.setAttribute("aria-current", "true");
        else entry.link.removeAttribute("aria-current");
      });
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
  }

  /* --------------------------------------------------------------- deep links */

  function updateHash() {
    if (!window.history || !window.history.replaceState) return;
    var params = new URLSearchParams();
    if (state.selected) params.set("node", state.selected);
    if (state.scenario !== "all") params.set("scenario", state.scenario);
    if (state.timelineTab) params.set("timeline", state.timelineTab);
    if (state.timelineVariant) params.set("variant", state.timelineVariant);
    if (state.flowStep > 0) params.set("step", String(state.flowStep + 1));
    var next = params.toString();
    if (!next) return;
    try { window.history.replaceState(null, "", "#" + next); } catch (_) { /* ignore */ }
  }

  function applyHash() {
    var raw = "";
    try { raw = decodeURIComponent(window.location.hash.replace(/^#/, "")); } catch (_) { raw = window.location.hash.replace(/^#/, ""); }
    if (!raw || raw.indexOf("=") === -1) return;
    var params = new URLSearchParams(raw);
    if (params.has("scenario")) setScenario(params.get("scenario"), { silentHash: true });
    if (params.has("timeline")) setTimelineTab(params.get("timeline"), params.get("variant"), { silentHash: true });
    if (params.has("node")) selectNode(params.get("node"), { silentHash: true });
    if (params.has("step")) setFlowStep((Number(params.get("step")) || 1) - 1, { silentHash: true });
  }

  /* --------------------------------------------------------------------- init */

  function scrollToInitialAnchor() {
    var hash = window.location.hash.replace(/^#/, "");
    if (!hash || hash.indexOf("=") !== -1) return;
    var target = document.getElementById(hash);
    if (!target) return;
    var previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    var top = target.getBoundingClientRect().top + window.scrollY - 82;
    window.scrollTo(0, Math.max(0, top));
    document.documentElement.style.scrollBehavior = previous;
  }

  function init() {
    initTheme();
    renderHeroStats();
    renderMechanics();
    renderScenarios();
    buildMap();
    renderMapLegend();
    renderFlow();
    setFlowStep(0, { silentHash: true });
    setScenario("all", { silentHash: true });
    renderInspector();
    initInspectorActions();
    initFlowActions();
    initTimeline();
    renderTables();
    renderRecipes();
    renderDeepRefs();
    initMapControls();
    initSearch();
    initToc();
    applyHash();
    applyMapState();
    updateMapStatus();
    updateSearchCount();
    window.addEventListener("hashchange", function () {
      applyHash();
      applyMapState();
      updateMapStatus();
    });
    requestAnimationFrame(function () { requestAnimationFrame(scrollToInitialAnchor); });

    if (window.matchMedia) {
      var before = function () {
        $$("details").forEach(function (detail) {
          if (!detail.open) {
            detail.dataset.closedForPrint = "1";
            detail.open = true;
          }
        });
      };
      var after = function () {
        $$("details").forEach(function (detail) {
          if (detail.dataset.closedForPrint === "1") {
            detail.open = false;
            delete detail.dataset.closedForPrint;
          }
        });
      };
      window.addEventListener("beforeprint", before);
      window.addEventListener("afterprint", after);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
