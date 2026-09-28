# syntax=docker/dockerfile:1.7
# Family Cloud: one image for the API/web server, the background worker and the admin CLI.

ARG NODE_VERSION=24

# ── build ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN npm install -g pnpm@12.6.0
WORKDIR /src

# Install dependencies first (cached unless manifests change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# No dependency needs its install script to build the image. pnpm fails the install on any build
# script missing from allowBuilds, e.g. @embedded-postgres/linux-arm64 (a dev-only dependency)
# when building the arm64 image.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm --filter @familycloud/web build \
 && pnpm --filter @familycloud/server build \
 && pnpm --filter @familycloud/server deploy --prod --legacy /out

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# ffmpeg: video poster frames · libheif-examples: iPhone HEIC photos · poppler-utils: PDF pages
# tini: correct signal handling and zombie reaping for PID 1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libheif-examples poppler-utils tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --max-semi-space-size caps V8's young generation (it otherwise sizes it to the host's RAM,
# ~128 MB on big machines); measured idle RSS 223 → 142 MB with no throughput change.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-semi-space-size=16 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/dist/migrations

WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web

# Unprivileged by default; compose can map to the host user owning the storage (PUID/PGID).
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
