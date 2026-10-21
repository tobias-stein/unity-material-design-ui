/**
 * Aggregate view (P3/P4, plan §9.2) — heatmap of which UI elements get used
 * most, rendered as overlays on pixel-faithful replicas of each view.
 *
 * - Period picker: sessions multi-select (searchable) OR a UTC from/to range.
 * - Tabs: global "All views" ranked hotspot list + one tab per viewKey with
 *   replica render + heat overlay (stepwise alpha by normalized count) and a
 *   per-view ranked list (mode switch: "all elements" intensity fill vs
 *   "top 5" highlight; clicking a row highlights that node).
 * - Default light theme always: captured themes are ignored (plan §3.8).
 * - Version mode machine (§7, P4):
 *   [A common-only] —– divergence —→ [B version split] —– pick —→
 *   [C ground-truth merge] —– exit —→ [B] (pick retained). Returning to A
 *   re-intersects cleanly (no leftover filters); the divergence badge is the
 *   split entry point.
 * - CSV export of the exact query via `/api/aggregate/export.csv`.
 *
 * Rendering detail: every visible "surface" (a view's template, a version
 * group's template, the merged ground truth) goes through the same
 * `renderSurface` helper — replica + heat overlay + ranked rows — so overlay
 * and list behavior is identical in all three modes.
 */
import {
  api,
  aggregateCsvUrl,
  ApiClientError,
  type AggregateCountDto,
  type AggregateMergeDto,
  type AggregateMergeRowDto,
  type AggregateQuery,
  type AggregateResponse,
  type AggregateVersionGroupDto,
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
  let lastQuery: AggregateQuery | null = null;
  let lastResponse: AggregateResponse | null = null;
  const sessionIndex = new Map<string, SessionDto>();

  /* chapter mode machine (§7) */
  type VersionMode = "a" | "b" | "c";
  let versionMode: VersionMode = "a";
  let pickedGroup: string | null = null; // "<viewKey>#<i>" (C pick; kept on exit)

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

  /* ------------------------------------------------- mode machine actions */

  function enterSplit(): void {
    // A → B keeps the last pick (may be re-entered per group), clears nothing.
    versionMode = "b";
    void refetch();
  }

  function backToCommon(): void {
    versionMode = "a";
    void refetch();
  }

  function pickGroundTruth(groupId: string): void {
    pickedGroup = groupId;
    versionMode = "c";
    void refetch();
  }

  function exitMerge(): void {
    // §7 C: exit → back to B, the picked version stays remembered.
    versionMode = "b";
    void refetch();
  }

  async function apply(): Promise<void> {
    const mode = modesEl.querySelector<HTMLButtonElement>("button[data-mode].active")?.dataset.mode ?? "sessions";
    const query: AggregateQuery = {};
    if (versionMode === "b") query.mode = "b";
    if (versionMode === "c") {
      if (pickedGroup === null) {
        versionMode = "b";
        query.mode = "b";
      } else {
        query.mode = "c";
        query.group = pickedGroup;
      }
    }
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

  async function refetch(): Promise<void> {
    if (lastQuery === null) return; // nothing rendered yet: idle
    await fetchAndRender({ ...lastQuery, ...modeParams() });
  }

  function modeParams(): Pick<AggregateQuery, "mode" | "group"> {
    if (versionMode === "b") return { mode: "b" };
    if (versionMode === "c" && pickedGroup !== null) return { mode: "c", group: pickedGroup };
    return {};
  }

  /**
   * The tab body lives inside #agg-result; error/loading renders used to wipe
   * the whole panel (destroying it), which crashed the next renderResult with
   * "Cannot set properties of null (setting 'innerHTML')". Always render into
   * the preserved holder, recreating it if a previous render removed it.
   */
  function ensureTabBody(): HTMLDivElement {
    let body = resultPanel.querySelector<HTMLDivElement>("#agg-tab-body");
    if (body === null) {
      body = document.createElement("div");
      body.id = "agg-tab-body";
      resultPanel.replaceChildren(body);
    }
    return body;
  }

  async function fetchAndRender(query: AggregateQuery): Promise<void> {
    ensureTabBody().innerHTML = `<div class="state-block loading">Aggregating…</div>`;
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
    const mode = response.selection.mode;

    // Mode pill + machine controls (§7 A→B→C→B→A).
    const control = renderModeControl(mode, totals);

    app.querySelector<HTMLDivElement>("#agg-badges")!.innerHTML = `
      <span class="pill ok">${totals.resolvedEvents} counted</span>
      ${totalsBadge(mode, totals)}
      <span class="pill ${totals.unresolvedEvents > 0 ? "warn" : "ok"}">${totals.unresolvedEvents} unresolved</span>
      <span class="pill info">${totals.viewKeys} views</span>
      <span class="pill info">${totals.sessions} sessions</span>
      ${control}
    `;
    bindModeControl();

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

  function totalsBadge(mode: "a" | "b" | "c", totals: NonNullable<AggregateResponse>["totals"]): string {
    if (mode === "b") {
      return `<span class="pill info">version split</span>`;
    }
    if (mode === "c") {
      return `<span class="pill info">${totals.foldedEvents} folded</span><span class="pill ${
        totals.unmatchedEvents > 0 ? "warn" : "ok"
      }">${totals.unmatchedEvents} unmatched</span>`;
    }
    return `<span class="pill info">${totals.hiddenEvents} hidden (mode A)</span>`;
  }

  function renderModeControl(
    mode: "a" | "b" | "c",
    totals: NonNullable<AggregateResponse>["totals"],
  ): string {
    const backToSplit =
      mode === "c"
        ? `<button class="btn small" id="agg-mode-exit">exit merge → back to split</button>`
        : "";
    const backToCommon =
      mode === "a"
        ? ""
        : `<button class="btn small" id="agg-mode-common">→ common (mode A)</button>`;
    const divergentBadge =
      mode === "a" && totals.divergentViewKeys > 0
        ? `<button class="btn small" id="agg-mode-split" title="Mode A counts the intersection only — hidden keys live outside it">switch to version split →</button>`
        : "";
    const hint =
      mode === "a"
        ? totals.divergentViewKeys > 0
          ? `<span class="pill warn">${totals.divergentViewKeys} divergent viewKey${totals.divergentViewKeys === 1 ? "" : "s"} — ${totals.hiddenKeys} keys hidden</span>`
          : ""
        : mode === "c"
          ? `<span class="pill info" title="Ground truth picked: ${esc(pickedGroup ?? "")}">ground truth ${esc(shorten(pickedGroup ?? "?", 40))}</span>`
          : "";
    return `${hint}${divergentBadge}${backToSplit}${backToCommon}`;
  }

  function bindModeControl(): void {
    const split = app.querySelector<HTMLButtonElement>("#agg-mode-split");
    if (split !== null) split.addEventListener("click", enterSplit);
    const common = app.querySelector<HTMLButtonElement>("#agg-mode-common");
    if (common !== null) common.addEventListener("click", () => {
      // Returning to A re-intersects cleanly (no leftover filters/geometry).
      highlightedKey = null;
      backToCommon();
    });
    const exit = app.querySelector<HTMLButtonElement>("#agg-mode-exit");
    if (exit !== null) exit.addEventListener("click", exitMerge);
  }

  function renderViewTabs(): void {
    const tabsEl = app.querySelector<HTMLDivElement>("#agg-view-tabs")!;
    const response = lastResponse!;
    const buttons: HTMLButtonElement[] = [
      tabButton("global", "All views", `${response.totals.viewKeys} viewKeys`),
      ...response.views.map((view, index) =>
        tabButton(String(index), shorten(view.viewKey, 22), tabHint(view)),
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

  function tabHint(view: AggregateViewDto): string {
    if (view.divergent && (view.versions?.length ?? 0) > 0) {
      return `${view.versionCount} versions · ${view.versions!.reduce((sum, g) => sum + g.eventCount, 0)} ev`;
    }
    if (view.merge !== null) {
      return `merged · ${view.merge.rows.reduce((sum, r) => sum + r.count, 0)} + ${view.merge.unmatched.reduce((s, r) => s + r.count, 0)} unmatched`;
    }
    return `${view.counts.reduce((sum, row) => sum + row.count, 0)} counted${view.divergent ? " · divergent" : ""}`;
  }

  function tabButton(id: string, label: string, hint: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tab = id;
    button.innerHTML = `<span>${esc(label)}</span><span class="muted">${esc(hint)}</span>`;
    return button;
  }

  function renderActiveTab(): void {
    const body = ensureTabBody();
    body.innerHTML = "";
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
    if (view.merge !== null) {
      renderMergedView(body, view);
      return;
    }
    if ((view.versions?.length ?? 0) > 0) {
      for (const group of view.versions!) renderVersionGroup(body, view, group);
      return;
    }
    if (view.template === null) {
      body.innerHTML = `<div class="state-block warn"><h2>No template for ${esc(view.viewKey)}</h2><p>${
        view.counts.length > 0
          ? "Counts exist, but the template snapshot could not be resolved from the store."
          : "No parsed snapshots and no counted events for this view in the selection."
      }</p></div>`;
      return;
    }
    renderSurface(body, {
      title: `${esc(view.viewKey)} <span class="muted">· template ${esc(view.template.parsed.timestampUtc ?? "")}</span>`,
      template: view.template,
      counts: view.counts,
      hiddenNote: view.hiddenKeyCount > 0
        ? `version split available — ${view.hiddenKeyCount} key(s) outside mode A (${view.hiddenEventCount} events)`
        : null,
    });
  }

  /* ---------------------------------------------------------------- modes */

  /** One version group of a divergent viewKey (mode B, plan §7 B). */
  function renderVersionGroup(body: HTMLDivElement, view: AggregateViewDto, group: AggregateVersionGroupDto): void {
    if (group.template === null) {
      body.insertAdjacentHTML(
        "beforeend",
        `<div class="state-block warn"><h2>Version ${group.index} of ${esc(view.viewKey)}</h2><p>
          Group counts exist (${group.eventCount} events), but this version's template snapshot could not be resolved.</p></div>`,
      );
      return;
    }
    renderSurface(body, {
      title: `${esc(view.viewKey)} <span class="pill info">version ${group.index}</span> <span class="muted mono">· ${esc(group.fingerprint.slice(0, 10))}</span>
        <span class="muted">· own ${group.eventCount} events · ${group.keyCount} keys</span>`,
      template: group.template,
      counts: group.counts,
      hiddenNote: null,
      diffNote: `⊕ ${group.addedKeys.length} new · ⊖ ${group.removedKeys.length} missing vs earliest`,
      diffRows: [...group.addedKeys.map((key) => ({ key, sign: 1 as const })), ...group.removedKeys.map((key) => ({ key, sign: -1 as const }))],
      onPick: () => pickGroundTruth(group.groupId),
    });
  }

  /** The ground-truth merge tab body (mode C, plan §7 C). */
  function renderMergedView(body: HTMLDivElement, view: AggregateViewDto): void {
    const merge = view.merge!;
    if (view.template === null) {
      body.innerHTML = `<div class="state-block warn"><h2>Ground truth of ${esc(view.viewKey)}</h2><p>
        Merge computed, but the picked version's template snapshot could not be resolved — counts lose their overlay geometry.</p></div>`;
      renderUnmatchedPanel(body, merge);
      return;
    }
    renderSurface(body, {
      surfaceClass: "agg-merged-view",
      title: `${esc(view.viewKey)} <span class="pill ok">ground truth v${merge.groundTruthIndex}</span> <span class="muted mono">· pick ${esc(merge.groupId)}</span>
        <span class="muted">· folded ${merge.foldedEvents} · unmatched ${merge.unmatchedEvents}</span>`,
      template: view.template,
      counts: view.counts,
      hiddenNote: null,
      merged: merge,
    });
    renderUnmatchedPanel(body, merge);
  }

  function renderUnmatchedPanel(body: HTMLDivElement, merge: AggregateMergeDto): void {
    const count = merge.unmatched.reduce((sum, row) => sum + row.count, 0);
    const panel = document.createElement("aside");
    panel.className = "agg-side panel agg-unmatched";
    if (merge.unmatched.length === 0) {
      panel.innerHTML = `<div class="replica-title">Unmatched keys</div><div class="muted">Every key of the other versions folded into the ground truth.</div>`;
    } else {
      panel.innerHTML = `
        <div class="replica-title">Unmatched keys <span class="pill warn small">${merge.unmatched.length} keys · ${count} events</span></div>
        <div class="muted hint-line">These keys exist in other structure versions and matched no ground-truth key (longest-common-ancestry). Counted nowhere else — never dropped.</div>
        <div class="agg-rows">${merge.unmatched
          .map(
            (row) => `<div class="agg-row static">
              <div class="agg-row-head"><span class="pill info small">v${row.versionIndex}</span>
                <span class="agg-leaf">${esc(row.leafLabel)}</span><span class="pill ok small">${row.count}</span></div>
              <div class="agg-row-sub muted mono">${esc(row.key)}${row.elementType === null ? "" : ` · ${esc(row.elementType)}`}</div>
            </div>`,
          )
          .join("")}</div>`;
    }
    body.appendChild(panel);
  }

  /* -------------------------------------------------------- shared surface */

  interface SurfaceSpec {
    title: string;
    template: NonNullable<AggregateViewDto["template"]>;
    counts: readonly AggregateCountDto[];
    hiddenNote: string | null;
    diffNote?: string;
    diffRows?: Array<{ key: string; sign: 1 | -1 }>;
    merged?: AggregateMergeDto;
    onPick?: () => void;
    surfaceClass?: string;
  }

  /** Replica + heat overlay + ranked rows: the one way every surface renders. */
  function renderSurface(body: HTMLDivElement, spec: SurfaceSpec): void {
    const section = document.createElement("div");
    section.className = spec.surfaceClass === undefined ? "agg-view-layout" : `agg-view-layout ${spec.surfaceClass}`;
    section.innerHTML = `
      <section class="replica-panel panel">
        <div class="replica-head">
          <div class="replica-title">${spec.title}</div>
          <div class="segmented" role="tablist" aria-label="Overlay mode">
            <button type="button" data-overlay="all">All elements</button>
            <button type="button" data-overlay="top">Top ${TOP_N}</button>
            <button type="button" data-overlay="off">Off</button>
          </div>
        </div>
        <div class="agg-mode-actions">${modeActions(spec) ?? ""}</div>
        ${
          spec.diffNote !== undefined && spec.diffNote !== ""
            ? `<div class="agg-diff-note mono" title="${esc(diffTooltip(spec))}">${esc(spec.diffNote)}</div>` +
              renderChips(spec)
            : ""
        }
        <div class="replica-viewport"><div class="replica-holder"></div></div>
        <div class="agg-legend">
          <span class="heat-swatch s1"></span> low
          <span class="heat-swatch s4"></span> mid
          <span class="heat-swatch s8"></span> hot
          <span class="muted">— alpha steps of count/max</span>
        </div>
      </section>
      <aside class="agg-side panel">
        <div class="replica-title">Ranked elements <span class="muted">· click to highlight</span></div>
        <div class="agg-rows"></div>
      </aside>
    `;
    body.appendChild(section);
    if (spec.onPick !== undefined) {
      section.querySelector<HTMLButtonElement>("button[data-pick]")?.addEventListener("click", spec.onPick);
    }
    if (spec.merged !== undefined) {
      section.querySelector<HTMLButtonElement>("button[data-exit-merge]")?.addEventListener("click", exitMerge);
    }

    // Overlay mode segmented control
    const modesRow = section.querySelector<HTMLDivElement>(".segmented")!;
    for (const button of modesRow.querySelectorAll<HTMLButtonElement>("button[data-overlay]")) {
      button.classList.toggle("active", button.dataset.overlay === overlayMode);
      button.addEventListener("click", () => {
        overlayMode = (button.dataset.overlay as OverlayMode) ?? "all";
        for (const other of modesRow.querySelectorAll<HTMLButtonElement>("button[data-overlay]")) {
          other.classList.toggle("active", other.dataset.overlay === overlayMode);
        }
        paintOverlay(section, spec.counts);
      });
    }

    // Replica (default light, always) + heat overlay — wheel stays inert.
    const holder = section.querySelector<HTMLDivElement>(".replica-holder")!;
    const viewport = section.querySelector<HTMLDivElement>(".replica-viewport")!;
    holder.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    const replica = buildReplicaStage(asUISnapshot(spec.template.parsed), holder, "default-light");
    // Explicit default-light tokens for CSS driven bits (overlay legend).
    injectTheme(defaultLightTheme(), replica.stage);
    requestAnimationFrame(() => fitReplica(replica.stage, viewport));
    paintOverlay(section, spec.counts);
    renderRows(section, spec);
  }

  /** Mode-C / mode-B per-group action row (pick as ground truth, exit merge). */
  function modeActions(spec: SurfaceSpec): string | null {
    if (spec.onPick !== undefined) {
      return `<button class="btn small primary" data-pick title="mode C: fold the other versions into this one's geometry">pick as ground truth →</button>`;
    }
    if (spec.merged !== undefined) {
      return `<button class="btn small" data-exit-merge>exit merge → back to split</button>`;
    }
    return null;
  }

  function diffTooltip(spec: SurfaceSpec): string {
    return [
      ...(spec.diffRows ?? []).map((row) => `${row.sign > 0 ? "⊕" : "⊖"} ${row.key}`),
    ].join("\n");
  }

  function renderChips(spec: SurfaceSpec): string {
    const chips = (spec.diffRows ?? []).map(
      (row) =>
        `<span class="chip ${row.sign > 0 ? "add" : "remove"}" title="${esc(row.key)}">${row.sign > 0 ? "⊕" : "⊖"} ${esc(leafOf(row.key))}</span>`,
    );
    return chips.length === 0 ? "" : `<div class="agg-diff-chips">${chips.join(" ")}</div>`;
  }

  function leafOf(key: string): string {
    return key.split(" › ")[key.split(" › ").length - 2] ?? key;
  }

  function paintOverlay(section: HTMLDivElement, counts: readonly AggregateCountDto[]): void {
    section.querySelectorAll(".heat-overlay").forEach((node) => node.remove());
    const ranked = [...counts].sort((a, b) => b.count - a.count);
    const max = ranked[0]?.count ?? 0;
    if (max === 0 || overlayMode === "off") return;
    for (const [rank, row] of ranked.entries()) {
      if (row.templateNodeId === null) continue;
      const target = section.querySelector<HTMLElement>(`[data-node-id="${cssEscape(row.templateNodeId)}"]`);
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

  function renderRows(section: HTMLDivElement, spec: SurfaceSpec): void {
    const rowsEl = section.querySelector<HTMLDivElement>(".agg-rows")!;
    const ranked = [...spec.counts].sort((a, b) => b.count - a.count);
    for (const [index, row] of ranked.entries()) {
      rowsEl.appendChild(countRow(section, rowsEl, spec, row, index));
    }
    if (spec.hiddenNote !== null) {
      const notice = document.createElement("div");
      notice.className = "warn-chip";
      notice.textContent = `⊕ ${spec.hiddenNote}`;
      rowsEl.prepend(notice);
    }
    if (ranked.length === 0 && spec.diffNote === undefined && spec.hiddenNote === null) {
      rowsEl.innerHTML = `<div class="muted">No counted elements for this view.</div>`;
    }
  }

  function countRow(
    section: HTMLDivElement,
    rowsEl: HTMLDivElement,
    spec: SurfaceSpec,
    row: AggregateCountDto | AggregateMergeRowDto,
    index: number,
  ): HTMLElement {
    const rowEl = document.createElement("button");
    rowEl.type = "button";
    rowEl.className = "agg-row";
    const share = spec.counts.reduce((sum, item) => sum + item.count, 0);
    const barWidth = share > 0 ? Math.round((row.count / share) * 100) : 0;
    const foldNote = isMergeRow(row) && row.folded.length > 0
      ? ` <span class="chip info small" title="${esc(foldTooltip(row))}">+${row.count - row.ownCount} folded</span>`
      : "";
    rowEl.innerHTML = `
      <div class="agg-row-head"><span class="agg-rank mono">${esc(String(index + 1).padStart(2, "0"))}</span>
        <span class="agg-leaf">${esc(row.leafLabel)}</span>
        <span class="pill ok small">${row.count}</span>${foldNote}</div>
      <div class="agg-bar"><span style="width:${barWidth}%"></span></div>
      <div class="agg-row-sub muted mono">${esc(row.key)}
        <span class="chip ${row.confidence === "approximate" ? "warn" : "info"}">${row.confidence}</span>
        ${dimText(row.dimensions)}</div>
    `;
    rowEl.addEventListener("click", () => {
      highlightedKey = row.key;
      rowsEl.querySelectorAll(".agg-row").forEach((node) => node.classList.remove("active"));
      rowEl.classList.add("active");
      paintOverlay(section, spec.counts);
    });
    return rowEl;
  }

  function isMergeRow(row: AggregateCountDto | AggregateMergeRowDto): row is AggregateMergeRowDto {
    return "ownCount" in row;
  }

  function foldTooltip(row: AggregateMergeRowDto): string {
    return row.folded
      .map(
        (fold) =>
          `v${fold.versionIndex} ${fold.key} ×${fold.count} (depth ${fold.matched}${fold.wildcards > 0 ? `, ${fold.wildcards} wildcard${fold.wildcards === 1 ? "" : "s"}` : ""})`,
      )
      .join("\n");
  }

  function renderGlobalTab(body: HTMLDivElement): void {
    const response = lastResponse!;
    // Rows: whatever is visible in the current mode — plain counts, version
    // groups (mode B) or the merged ground truth + unmatched (mode C).
    const rows = response.views.flatMap((view) => {
      const merged = view.merge !== null
        ? view.merge.rows.map((row) => ({ ...row, surface: view.viewKey }))
        : view.counts.map((row) => ({ ...row, surface: view.viewKey }));
      const groupRows = (view.versions ?? []).flatMap((group) =>
        group.counts.map((row) => ({ ...row, surface: `${view.viewKey}#v${group.index}` })),
      );
      const unmatchedRows =
        view.merge === null
          ? []
          : view.merge.unmatched.map((row) => ({
              ...row,
              count: row.count,
              leafLabel: row.leafLabel,
              templateNodeId: null,
              dimensions: null,
              confidence: "exact" as const,
              elementType: row.elementType,
              surface: `${view.viewKey}#v${row.versionIndex} (unmatched)`,
            }));
      return [...merged, ...groupRows, ...unmatchedRows];
    });
    // Count tables skip the zero rows (structure-only keys).
    const visible = rows.filter((row) => row.count > 0).sort((a, b) => b.count - a.count);
    if (visible.length === 0) {
      body.innerHTML = `<div class="state-block muted"><h2>Nothing counted yet</h2><p>No resolved interactions in this selection.</p></div>`;
      return;
    }
    const total = visible.reduce((sum, row) => sum + row.count, 0);
    body.innerHTML = `
      <div class="agg-global-panel panel">
        <div class="replica-title">Hotspots across all surfaces <span class="muted">· click to jump to its view · top ${Math.min(visible.length, 25)} of ${visible.length} keys · ${total} events</span></div>
        <ol class="agg-rows agg-global-rows">
          ${visible
            .slice(0, 25)
            .map(
              (row, index) => `<li class="agg-row" data-view="${esc(surfaceViewKey(row.surface))}" data-key="${esc(row.key)}" role="button" tabindex="0">
                <div class="agg-row-head"><span class="agg-rank mono">${String(index + 1).padStart(2, "0")}</span>
                  <span class="agg-leaf">${esc(row.leafLabel)}</span><span class="pill ok small">${row.count}</span></div>
                <div class="agg-bar"><span style="width:${total > 0 ? Math.round((row.count / total) * 100) : 0}%"></span></div>
                <div class="agg-row-sub muted mono">${esc(row.surface)} · ${esc(row.elementType ?? "?")}
                  <span class="chip ${row.confidence === "approximate" ? "warn" : "info"}">${row.confidence}</span></div>
              </li>`,
            )
            .join("")}
        </ol>
      </div>
    `;
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

  function surfaceViewKey(surface: string): string {
    return surface.split("#")[0] ?? surface;
  }

  function renderResultError(message: string, status: number | null): void {
    ensureTabBody().innerHTML = `
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
        <h2 class="session-title">Aggregate <span class="phase-chip">A · B · C version modes</span></h2>
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
      <div id="agg-warnings" class="hidden"></div>
      <div class="agg-tabs" id="agg-view-tabs"></div>
      <section id="agg-result" class="panel"><div class="state-block muted" id="agg-tab-body"></div></section>
    </main>
    <footer class="hints">
      <span>Counts use canonical element keys (tree paths) — identical elements in different sessions sum together. The replica always renders the default-light theme; captured themes are ignored. Version modes: A common-only → B version split → C ground-truth merge (pick a group in B; exiting keeps the pick).</span>
    </footer>
  `;
}

/* ------------------------------------------------------------- utilities */

function asUISnapshot(parsed: ParsedSnapshotDto): UISnapshot {
  return parsed as unknown as UISnapshot;
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
