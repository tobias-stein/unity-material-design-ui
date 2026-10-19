# Multi-stage build of the telemetry-viewer tool (server + static web client).
#
#   docker build -t mdu/telemetry-viewer .
#   docker run --rm -p 8087:8087 -e INFLUX_URL=http://host.docker.internal:8086 \
#       mdu/telemetry-viewer
#
# The final image runs the Fastify server (server/dist) and serves the built
# web client (web/dist) on the same port. Strictly read-only toward InfluxDB
# and snapshot/lp directories.

FROM node:24-alpine AS build
WORKDIR /app

# Enable pnpm through corepack (pinned by packageManager-less spec: 12.x),
# then install the full workspace for building.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN corepack enable && corepack pnpm install --frozen-lockfile

COPY server server
COPY web web
RUN corepack pnpm --filter @mdu/telemetry-viewer-server build \
    && corepack pnpm --filter @mdu/telemetry-viewer-web build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only, pruned from the same lockfile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN corepack enable && corepack pnpm install --frozen-lockfile --prod

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

ENV PORT=8087 HOST=0.0.0.0
EXPOSE 8087

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8087/api/health').then((r)=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
