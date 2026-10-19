/**
 * Sessions table view — the P1 client surface (search/filter + source pills),
 * now also the entry point into the P2 session timeline (`#/session/:id`).
 */
import { api, ApiClientError, type SessionDto, type SourcesResponse } from "../api.js";

export interface SessionsView {
  /** Detach listeners and clear timers (called on route change). */
  destroy(): void;
}

export function renderSessionsView(app: HTMLElement): SessionsView {
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>UI Telemetry Viewer</h1>
        <span class="phase-chip">P3 · aggregate</span>
        <a class="btn small" href="#/aggregate">Aggregate view →</a>
      </div>
      <div id="source-status" class="source-status" role="status"></div>
    </header>
    <main class="layout">
      <section class="panel toolbar" aria-label="Filters">
        <div class="field">
          <label for="filter-q">Search</label>
          <input id="filter-q" type="search" placeholder="session id, owner, platform, view…" autocomplete="off" />
        </div>
        <div class="field">
          <label for="filter-from">From (UTC)</label>
          <input id="filter-from" type="date" />
        </div>
        <div class="field">
          <label for="filter-to">To (UTC)</label>
          <input id="filter-to" type="date" />
        </div>
        <div class="field">
          <label for="filter-limit">Limit</label>
          <input id="filter-limit" type="number" min="1" max="1000" value="200" />
        </div>
        <button id="apply" class="btn primary">Apply</button>
        <button id="reset" class="btn">Reset</button>
      </section>
      <section id="session-area" class="panel" aria-label="Sessions">
        <div id="session-state"></div>
      </section>
    </main>
    <footer class="hints">
      <span>Sessions come from the ledger (InfluxDB or <code>.lp</code> files) — owner info rides the <code>ui_snapshot_taken</code> points. Click a session for its timeline.</span>
    </footer>
  `;

  const qInput = app.querySelector<HTMLInputElement>("#filter-q")!;
  const fromInput = app.querySelector<HTMLInputElement>("#filter-from")!;
  const toInput = app.querySelector<HTMLInputElement>("#filter-to")!;
  const limitInput = app.querySelector<HTMLInputElement>("#filter-limit")!;
  const statusEl = app.querySelector<HTMLDivElement>("#source-status")!;
  const stateEl = app.querySelector<HTMLDivElement>("#session-state")!;

  let sessionsAbort: AbortController | null = null;
  let debounceTimer: number | undefined;
  let disposed = false;

  function esc(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }

  function statusBadge(state: string, message: string | undefined): { cls: string; label: string } {
    switch (state) {
      case "ok":
        return { cls: "ok", label: message ?? state };
      case "unconfigured":
        return { cls: "info", label: message ?? "not configured" };
      case "degraded":
        return { cls: "warn", label: message ?? state };
      default:
        return { cls: "err", label: message ?? state };
    }
  }

  function describeError(error: unknown): string {
    if (error instanceof ApiClientError) {
      return `${error.body.code}: ${error.body.message}${error.body.detail ? ` — ${error.body.detail}` : ""}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  async function renderSourceStatus(): Promise<void> {
    if (disposed) return;
    let sources: SourcesResponse["sources"];
    let status: string;
    try {
      const lastSources = await api.sources();
      sources = lastSources.sources;
      status = lastSources.status;
    } catch (error) {
      const message = describeError(error);
      statusEl.innerHTML = `<span class="pill err">sources unreachable</span><span class="hint">${esc(message)}</span>`;
      return;
    }
    const parts: Array<string> = [];
    const influx = sources.influx;
    if (influx !== undefined) {
      const badge = statusBadge(String(influx.state), influx.message);
      const facts = influx.facts ?? {};
      const count = facts.sessions !== undefined && facts.sessions !== null ? ` · ${facts.sessions} sessions` : "";
      parts.push(`<span class="pill ${badge.cls}" title="${esc(influx.error?.message ?? badge.label)}">influx ${influx.state}${count}</span>`);
    }
    const lp = sources["lp-files"];
    if (lp !== undefined) {
      const badge = statusBadge(lp.state, lp.state === "ok" ? `${String(lp.facts?.fileCount ?? "")} .lp files` : lp.message);
      parts.push(`<span class="pill ${badge.cls}" title="${esc(lp.state)}">lp files ${badge.label}</span>`);
    }
    const snapshots = sources.snapshots;
    if (snapshots !== undefined && snapshots.state !== "ok") {
      const badge = statusBadge(snapshots.state === "unconfigured" ? "unconfigured" : "degraded", snapshots.message);
      parts.push(
        `<span class="pill ${badge.cls}" title="${esc(snapshots.message ?? snapshots.root ?? "")}">snapshots ${snapshots.state}</span>`,
      );
    }
    statusEl.innerHTML = `<span class="pill ${status === "ok" ? "ok" : status === "degraded" ? "warn" : "err"}">sources ${esc(
      status,
    )}</span>${parts.join("")}`;
  }

  function fmtTime(ms: number | null): string {
    if (ms === null) return "—";
    return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " Z").trim();
  }

  function fmtDuration(ms: number | null): string {
    if (ms === null) return "—";
    const seconds = ms / 1000;
    if (Math.abs(seconds) < 100) return `${seconds.toFixed(2)} s`;
    const minutes = seconds / 60;
    if (Math.abs(minutes) < 60) return `${minutes.toFixed(1)} min`;
    return `${(minutes / 60).toFixed(1)} h`;
  }

  function sessionTable(sessions: SessionDto[]): string {
    const rows: Array<string> = [];
    for (const session of sessions) {
      const views = session.views
        .slice(0, 3)
        .map((view) => `<span class="view-chip" title="${esc(view.view)}">${esc(view.view)}</span>`)
        .join("");
      const moreViews = session.views.length > 3 ? `<span class="view-chip muted">+${session.views.length - 3}</span>` : "";
      const meta: Array<string> = [];
      if (session.owner) meta.push(esc(session.owner));
      if (session.platform) meta.push(esc(session.platform));
      if (session.screen) meta.push(esc(session.screen));
      const snapshotChip =
        session.snapshotCount > 0
          ? `<span class="snap-chip" title="${session.snapshotCount} snapshot captures">▣ ${session.snapshotCount}</span>`
          : '';
      rows.push(
        `<tr data-id="${esc(session.id)}" tabindex="0" title="Open timeline">
          <td class="mono id-cell" title="${esc(session.id)}">${esc(shortId(session.id))}</td>
          <td>${fmtTime(session.startMs)}</td>
          <td>${fmtDuration(session.durationMs)}</td>
          <td class="num">${session.eventCount}</td>
          <td class="num">${session.snapshotCount}${snapshotChip}</td>
          <td>${views}${moreViews || "—"}</td>
          <td class="meta-cell">${meta.join(" · ") || "—"}</td>
          <td><a class="btn small" href="#/session/${encodeURIComponent(session.id)}">Timeline →</a></td>
        </tr>`,
      );
    }
    return `
      <table class="sessions">
        <thead>
          <tr>
            <th>Session</th><th>Start (UTC)</th><th>Duration</th>
            <th class="num">Events</th><th class="num">Snapshots</th><th>Views</th>
            <th>Owner · platform · screen</th><th></th>
          </tr>
        </thead>
        <tbody>${rows.join("\n")}</tbody>
      </table>
      <div class="table-hint">Aggregate heatmaps arrive in P3.</div>`;
  }

  function shortId(id: string): string {
    return id.length > 24 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
  }

  function renderEmptyState(sessionsData: Awaited<ReturnType<typeof api.sessions>>): void {
    if (disposed) return;
    const influxSource = sessionsData.sources.find((s) => s.id === "influx");
    const degradedSources = sessionsData.sources.filter((s) => s.state !== "ok");

    if (!sessionsData.sources.some((s) => s.available)) {
      stateEl.innerHTML = `
        <div class="state-block err">
          <h2>No telemetry source is reachable</h2>
          <p><code>${esc(sessionsData.sources.map((s) => `${s.id}: ${s.state}${s.error ? ` (${s.error.code})` : ""}`).join(" · "))}</code></p>
          <p>Start the dev stack with <code>docker compose -f Extra/Infrastructure/docker-compose.yml up -d</code>, then retry.</p>
          <button class="btn primary" id="retry">Retry</button>
        </div>`;
      bindRetry();
      return;
    }
    if (sessionsData.total === 0) {
      stateEl.innerHTML = `
        <div class="state-block warn">
          <h2>No sessions in any source</h2>
          <p>${
            influxSource !== undefined && influxSource.state !== "ok"
              ? `InfluxDB is ${esc(influxSource.state)} — fix the source or configure an <code>LP_ROOT</code> directory.`
              : "The sources are healthy but hold no telemetry yet. Play a demo session in Unity (telemetry on) and retry."
          }</p>
          <button class="btn primary" id="retry">Retry</button>
        </div>`;
      bindRetry();
      return;
    }
    if (sessionsData.count === 0) {
      stateEl.innerHTML = `
        <div class="state-block info">
          <h2>No sessions match the filters</h2>
          <p>${sessionsData.total} session(s) exist. Clear the search/date filters to see them.</p>
          <button class="btn" id="reset-echo">Reset filters</button>
        </div>`;
      app.querySelector<HTMLButtonElement>("#reset-echo")?.addEventListener("click", () => resetFilters());
      return;
    }
    let table = sessionTable(sessionsData.sessions);
    if (degradedSources.length > 0) {
      table =
        `<div class="state-block inline warn">Partial data: ` +
        esc(
          degradedSources
            .map((s) => `${s.id} ${s.state}${s.error ? ` — ${s.error.message}` : s.message ? ` — ${s.message}` : ""}`)
            .join(" · "),
        ) +
        `</div>` +
        table;
    }
    stateEl.innerHTML = table;
    for (const row of stateEl.querySelectorAll<HTMLTableRowElement>("tr[data-id]")) {
      row.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        if (target.closest("a")) return; // explicit link handles itself
        window.location.hash = `#/session/${encodeURIComponent(row.dataset.id ?? "")}`;
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") window.location.hash = `#/session/${encodeURIComponent(row.dataset.id ?? "")}`;
      });
    }
  }

  async function loadSessions(): Promise<void> {
    if (disposed) return;
    const query: Parameters<typeof api.sessions>[0] = {};
    if (qInput.value.trim() !== "") query.q = qInput.value.trim();
    if (fromInput.value !== "") query.from = `${fromInput.value}T00:00:00Z`;
    if (toInput.value !== "") query.to = `${toInput.value}T23:59:59.999Z`;
    {
      const limit = Number.parseInt(limitInput.value, 10);
      if (Number.isFinite(limit) && limit > 0) query.limit = limit;
    }
    sessionsAbort?.abort();
    sessionsAbort = new AbortController();
    stateEl.innerHTML = `<div class="state-block loading">Loading sessions…</div>`;
    try {
      const data = await api.sessions(query as never);
      renderEmptyState(data);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      stateEl.innerHTML = `
        <div class="state-block err">
          <h2>Sessions request failed</h2>
          <p>${esc(describeError(error))}</p>
          <button class="btn primary" id="retry">Retry</button>
        </div>`;
      bindRetry();
    }
  }

  let retryBound = false;
  function bindRetry(): void {
    const button = app.querySelector<HTMLButtonElement>("#retry");
    if (button !== null && !retryBound) {
      button.addEventListener("click", () => void refresh());
      retryBound = true;
    }
  }

  function resetFilters(): void {
    qInput.value = "";
    fromInput.value = "";
    toInput.value = "";
    limitInput.value = "200";
    void refresh();
  }

  async function refresh(): Promise<void> {
    await Promise.all([renderSourceStatus(), loadSessions()]);
  }

  app.querySelector<HTMLButtonElement>("#apply")?.addEventListener("click", () => void refresh());
  app.querySelector<HTMLButtonElement>("#reset")?.addEventListener("click", () => resetFilters());
  for (const input of [qInput, fromInput, toInput, limitInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void refresh();
    });
  }
  qInput.addEventListener("input", debounce(() => void refresh(), 300));

  function debounce(fn: () => void, wait: number): () => void {
    return () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(fn, wait);
    };
  }

  void refresh();

  return {
    destroy() {
      disposed = true;
      sessionsAbort?.abort();
      window.clearTimeout(debounceTimer);
    },
  };
}
