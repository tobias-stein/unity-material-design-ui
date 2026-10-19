/** Typed client for the P1 REST surface (server/src/api). The server is the
 * single place that understands sources; the client only consumes JSON. */

export interface SourceSourceStatus {
  id?: string;
  available?: boolean;
  state: string;
  message?: string;
  facts?: Record<string, string | number | null>;
  error?: { code: string; message: string };
  root?: string | null;
  fileCount?: number | null;
}

export interface SourcesResponse {
  status: "ok" | "degraded" | "unavailable";
  sources: {
    snapshots?: { state: string; root: string | null; fileCount: number | null; message?: string };
    ["lp-files"]?: SourceSourceStatus;
    influx?: SourceSourceStatus;
  };
}

export interface SessionViewDto {
  view: string;
  viewId: string | null;
  openMs: number | null;
  closeMs: number | null;
  dwellSeconds: number | null;
}

export interface SessionDto {
  id: string;
  origin: string;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  eventCount: number;
  snapshotCount: number;
  owner: string | null;
  platform: string | null;
  screen: string | null;
  views: SessionViewDto[];
  eventCountsByType: Record<string, number>;
  openViewCount: number;
}

export interface SessionsResponse {
  total: number;
  count: number;
  status: string;
  sources: Array<{ id: string; state: string; available: boolean; message?: string; error?: { code: string; message: string }; facts?: Record<string, string | number | null> }>;
  sessions: SessionDto[];
}

export interface ApiErrorBody {
  code: string;
  message: string;
  detail?: string;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = "ApiClientError";
  }
}

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    throw new ApiClientError(response.status, {
      code: "NON_JSON_RESPONSE",
      message: `Server returned non-JSON (HTTP ${response.status}).`,
      detail: text.slice(0, 300),
    });
  }
  if (!response.ok) {
    const body = (parsed ?? {}) as ApiErrorBody;
    throw new ApiClientError(
      response.status,
      body.code ? body : { code: "HTTP_ERROR", message: `HTTP ${response.status}.` },
    );
  }
  return parsed as T;
}

/* ------------------------------------------------------- timeline (P2) */

export interface TimelineEventDto {
  index: number;
  ns: string;
  ms: number;
  type: string;
  lane: string;
  view: string | null;
  viewId: string | null;
  element: string | null;
  elementType: string | null;
  on: boolean | null;
  dwellSeconds: number | null;
  value: number | null;
  snapshotIndex: number | null;
  unresolved: boolean;
}

export interface TimelineSnapshotDto {
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

export interface TimelineViewSpanDto {
  index: number;
  view: string;
  viewId: string | null;
  openMs: number;
  closeMs: number | null;
  dwellSeconds: number | null;
  stillOpen: boolean;
}

export interface TimelineLaneDto {
  lane: string;
  label: string;
  count: number;
}

export interface TimelineResponse {
  session: SessionDto;
  status: "ok" | "degraded" | "unavailable";
  startNs: string;
  endNs: string;
  startMs: number;
  endMs: number;
  eventCount: number;
  unresolvedCount: number;
  lanes: TimelineLaneDto[];
  events: TimelineEventDto[];
  viewSpans: TimelineViewSpanDto[];
  snapshots: TimelineSnapshotDto[];
}

/* parsed snapshot document (server-side YAML parse, plan §5) */

export interface SnapshotNodeDto {
  id: string;
  kind?: string;
  name?: string;
  type?: string;
  parentId?: string | null;
  siblingIndex?: number;
  active?: boolean;
  isView?: boolean;
  layer?: string | null;
  rect?: { x?: number; y?: number; width?: number; height?: number } | null;
  layout?: Record<string, unknown> | null;
  layoutElement?: Record<string, unknown> | null;
  contentSizeFitter?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  resolved?: Record<string, unknown> | null;
}

export interface ParsedSnapshotDto {
  schemaVersion: number;
  timestampUtc: string | null;
  app: Record<string, unknown> | null;
  view: Record<string, unknown> | null;
  theme: {
    isDark?: boolean;
    palette?: Record<string, string>;
    typography?: Record<string, never> | null;
  } | null;
  nodes: SnapshotNodeDto[];
  childrenOf: Record<string, string[]>;
  rootId: string;
  warnings: string[];
}

export interface SnapshotResponse {
  sessionId: string;
  index: number;
  snapshotId: string;
  hash: string | null;
  key: string | null;
  parsed: ParsedSnapshotDto;
}

export const api = {
  sources: (): Promise<SourcesResponse> => request("/api/sources"),
  sessions: (query: SessionsQuery): Promise<SessionsResponse> => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.toString();
    return request(`/api/sessions${suffix === "" ? "" : `?${suffix}`}`);
  },
  session: (id: string): Promise<SessionDto> => request(`/api/sessions/${encodeURIComponent(id)}`),
  timeline: (id: string): Promise<TimelineResponse> =>
    request(`/api/sessions/${encodeURIComponent(id)}/timeline`),
  snapshot: (id: string, ref: string): Promise<SnapshotResponse> =>
    request(`/api/snapshots/${encodeURIComponent(id)}/${encodeURIComponent(ref)}`),
  aggregate: (query: AggregateQuery): Promise<AggregateResponse> =>
    request(`/api/aggregate${aggregateParams(query)}`),
};

/** URL (+urlencoded query) for the CSV export button's download link. */
export function aggregateCsvUrl(query: AggregateQuery): string {
  return `/api/aggregate/export.csv${aggregateParams(query)}`;
}

function aggregateParams(query: AggregateQuery): string {
  const params = new URLSearchParams();
  if (query.sessions !== undefined && query.sessions.length > 0) params.set("sessions", query.sessions.join(","));
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  const suffix = params.toString();
  return suffix === "" ? "" : `?${suffix}`;
}

export interface AggregateQuery {
  /** Explicit session ids (XOR range). */
  sessions?: string[];
  /** UTC range bounds (dates as `YYYY-MM-DD`); inclusive. */
  from?: string;
  to?: string;
}

export interface AggregateTotalsDto {
  sessions: number;
  interactionEvents: number;
  resolvedEvents: number;
  hiddenEvents: number;
  unresolvedEvents: number;
  viewKeys: number;
  divergentViewKeys: number;
  hiddenKeys: number;
}

export interface AggregateCountDto {
  key: string;
  count: number;
  elementType: string | null;
  leafLabel: string;
  confidence: "exact" | "approximate";
  templateNodeId: string | null;
  dimensions: { width: number | null; height: number | null } | null;
}

export interface AggregateViewDto {
  viewKey: string;
  divergent: boolean;
  versionCount: number;
  intersectionKeyCount: number;
  hiddenKeyCount: number;
  hiddenEventCount: number;
  counts: AggregateCountDto[];
  template: {
    hash: string | null;
    storageKey: string | null;
    viewId: string | null;
    parsed: ParsedSnapshotDto;
  } | null;
}

export interface AggregateUnresolvedRowDto {
  view: string;
  elementType: string;
  count: number;
  reasons: Record<string, number>;
}

export interface AggregateResponse {
  selection: {
    mode: "a";
    sessions: SessionDto[];
    fromMs: number | null;
    toMs: number | null;
    status: string;
  };
  totals: AggregateTotalsDto;
  views: AggregateViewDto[];
  unresolved: AggregateUnresolvedRowDto[];
  warnings: string[];
}

export interface SessionsQuery {
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}
