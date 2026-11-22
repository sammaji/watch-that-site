# syntax=docker/dockerfile:1.7
#
# Production images for WatchThatSite, one target each. Build from the repo
# root, for the VM's architecture:
#
#   docker build -f infra/Dockerfile --target web     -t wts-web .
#   docker build -f infra/Dockerfile --target worker  -t wts-worker .
#   docker build -f infra/Dockerfile --target objects -t wts-objects .
#   docker build -f infra/Dockerfile --target go      -t wts-go .
#
# The web app bakes its NEXT_PUBLIC_* settings in at build time (build args);
# everything else is read from the environment when a container starts.

# ---------------------------------------------------------------- Node base
FROM node:24-bookworm-slim AS node-base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo

# ---------------------------------------------------------------- web
FROM node-base AS web-build
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_DOC_URL
ARG NEXT_PUBLIC_POSTGREST_URL
ARG NEXT_PUBLIC_PROXY_URL
ARG NEXT_PUBLIC_SAMPLE_PAGES_URL
ENV NEXT_PUBLIC_SAMPLE_PAGES_URL=$NEXT_PUBLIC_SAMPLE_PAGES_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_DOC_URL=$NEXT_PUBLIC_DOC_URL \
    NEXT_PUBLIC_POSTGREST_URL=$NEXT_PUBLIC_POSTGREST_URL \
    NEXT_PUBLIC_PROXY_URL=$NEXT_PUBLIC_PROXY_URL
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@watchthatsite/web..."

RUN POSTGRES_HOST=build POSTGRES_PORT=5432 POSTGRES_USER=build \
    POSTGRES_PASSWORD=build POSTGRES_DATABASE=build \
    BETTER_AUTH_SECRET=build-only-placeholder-secret-0123456789 \
    pnpm --filter @watchthatsite/web build

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=web-build /repo/apps/web/.next/standalone ./
COPY --from=web-build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------- browser worker
# Playwright's image carries the Chromium build that playwright-core 1.63 drives.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS worker
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "browser-worker..."
# The worker imports the object-store client from packages/cloudflare's dist/.
RUN pnpm --filter @watchthatsite/cloudflare build
WORKDIR /repo/services/browser-worker
EXPOSE 5220
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

# ---------------------------------------------------------------- object store
# The object-store Worker (packages/cloudflare) run locally by workerd, its
# bucket kept on a volume at /data. Same code and API as on Cloudflare.
FROM node-base AS objects
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@watchthatsite/cloudflare..."
WORKDIR /repo/packages/cloudflare
ENV WRANGLER_SEND_METRICS=false
EXPOSE 8787
CMD ["sh", "-c", "exec ./node_modules/.bin/wrangler dev --local --ip 0.0.0.0 --port 8787 --persist-to /data --show-interactive-dev-session=false --var R2_API_TOKEN:\"$R2_API_TOKEN\" --var R2_SIGNING_SECRET:\"$R2_SIGNING_SECRET\""]

# ---------------------------------------------------------------- Go services
FROM golang:1.26-bookworm AS go-build
WORKDIR /src
COPY services ./services
COPY packages/image-diff ./packages/image-diff
COPY packages/cloudflare_go ./packages/cloudflare_go
COPY scripts/migrator ./scripts/migrator
ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    mkdir -p /out \
 && (cd services/scheduler && go build -ldflags="-s -w" -o /out/scheduler .) \
 && (cd services/notifications && go build -ldflags="-s -w" -o /out/notifications ./cmd) \
 && (cd services/proxy && go build -ldflags="-s -w" -o /out/proxy .) \
 && (cd scripts/migrator && go build -ldflags="-s -w" -o /out/migrator .)

FROM debian:bookworm-slim AS go
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
COPY --from=go-build /out/ /usr/local/bin/
COPY packages/db/migrations /migrations
USER nobody
