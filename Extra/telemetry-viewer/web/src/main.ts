/**
 * UI Telemetry Viewer — hash-routed web client (plan §9.1):
 *
 * - `#/` (or `#/sessions`) → the P1 sessions table with search/filters;
 * - `#/session/<id>` → the P2 single-session timeline + replica panel.
 *
 * The router owns only view mounting; each view builds its own shell inside
 * `#app` and must leave no listeners behind — `destroy()` is called on every
 * switch, including when a slow view's load races a newer route.
 */
import "./styles.css";
import { renderSessionsView, type SessionsView } from "./views/sessions.js";
import { renderTimelineView, type TimelineViewHandle } from "./views/timeline.js";

const app = document.querySelector<HTMLDivElement>("#app")!;

type ViewHandle = SessionsView | TimelineViewHandle;

let mounted: ViewHandle | null = null;
/** Bumped on every route change; a slow async mount that loses this must die. */
let mountToken = 0;

async function mount(): Promise<void> {
  const token = ++mountToken;
  const hash = window.location.hash || "#/";

  mounted?.destroy();
  mounted = null;
  app.innerHTML = "";

  const sessionRoute = /^#\/session\/([^/?#]+)$/.exec(hash);
  if (sessionRoute !== null) {
    const sessionId = decodeURIComponent(sessionRoute[1] ?? "");
    // Race guard: if another route took over while the timeline was loading,
    // tear the stale view down immediately instead of mounting it.
    const view = await renderTimelineView(app, sessionId);
    if (token !== mountToken) {
      view.destroy();
      return;
    }
    mounted = view;
    return;
  }

  if (hash !== "#/" && hash !== "#/sessions") {
    window.location.hash = "#/"; // re-enters mount via hashchange
    return;
  }
  const view = renderSessionsView(app);
  if (token !== mountToken) {
    view.destroy();
    return;
  }
  mounted = view;
}

window.addEventListener("hashchange", () => void mount());
void mount();
