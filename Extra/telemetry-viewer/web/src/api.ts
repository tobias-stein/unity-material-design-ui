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

async function request<T>(url: string, init: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; payload?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      // Without an explicit content type the browser falls back to
      // `text/plain`, which reaches the server as a *string* body — the config
      // endpoint's "Body must be a JSON object." guard then rejects the patch
      // even though the payload is valid JSON.
      ...(init.payload === undefined ? {} : { ["content-type"]: "application/json" }),
    },
    method: init.method ?? "GET",
    ...(init.payload === undefined ? {} : { body: JSON.stringify(init.payload) }),
  });
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
  /** Index into `viewSpans` of the span the event is placed on (its filmstrip row); null → no-view row. */
  spanId: number | null;
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
  kind: "view" | "popup" | "inferred";
  layer: string | null;
  /** NLE row (track) the span was packed into; spans of one view share a row. */
  row: number;
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
  rowCount: number;
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
  sourcesConfig: (): Promise<SourcesConfigResponse> => request("/api/sources/config"),
  patchSourcesConfig: (patch: SourcesConfigPatch): Promise<SourcesConfigPatchResponse> =>
    request("/api/sources/config", { method: "PATCH", payload: patch }),
  rescanSources: (): Promise<SourcesRescanResponse> => request("/api/sources/rescan", { method: "POST" }),
  putImportedFiles: (files: Array<{ name: string; content: string }>): Promise<ImportedUniverseResponse> =>
    request("/api/sources/imported", { method: "PUT", payload: { files } }),
  clearImportedFiles: (): Promise<ImportedClearedResponse> =>
    request("/api/sources/imported", { method: "DELETE" }),
};

/* ------------------------------------------------- source config (P6) */

/** URL (+urlencoded query) for the CSV export button's download link. */
export function aggregateCsvUrl(query: AggregateQuery): string {
  return `/api/aggregate/export.csv${aggregateParams(query)}`;
}

export interface EffectiveRootDto {
  env: string | null;
  override?: string | null;
  root: string | null;
}

export interface SourcesConfigResponse {
  pinned: boolean;
  influx: { enabled: boolean; url: string; org: string; bucket: string };
  lpRoot: EffectiveRootDto;
  snapshotRoot: EffectiveRootDto;
  universe: {
    mode: "all" | "imported";
    files: Array<{ name: string; bytes: number }>;
    events: number;
    sessions: string[];
    malformedLines: number;
  };
}

export interface SourcesConfigPatch {
  influxEnabled?: boolean;
  lpRoot?: string | null;
  snapshotRoot?: string | null;
}

export interface SourcesConfigPatchResponse {
  applied: string[];
  config: SourcesConfigResponse;
}

export interface SourcesRescanResponse {
  rescan: "ok";
  sources: SourcesResponse;
}

export interface ImportedUniverseResponse {
  universe: "imported";
  files: Array<{ name: string; bytes: number }>;
  events: number;
  malformedLines: number;
  sessions: string[];
  config: SourcesConfigResponse;
}

export interface ImportedClearedResponse {
  universe: "all";
  cleared: boolean;
  config: SourcesConfigResponse;
}

function aggregateParams(query: AggregateQuery): string {
  const params = new URLSearchParams();
  if (query.sessions !== undefined && query.sessions.length > 0) params.set("sessions", query.sessions.join(","));
  if (query.from !== undefined) params.set("from", query.from);
  if (query.to !== undefined) params.set("to", query.to);
  if (query.mode !== undefined && query.mode !== "a") params.set("mode", query.mode);
  if (query.group !== undefined && query.group !== "") params.set("group", query.group);
  const suffix = params.toString();
  return suffix === "" ? "" : `?${suffix}`;
}

export interface AggregateQuery {
  /** Explicit session ids (XOR range). */
  sessions?: string[];
  /** UTC range bounds (dates as `YYYY-MM-DD`); inclusive. */
  from?: string;
  to?: string;
  /** Version mode (§7): a common-only (default), b version split, c merge. */
  mode?: "a" | "b" | "c";
  /** Mode C pick: `<viewKey>#<versionIndex>` from a mode-b response. */
  group?: string;
}

export interface AggregateTotalsDto {
  sessions: number;
  interactionEvents: number;
  resolvedEvents: number;
  /** Mode A: hidden events (keyed events outside the intersection). */
  hiddenEvents: number;
  unresolvedEvents: number;
  viewKeys: number;
  divergentViewKeys: number;
  /** Distinct hidden keys across all viewKeys (mode-A badge's M; 0 in b/c). */
  hiddenKeys: number;
  /** Mode C: events folded into picked ground truths. */
  foldedEvents: number;
  /** Mode C: events that stayed unmatched after the merge. */
  unmatchedEvents: number;
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

export interface AggregateVersionGroupDto {
  index: number;
  /** `<viewKey>#<index>` — the mode-C `group=` param. */
  groupId: string;
  viewKey: string;
  fingerprint: string;
  snapshotCount: number;
  keys: string[];
  keyCount: number;
  counts: AggregateCountDto[];
  eventCount: number;
  addedKeys: string[];
  removedKeys: string[];
  template: {
    hash: string | null;
    storageKey: string | null;
    viewId: string | null;
    parsed: ParsedSnapshotDto;
  } | null;
}

export interface AggregateMergeRowDto extends AggregateCountDto {
  ownCount: number;
  folded: Array<{
    key: string;
    versionIndex: number;
    count: number;
    matched: number;
    wildcards: number;
  }>;
}

export interface AggregateMergeDto {
  groupId: string;
  viewKey: string;
  groundTruthIndex: number;
  fingerprint: string;
  rows: AggregateMergeRowDto[];
  /** (key, version) pairs that matched nothing — counted, never dropped. */
  unmatched: Array<{
    key: string;
    versionIndex: number;
    count: number;
    leafLabel: string;
    elementType: string | null;
  }>;
  foldedEvents: number;
  unmatchedEvents: number;
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
  /** Modes B/C: per-version groups of a divergent viewKey. */
  versions: AggregateVersionGroupDto[] | null;
  /** Mode C: the ground-truth merge of the picked viewKey. */
  merge: AggregateMergeDto | null;
}

export interface AggregateUnresolvedRowDto {
  view: string;
  elementType: string;
  count: number;
  reasons: Record<string, number>;
}

export interface AggregateResponse {
  selection: {
    mode: "a" | "b" | "c";
    group: string | null;
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
