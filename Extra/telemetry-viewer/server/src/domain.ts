/**
 * Normalized domain model of the telemetry viewer.
 *
 * Every source (InfluxDB Flux queries, `.lp` line-protocol files) is first
 * normalized into {@link RawEvent}s — one point, tags + fields, nanosecond
 * timestamps — and then projected into {@link Session}s. Sources must produce
 * byte-comparable domain objects (tested by the parity suite), so this module
 * is deliberately free of any source-specific vocabulary.
 */

/** Measurements written by the Unity runtime (Assets/Runtime/Telemetry). */
export const Measurements = {
  UiEvent: "ui_event",
  Session: "session",
  UiSnapshotTaken: "ui_snapshot_taken",
} as const;

export type MeasurementName =
  | typeof Measurements.UiEvent
  | typeof Measurements.Session
  | typeof Measurements.UiSnapshotTaken;

export interface RawEventTags {
  /** Session id; present on every point the runtime emits. */
  session: string;
  /** Event kind (`click`, `toggle`, `view_open`, …) or lifecycle state for `session`. */
  type?: string;
  view?: string;
  view_id?: string;
  element?: string;
  element_type?: string;
  /** CanvasLayer name of the view (`view_open`/`view_close` only); missing on legacy data. */
  layer?: string;
}

export interface RawEventFields {
  value?: number;
  on?: boolean;
  dwell?: number;
  // ui_snapshot_taken ledger fields
  key?: string;
  hash?: string;
  nodes?: number;
  width?: number;
  height?: number;
  owner?: string;
  platform?: string;
  screen?: string;
  /** Capture trigger ("view-transition", "popup-shown", "mutation", …); missing on legacy data. */
  source?: string;
  /** MDS content mode "anchor" | "delta" (ADR-0009); null for YAML exports and legacy points. */
  mode?: string;
  /** ADR-0007 theme manifest hash ("x8" hex); null when the theme rides inline or legacy. */
  theme?: string;
  /** ADR-0009 chain links: immediate base and chain root anchor (file hashes); null on anchors. */
  base?: string;
  anchor?: string;
}

export interface RawEvent {
  measurement: MeasurementName;
  /** Nanoseconds since the Unix epoch (line-protocol precision). */
  timestampNs: bigint;
  tags: RawEventTags;
  fields: RawEventFields;
}

export interface RawEventResult {
  events: RawEvent[];
  /** Lines/rows that could not be parsed; reported, never silently dropped … */
  malformedCount: number;
  /** … but if a whole request failed, `error` carries the structured reason. */
  error?: SourceError;
}

export interface SourceError {
  code: string;
  message: string;
  /** HTTP status for REST surface (400/502/503). */
  httpStatus: 400 | 404 | 502 | 503;
  /** Optional source-specific detail (URL, file path, upstream message). */
  detail?: string;
}

export type SourceId = "influx" | "lp-files" | "imported-files";

export interface SourceStatus {
  id: SourceId;
  available: boolean;
  state: "ok" | "degraded" | "unavailable" | "unconfigured";
  message?: string;
  /** Cheap measurable facts about the source (counts, root, endpoint …). */
  facts: Record<string, string | number | null>;
}

export interface FetchOptions {
  /** Restrict to specific sessions (e.g. to avoid double-counting merged sources). */
  sessionIds?: string[];
  fromNs?: bigint;
  toNs?: bigint;
}

export interface SourceProvider {
  readonly id: SourceId;
  /** Self-description used by `GET /api/sources`. */
  describe(): Promise<SourceStatus>;
  /** Fetch every relevant point. Returns partial results with structured errors. */
  fetchEvents(options?: FetchOptions): Promise<RawEventResult>;
}

/** One open/close cycle of a view inside a session. */
export interface SessionViewSpan {
  view: string;
  viewId: string | null;
  openNs: bigint;
  closeNs: bigint | null;
  dwellSeconds: number | null;
  /** CanvasLayer name of the view (runtime tag); null when the data predates it. */
  layer: string | null;
}

/** Snapshot lanes of the single-session timeline (P2, plan §9.1). */
export const TimelineLanes = {
  click: "click",
  toggle: "toggle",
  close: "close",
  backdrop: "backdrop_click",
  views: "view_open_close",
} as const;



/** A snapshot artifact recorded in the `ui_snapshot_taken` ledger. */
export interface SnapshotLedgerEntry {
  timestampNs: bigint;
  view: string | null;
  viewId: string | null;
  /** Storage key (`snapshots/<yyyy>/<mm>/<dd>/<file>.yaml[.gz]`). Lookup hint only. */
  key: string | null;
  /** SHA-256 of the written bytes — the join key. */
  hash: string | null;
  nodes: number | null;
  width: number | null;
  height: number | null;
  /** MDS content mode ("anchor" | "delta", ADR-0009); null for YAML/legacy. */
  mode: string | null;
  /** ADR-0007 theme manifest hash; null when inline or legacy. */
  themeHash: string | null;
  /** ADR-0009 chain links (null on anchors). */
  baseHash: string | null;
  anchorHash: string | null;
}

/** Projected session (light for lists, with `events`/`snapshots` for detail). */
export interface Session {
  id: string;
  /** Which provider's data actually built this session. */
  origin: SourceId | "unknown";
  startNs: bigint | null;
  endNs: bigint | null;
  firstEventNs: bigint | null;
  lastEventNs: bigint | null;
  /** end (or last event) minus start (or first event); null when degenerate. */
  durationNs: bigint | null;
  eventCount: number;
  snapshotCount: number;
  /** Owner info from the ledger — never derived from snapshot YAML. */
  owner: string | null;
  platform: string | null;
  screen: string | null;
  views: SessionViewSpan[];
  snapshots: SnapshotLedgerEntry[];
  eventCountsByType: Record<string, number>;
  /** View-open events still open at the end of the data. */
  openViewCount: number;
}

/**
 * Single-session timeline read model (server/core/timeline.ts → REST
 * `GET /api/sessions/:id/timeline`).
 */
export type TimelineLane =
  | "views"
  | "click"
  | "toggle"
  | "close"
  | "backdrop_click"
  | "unresolved";

/** How a timeline span was derived — drives the client's row rendering. */
export type TimelineSpanKind =
  | "view" // main view (BACKGROUND/DEFAULT/MENU layer), runtime view_open/view_close pair
  | "popup" // popup-layer view (Dialog, Snackbar, …), runtime pair with layer tag
  | "inferred"; // legacy data: popup span synthesized from attributed interaction events

export interface TimelineEvent {
  /** Stable ordinal into the ordered events array. */
  index: number;
  /** Exact epoch-ns timestamp as a decimal string (JSON-safe; the id). */
  ns: string;
  /** Epoch ms float for the canvas (ms resolution per plan §9.1). */
  ms: number;
  /** Raw `type` tag (`click`, `toggle`, `view_open`, …). */
  type: string;
  /** Lane assignment (§9.1 lanes + §6.1 unresolved rule). */
  lane: TimelineLane;
  view: string | null;
  viewId: string | null;
  /** Index into `viewSpans` of the span this event is placed on (its filmstrip row); null when no span holds it (client's orphan row). */
  spanId: number | null;
  element: string | null;
  elementType: string | null;
  /** Toggle state field (`on`); null for non-toggles. */
  on: boolean | null;
  /** Recorded dwell seconds (view_close close events); null otherwise. */
  dwellSeconds: number | null;
  value: number | null;
  /**
   * Snapshot anchor index (into `snapshots`) of the latest anchor of the same
   * `view_id` at or before the event ("latest ≤ t", §6.1); null unresolved.
   */
  snapshotIndex: number | null;
  unresolved: boolean;
}

export interface TimelineViewSpan {
  index: number;
  view: string;
  viewId: string | null;
  openNs: string;
  openMs: number;
  closeNs: string | null;
  closeMs: number | null;
  dwellSeconds: number | null;
  stillOpen: boolean;
  /** How the span was derived (kind tag from the runtime, or legacy inference). */
  kind: TimelineSpanKind;
  /** CanvasLayer name; null on legacy data. */
  layer: string | null;
  /** Row (track) of the NLE layout: spans of the same viewId share a row, rows are reused as spans end. */
  row: number;
}

export interface TimelineSnapshotAnchor {
  index: number;
  ns: string;
  ms: number;
  view: string | null;
  viewId: string | null;
  key: string | null;
  hash: string | null;
  nodes: number | null;
  width: number | null;
  height: number | null;
}

export interface TimelineFrame {
  sessionId: string;
  startNs: string;
  endNs: string;
  startMs: number;
  endMs: number;
  /** ui_event count — equals `Session.eventCount` exactly (tested invariant). */
  eventCount: number;
  unresolvedCount: number;
  events: TimelineEvent[];
  lanes: Array<{ lane: TimelineLane; label: string; count: number }>;
  viewSpans: TimelineViewSpan[];
  /** Number of NLE rows (tracks) the spans were packed into (client viewport = max(3, rows)). */
  rowCount: number;
  snapshots: TimelineSnapshotAnchor[];
}
