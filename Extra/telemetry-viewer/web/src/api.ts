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
  session: (id: string): Promise<unknown> => request(`/api/sessions/${encodeURIComponent(id)}`),
};

export interface SessionsQuery {
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}
