/**
 * Aggregate view (P3, plan §9.2) — heatmap of which UI elements get used
 * most, rendered as overlays on pixel-faithful replicas of each view.
 *
 * - Period picker: sessions multi-select (searchable) OR a UTC from/to range.
 * - Tabs: global "All views" ranked hotspot list + one tab per viewKey with
 *   replica render + heat overlay (stepwise alpha by normalized count) and a
 *   per-view ranked list (mode switch: "all elements" intensity fill vs
 *   "top 5" highlight; clicking a row highlights that node).
 * - Default light theme always: captured themes are ignored (plan §3.8);
 *   every replica and heat chip is drawn from the hardcoded material-3
 *   light baseline — a dark-seeded snapshot renders identically to a light
 *   one (P3 acceptance).
 * - Divergence badge (mode A): "N divergent viewKeys — M keys hidden" with
 *   the version-split entry point per §7 a); hidden while nothing diverges.
 * - CSV export of the exact query via `/api/aggregate/export.csv`.
 */
import {
  api,
  aggregateCsvUrl,
  ApiClientError,
  type AggregateCountDto,
  type AggregateResponse,
  type AggregateViewDto,
  type ParsedSnapshotDto,
  type SessionDto,
} from "../api.js";
import { buildReplicaStage, defaultLightTheme, fitReplica, injectTheme, type UISnapshot } from "@mdu/snapshot-render";

export interface AggregateViewHandle {
  destroy(): void;
}

type OverlayMode = "all" | "top" | "off";
const TOP_N = 5;

/** stepwise alpha ladder for the heatmap fill (primary-tinted, light-safe). */
const HEAT_STEPS = [0, 0.18, 0.34, 0.55, 0.8]; // 0 … max count quartiles

export async function renderAggregateView(app: HTMLElement): Promise<AggregateViewHandle> {
  document.body.classList.add("aggregate-open");
  shell(app);

  const statusEl = app.querySelector<HTMLDivElement>("#agg-source-status")!;
  const selectionPanel = app.querySelector<HTMLDivElement>("#agg-selection")!;
  const resultPanel = app.querySelector<HTMLDivElement>("#agg-result")!;
  const modesEl = app.querySelector<HTMLDivElement>("#agg-period-modes")!;

  let disposed = false;
  let lastQuery: { sessions?: string[]; from?: string; to?: string } | null = null;
  let lastResponse: AggregateResponse | null = null;
  const sessionIndex = new Map<string, SessionDto>();

  /* ------------------------------------------------------- period picker */

  function switchMode(mode: "sessions" | "range"): void {
    for (const button of modesEl.querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
      button.classList.toggle("active", button.dataset.mode === mode);
    }
    selectionPanel.querySelector<HTMLDivElement>("#agg-period-sessions")!.classList.toggle("hidden", mode !== "sessions");
    selectionPanel.querySelector<HTMLDivElement>("#agg-period-range")!.classList.toggle("hidden", mode !== "range");
  }

  for (const button of modesEl.querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
    button.addEventListener("click", () => switchMode((button.dataset.mode as "sessions" | "range") ?? "sessions"));
  }

  app.querySelector<HTMLButtonElement>("#agg-apply")!.addEventListener("click", () => void apply());
  app.querySelector<HTMLButtonElement>("#agg-reload")!.addEventListener("click", () => void apply());

  async function loadSessionIndex(): Promise<void> {
    try {
      const response = await api.sessions({ limit: 1000 });
      sessionIndex.clear();
      for (const session of response.sessions) sessionIndex.set(session.id, session);
      renderSessionChecklist("");
    } catch (error) {
      statusEl.innerHTML = `<span class="pill err">sessions unavailable</span><span class="hint">${esc(describe(error))}</span>`;
    }
  }

  const listEl = selectionPanel.querySelector<HTMLDivElement>("#agg-session-list")!;
  const searchEl = selectionPanel.querySelector<HTMLInputElement>("#agg-session-search")!;

  function selectedSessionIds(): string[] {
    return [...listEl.querySelectorAll<HTMLInputElement>("input[data-session]:checked")].map((input) => input.dataset.session!);
  }

  function renderSessionChecklist(filter: string): void {
    const needle = filter.trim().toLowerCase();
    const sessions = [...sessionIndex.values()].filter(
      (session) =>
        needle === "" ||
        session.id.toLowerCase().includes(needle) ||
        (session.owner ?? "").toLowerCase().includes(needle) ||
        (session.platform ?? "").toLowerCase().includes(needle),
    );
    if (sessions.length === 0) {
      listEl.innerHTML = `<div class="muted">No sessions match.</div>`;
      return;
    }
    listEl.replaceChildren(
      ...sessions.map((session) => {
        const label = document.createElement("label");
        label.className = "agg-session-row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.session = session.id;
        label.append(
          input,
          span("mono agg-session-id", shorten(session.id, 26)),
          span("muted", `${fmtDate(session.startMs)} · ${session.eventCount} ev · ${session.snapshotCount} snap`),
        );
        return label;
      }),
    );
  }

  searchEl.addEventListener("input", () => renderSessionChecklist(searchEl.value));

  async function apply(): Promise<void> {
    const mode = modesEl.querySelector<HTMLButtonElement>("button[data-mode].active")?.dataset.mode ?? "sessions";
    const query: { sessions?: string[]; from?: string; to?: string } = {};
    if (mode === "sessions") {
      const ids = selectedSessionIds();
      if (ids.length === 0) {
        renderResultError("Pick at least one session, or switch to a UTC range.", null);
        return;
      }
      query.sessions = ids;
    } else {
      const from = selectionPanel.querySelector<HTMLInputElement>("#agg-from")!.value;
      const to = selectionPanel.querySelector<HTMLInputElement>("#agg-to")!.value;
      if (from !== "") query.from = from;
      if (to !== "") query.to = to;
      if (from === "" && to === "") {
        renderResultError("Pick at least one UTC bound for a range query.", null);
        return;
      }
    }
    lastQuery = query;
    await fetchAndRender(query);
  }

  async function fetchAndRender(query: NonNullable<typeof lastQuery>): Promise<void> {
    resultPanel.innerHTML = `<div class="state-block loading">Aggregating…</div>`;
    let response: AggregateResponse;
    try {
      response = await api.aggregate(query);
    } catch (error) {
      renderResultError(describe(error), error instanceof ApiClientError ? error.status : null);
      return;
    }
    if (disposed) return;
    lastResponse = response;
    renderResult(response);
  }

  /* ----------------------------------------------------------- rendering */

  let activeViewIndex = 0;
  let overlayMode: OverlayMode = "all";
  let highlightedKey: string | null = null;

  function renderResult(response: AggregateResponse): void {
    const { totals } = response;
    const divergentBadge =
      totals.divergentViewKeys > 0
        ? `<span class="pill warn" id="agg-divergence" title="Mode A counts the intersection only — hidden keys live outside it">${totals.divergentViewKeys} divergent viewKey${totals.divergentViewKeys === 1 ? "" : "s"} — ${totals.hiddenKeys} keys hidden</span>
           <button class="btn small" id="agg-version-split">switch to version split →</button>`
        : "";

    app.querySelector<HTMLDivElement>("#agg-badges")!.innerHTML = `
      <span class="pill ok">${totals.resolvedEvents} counted</span>
      <span class="pill info">${totals.hiddenEvents} hidden (mode A)</span>
      <span class="pill ${totals.unresolvedEvents > 0 ? "warn" : "ok"}">${totals.unresolvedEvents} unresolved</span>
      <span class="pill info">${totals.viewKeys} views</span>
      <span class="pill info">${totals.sessions} sessions</span>
      ${divergentBadge}
    `;

    const splitButton = app.querySelector<HTMLButtonElement>("#agg-version-split");
    if (splitButton !== null) {
      splitButton.addEventListener("click", () => {
        app.querySelector<HTMLDivElement>("#agg-split-notice")!.classList.remove("hidden");
      });
    }

    const exportUrl = lastQuery === null ? "" : aggregateCsvUrl(lastQuery);
    app.querySelector<HTMLAnchorElement>("#agg-export")!.setAttribute("href", exportUrl);

    const warningsEl = app.querySelector<HTMLDivElement>("#agg-warnings")!;
    warningsEl.replaceChildren(
      ...response.warnings.map((text) => {
        const chip = document.createElement("div");
        chip.className = "warn-chip";
        chip.textContent = `⚠ ${text}`;
        return chip;
      }),
    );
    warningsEl.classList.toggle("hidden", response.warnings.length === 0);

    renderViewTabs();
    activeViewIndex = Math.min(activeViewIndex, response.views.length);
    renderActiveTab();
  }

  function renderViewTabs(): void {
    const tabsEl = app.querySelector<HTMLDivElement>("#agg-view-tabs")!;
    const response = lastResponse!;
    const buttons: HTMLButtonElement[] = [
      tabButton("global", "All views", `${response.totals.viewKeys} viewKeys`),
      ...response.views.map((view, index) =>
        tabButton(String(index), shorten(view.viewKey, 22), `${sumCounts(view)} counted${view.divergent ? " · divergent" : ""}`),
      ),
    ];
    for (const button of buttons) {
      button.addEventListener("click", () => {
        activeViewIndex = button.dataset.tab === "global" ? 0 : Number(button.dataset.tab) + 1;
        highlightedKey = null;
        renderActiveTab();
      });
    }
    for (const button of buttons) button.classList.add("agg-tab");
    tabsEl.replaceChildren(...buttons);
    tabsEl.querySelectorAll<HTMLButtonElement>(".agg-tab").forEach((button, position) => {
      button.classList.toggle("active", position === activeViewIndex);
    });
  }

  function tabButton(id: string, label: string, hint: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tab = id;
    button.innerHTML = `<span>${esc(label)}</span><span class="muted">${esc(hint)}</span>`;
    return button;
  }

  function renderActiveTab(): void {
    const body = app.querySelector<HTMLDivElement>("#agg-tab-body")!;
    app.querySelectorAll(".agg-tab").forEach((button, position) => {
      button.classList.toggle("active", position === activeViewIndex);
    });
    const response = lastResponse!;
    const isGlobal = activeViewIndex === 0;
    body.classList.toggle("global", isGlobal);
    if (isGlobal) {
      renderGlobalTab(body);
      return;
    }
    const view = response.views[activeViewIndex - 1]!;
    if (view.template === null) {
      body.innerHTML = `<div class="state-block warn"><h2>No template for ${esc(view.viewKey)}</h2><p>${
        view.counts.length > 0
          ? "Counts exist, but the template snapshot could not be resolved from the store."
          : "No parsed snapshots and no counted events for this view in the selection."
      }</p></div>`;
      return;
    }
    body.innerHTML = `
      <div class="agg-view-layout">
        <section class="replica-panel panel">
          <div class="replica-head">
            <div class="replica-title">${esc(view.viewKey)} <span class="muted">· template ${esc(view.template.parsed.timestampUtc ?? "")}</span></div>
            <div class="segmented" id="agg-overlay-modes" role="tablist" aria-label="Overlay mode">
              <button type="button" data-overlay="all">All elements</button>
              <button type="button" data-overlay="top">Top ${TOP_N}</button>
              <button type="button" data-overlay="off">Off</button>
            </div>
          </div>
          <div class="replica-viewport" id="agg-replica-viewport"><div class="replica-holder"></div></div>
          <div class="agg-legend">
            <span class="heat-swatch s1"></span> low
            <span class="heat-swatch s4"></span> mid
            <span class="heat-swatch s8"></span> hot
            <span class="muted">— alpha steps of count/max${view.divergent ? ` (${view.hiddenEventCount} events outside the mode-A intersection are excluded)` : ""}</span>
          </div>
        </section>
        <aside class="agg-side panel">
          <div class="replica-title">Ranked elements <span class="muted">· click to highlight</span></div>
          <div class="agg-rows" id="agg-rows"></div>
        </aside>
      </div>
    `;

    // Overlay mode segmented control
    const modesRow = body.querySelector<HTMLDivElement>("#agg-overlay-modes")!;
    for (const button of modesRow.querySelectorAll<HTMLButtonElement>("button[data-overlay]")) {
      button.classList.toggle("active", button.dataset.overlay === overlayMode);
      button.addEventListener("click", () => {
        overlayMode = (button.dataset.overlay as OverlayMode) ?? "all";
        for (const other of modesRow.querySelectorAll<HTMLButtonElement>("button[data-overlay]")) {
          other.classList.toggle("active", other.dataset.overlay === overlayMode);
        }
        paintOverlay(view);
      });
    }

    // Replica (default light, always) + heat overlay
    const holder = body.querySelector<HTMLDivElement>(".replica-holder")!;
    const viewport = body.querySelector<HTMLDivElement>("#agg-replica-viewport")!;
    holder.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    const replica = buildReplicaStage(holderFirst(view.template.parsed), holder, "default-light");
    // Explicit default-light tokens for CSS driven bits (overlay legend).
    injectTheme(defaultLightTheme(), replica.stage);
    requestAnimationFrame(() => fitReplica(replica.stage, viewport));
    paintOverlay(view);
    renderRows(view);
  }

  function holderFirst(parsed: ParsedSnapshotDto): UISnapshot {
    return parsed as unknown as UISnapshot;
  }

  function paintOverlay(view: AggregateViewDto): void {
    const body = app.querySelector<HTMLDivElement>("#agg-tab-body")!;
    body.querySelectorAll(".heat-overlay").forEach((node) => node.remove());
    const ranked = [...view.counts].sort((a, b) => b.count - a.count);
    const max = ranked[0]?.count ?? 0;
    if (max === 0 || overlayMode === "off") return;
    for (const [rank, row] of ranked.entries()) {
      if (row.templateNodeId === null) continue;
      const target = body.querySelector<HTMLElement>(`[data-node-id="${cssEscape(row.templateNodeId)}"]`);
      if (target === null) continue;
      const alpha =
        overlayMode === "top"
          ? rank < TOP_N
            ? 0.85
            : 0.06
          : HEAT_STEPS[Math.min(HEAT_STEPS.length - 1, Math.ceil((row.count / max) * (HEAT_STEPS.length - 1)))];
      const overlay = document.createElement("div");
      overlay.className = "heat-overlay";
      overlay.style.opacity = String(alpha);
      if (overlayMode === "top" && rank < TOP_N) overlay.classList.add("top");
      if (highlightedKey !== null && row.key === highlightedKey) overlay.classList.add("selected");
      target.appendChild(overlay);
    }
  }

  function renderRows(view: AggregateViewDto): void {
    const rowsEl = app.querySelector<HTMLDivElement>("#agg-rows")!;
    const ranked = [...view.counts].sort((a, b) => b.count - a.count);
    for (const [index, row] of ranked.entries()) {
      const rowEl = document.createElement("button");
      rowEl.type = "button";
      rowEl.className = "agg-row";
      const share = view.counts.reduce((sum, item) => sum + item.count, 0);
      const barWidth = share > 0 ? Math.round((row.count / share) * 100) : 0;
      rowEl.innerHTML = `
        <div class="agg-row-head"><span class="agg-rank mono">${esc(String(index + 1).padStart(2, "0"))}</span>
          <span class="agg-leaf">${esc(row.leafLabel)}</span>
          <span class="pill ok small">${row.count}</span></div>
        <div class="agg-bar"><span style="width:${barWidth}%"></span></div>
        <div class="agg-row-sub muted mono">${esc(row.key)}
          <span class="chip ${row.confidence === "approximate" ? "warn" : "info"}">${row.confidence}</span>
          ${dimText(row.dimensions)}</div>
      `;
      rowEl.addEventListener("click", () => {
        highlightedKey = row.key;
        rowsEl.querySelectorAll(".agg-row").forEach((node) => node.classList.remove("active"));
        rowEl.classList.add("active");
        paintOverlay(view);
      });
      rowsEl.appendChild(rowEl);
    }
    if (view.hiddenKeyCount > 0) {
      const notice = document.createElement("div");
      notice.className = "warn-chip";
      notice.textContent = `⊕ version split available — ${view.hiddenKeyCount} key(s) outside mode A (${view.hiddenEventCount} events)`;
      rowsEl.prepend(notice);
    }
    if (ranked.length === 0 && view.hiddenKeyCount === 0) {
      rowsEl.innerHTML = `<div class="muted">No counted elements for this view.</div>`;
    }
  }

  function renderGlobalTab(body: HTMLDivElement): void {
    const response = lastResponse!;
    const all = response.views
      .flatMap((view) => view.counts.map((row) => ({ ...row, viewKey: view.viewKey })))
      .sort((a, b) => b.count - a.count);
    const total = all.reduce((sum, row) => sum + row.count, 0);
    body.innerHTML = `
      <div class="agg-global-panel panel">
        <div class="replica-title">Hotspots across all views <span class="muted">· click to jump to the view · top ${Math.min(all.length, 25)} of ${all.length} keys · ${total} events</span></div>
        <ol class="agg-rows agg-global-rows">
          ${all
            .slice(0, 25)
            .map(
              (row, index) => `<li class="agg-row" data-view="${esc(row.viewKey)}" data-key="${esc(row.key)}" role="button" tabindex="0">
                <div class="agg-row-head"><span class="agg-rank mono">${String(index + 1).padStart(2, "0")}</span>
                  <span class="agg-leaf">${esc(row.leafLabel)}</span><span class="pill ok small">${row.count}</span></div>
                <div class="agg-bar"><span style="width:${total > 0 ? Math.round((row.count / total) * 100) : 0}%"></span></div>
                <div class="agg-row-sub muted mono">${esc(row.viewKey)} · ${esc(row.elementType ?? "?")}
                  <span class="chip ${row.confidence === "approximate" ? "warn" : "info"}">${row.confidence}</span></div>
              </li>`,
            )
            .join("")}
        </ol>
      </div>
    `;
    if (all.length === 0) {
      body.innerHTML = `<div class="state-block muted"><h2>Nothing counted yet</h2><p>No resolved interactions in this selection.</p></div>`;
      return;
    }
    // Jump-to: clicking a global hotspot opens its view tab pre-highlighted.
    for (const row of body.querySelectorAll<HTMLLIElement>(".agg-row")) {
      const jump = (): void => {
        const viewIndex = response.views.findIndex((view) => view.viewKey === row.dataset.view);
        if (viewIndex === -1) return;
        activeViewIndex = viewIndex + 1;
        highlightedKey = row.dataset.key ?? null;
        renderActiveTab();
      };
      row.addEventListener("click", jump);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          jump();
        }
      });
    }
  }

  function renderResultError(message: string, status: number | null): void {
    resultPanel.innerHTML = `
      <div class="state-block ${status === null || status >= 500 ? "err" : "warn"}">
        <h2>Aggregate unavailable</h2>
        <p>${esc(message)}</p>
      </div>`;
  }

  /* -------------------------------------------------------------- status */

  void loadSessionIndex();
  switchMode("sessions");

  return {
    destroy() {
      disposed = true;
      document.body.classList.remove("aggregate-open");
    },
  };
}

/* ---------------------------------------------------------------- shell */

function shell(app: HTMLElement): void {
  app.innerHTML = `
    <header class="topbar">
      <a class="btn small" href="#/">← Sessions</a>
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h2 class="session-title">Aggregate <span class="phase-chip">P3 · common-only</span></h2>
      </div>
      <div class="session-meta" id="agg-badges"></div>
    </header>
    <main class="layout">
      <section class="panel toolbar agg-selection" id="agg-selection">
        <div class="segmented" id="agg-period-modes" role="tablist" aria-label="Period mode">
          <button type="button" data-mode="sessions">Sessions</button>
          <button type="button" data-mode="range">UTC range</button>
        </div>
        <div id="agg-period-sessions" class="field agg-field-wide">
          <label for="agg-session-search">Sessions (multi-select)</label>
          <input id="agg-session-search" type="search" placeholder="filter by id / owner / platform…" autocomplete="off" />
          <div id="agg-session-list" class="agg-session-list"></div>
        </div>
        <div id="agg-period-range" class="hidden">
          <div class="field">
            <label for="agg-from">From (UTC)</label>
            <input id="agg-from" type="date" />
          </div>
          <div class="field">
            <label for="agg-to">To (UTC)</label>
            <input id="agg-to" type="date" />
          </div>
        </div>
        <div class="agg-actions">
          <button id="agg-apply" class="btn primary">Aggregate</button>
          <button id="agg-reload" class="btn small">Reload</button>
          <a id="agg-export" class="btn small" href="#">Export CSV</a>
          <div id="agg-source-status"></div>
        </div>
      </section>
      <div id="agg-split-notice" class="state-block warn hidden">
        <h2>Version split (mode B)</h2>
        <p>Mode B and mode C ship with P4 (<code>extra/telemetry-viewer</code> plan §7). Until then, mode A keeps
        counting the intersection of all structure versions; the hidden keys above stay honest and quantified.</p>
      </div>
      <div id="agg-warnings" class="hidden"></div>
      <div class="agg-tabs" id="agg-view-tabs"></div>
      <section id="agg-result" class="panel"></section>
    </main>
    <footer class="hints">
      <span>Counts use canonical element keys (tree paths) — identical elements in different sessions sum together. The replica always renders the default-light theme; captured themes are ignored.</span>
    </footer>
  `;
}

/* ------------------------------------------------------------- utilities */

function sumCounts(view: AggregateViewDto): number {
  return view.counts.reduce((sum, row) => sum + row.count, 0);
}

function dimText(dimensions: AggregateCountDto["dimensions"]): string {
  if (dimensions === null || (dimensions.width === null && dimensions.height === null)) return "";
  return `<span class="pill info small">${dimensions.width ?? "?"}×${dimensions.height ?? "?"}</span>`;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function esc(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function shorten(id: string, max: number): string {
  return id.length > max ? `${id.slice(0, max - 6)}…${id.slice(-5)}` : id;
}

function fmtDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function describe(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.body.code}: ${error.body.message}${error.body.detail ? ` — ${error.body.detail}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}
