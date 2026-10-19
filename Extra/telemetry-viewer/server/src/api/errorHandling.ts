/** Uniform REST error envelope: `{ code, message, detail? }` — never HTML. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface NotFoundOptions {
  /** index.html content for the SPA fallback (GET, non-API). */
  spaIndexFile?: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 404 | 409 | 500 | 502 | 503 = 400,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export function errorBody(
  code: string,
  message: string,
  detail?: string,
): { code: string; message: string; detail?: string } {
  return detail === undefined ? { code, message } : { code, message, detail };
}

export function registerErrorHandlers(app: FastifyInstance, notFound: NotFoundOptions = {}): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    type ErrorShape = { message: string; code?: string; httpStatus?: number; detail?: string; validation?: unknown };
    const err = (error ?? {}) as ErrorShape;
    if (err.validation !== undefined) {
      reply.status(400).send(errorBody("INVALID_QUERY", "Invalid query parameters."));
      return;
    }
    const status: 400 | 404 | 409 | 500 | 502 | 503 =
      typeof err.httpStatus === "number" && [400, 404, 409, 502, 503].includes(err.httpStatus)
        ? (err.httpStatus as 400 | 404 | 409 | 502 | 503)
        : 500;
    request.log.error({ err: error, code: err.code }, "request failed");
    reply.status(status).send(errorBody(err.code ?? "INTERNAL_ERROR", err.message || "Unexpected server error.", err.detail));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "GET" && notFound.spaIndexFile && !request.url.startsWith("/api/")) {
      reply.type("text/html").send(notFound.spaIndexFile);
      return;
    }
    reply.status(404).send(errorBody("NOT_FOUND", `No route: ${request.method} ${request.url}`));
  });
}
