# Krelvan — multi-stage build. Slim Node 22 base.
#
# Stage 1 (core-build):  tsc -> dist/   (core has zero runtime deps + tsx dev dep)
# Stage 2 (web-build):   next build -> web/.next  (+ pruned production node_modules)
# Stage 3 (runner):      minimal image with dist/, web/.next, web production deps,
#                        and the launcher. SQLite lives on a mounted volume.

# ── Stage 1: build the core ──────────────────────────────────────────────────
FROM node:22-slim AS core-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: build the web UI ────────────────────────────────────────────────
FROM node:22-slim AS web-build
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
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Core: compiled output + its package manifest + launcher + capabilities.
COPY package.json ./
COPY bin ./bin
COPY capabilities ./capabilities
COPY --from=core-build /app/dist ./dist

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
RUN mkdir -p /data

# Public web port (a PaaS overrides $PORT); the API port is internal-only.
EXPOSE 3100

CMD ["node", "bin/krelvan.mjs", "up"]
