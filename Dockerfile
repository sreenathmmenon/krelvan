# Krelvan — multi-stage build. Slim Node 22 base.
#
# Stage 1 (core-build):  tsc -> dist/   (core has zero runtime deps + tsx dev dep)
# Stage 2 (web-build):   next build -> web/.next  (+ pruned production node_modules)
# Stage 3 (runner):      minimal image with dist/, web/.next, web production deps,
#                        and the launcher. SQLite lives on a mounted volume.

# ── Stage 1: build the core ──────────────────────────────────────────────────
FROM node:22.23.1-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS core-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.release.json ./
COPY scripts/build-release.mjs ./scripts/build-release.mjs
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# ── Stage 2: build the web UI ────────────────────────────────────────────────
FROM node:22.23.1-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# IMPORTANT: do NOT bake NEXT_PUBLIC_API_URL. The browser must call the API through the
# same-origin /proxy route (web/app/proxy/[...path]/route.ts), which injects the auth
# session server-side. Pointing the browser straight at the API origin would send no
# session header and every authenticated request would 401 — a logged-in-but-broken app.
# api.ts already defaults the base URL to "/proxy" when this var is unset, which is correct.
RUN npm run build
# Prune to production deps so the runner image stays small.
RUN npm prune --omit=dev

# ── Stage 3: minimal runner ──────────────────────────────────────────────────
FROM node:22.23.1-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG KRELVAN_VERSION=0.1.2
LABEL org.opencontainers.image.title="Krelvan" \
      org.opencontainers.image.version="${KRELVAN_VERSION}" \
      org.opencontainers.image.source="https://github.com/sreenathmmenon/krelvan" \
      org.opencontainers.image.licenses="Apache-2.0"

# The image remains non-root by default. Platforms that mount persistent volumes as root
# may start the entrypoint as root so it can repair only the configured data directory;
# gosu immediately drops to the node user before Krelvan starts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && gosu nobody true
COPY scripts/docker-entrypoint.sh /usr/local/bin/krelvan-entrypoint
RUN chmod 0755 /usr/local/bin/krelvan-entrypoint

# Core: compiled output + its package manifest + launcher + capabilities.
COPY package.json ./
COPY bin ./bin
COPY capabilities ./capabilities
COPY --from=core-build /app/dist ./dist
COPY --from=core-build /app/node_modules ./node_modules

# Web: built app + production node_modules + sources next start needs.
COPY --from=web-build /app/web/.next ./web/.next
COPY --from=web-build /app/web/node_modules ./web/node_modules
COPY --from=web-build /app/web/package.json ./web/package.json
COPY --from=web-build /app/web/next.config.mjs ./web/next.config.mjs
COPY --from=web-build /app/web/public ./web/public

# Persisted data lives here (mount a volume).
ENV KRELVAN_DATA_DIR=/data
# Port model: the PUBLIC web UI binds to $PORT (a single-port PaaS injects this; we
# default it to 3100 for plain `docker run`). The API runs on an internal fixed port
# that only the web's same-origin proxy reaches over localhost.
ENV PORT=3100
ENV KRELVAN_API_PORT=3201
# Builds are already done in the image; the launcher just starts both processes.
ENV KRELVAN_SKIP_BUILD=1
RUN mkdir -p /data && chown node:node /data

# Public web port (a PaaS overrides $PORT); the API port is internal-only.
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER node
ENTRYPOINT ["/usr/local/bin/krelvan-entrypoint"]
CMD ["node", "bin/krelvan.mjs", "up"]
