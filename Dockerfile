# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24.19.0-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend ────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24.19.0-alpine AS backend-builder

# python3/make/g++: better-sqlite3 doesn't ship a prebuilt musl/Alpine binary,
# so node-gyp has to compile it from source here.
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --prefer-offline
COPY backend/ ./
RUN npm run build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:24.19.0-alpine AS runtime

ARG APP_VERSION=dev

# Install dumb-init for proper signal handling, su-exec for privilege drop,
# and wget for the HEALTHCHECK probe.
RUN apk add --no-cache dumb-init su-exec wget

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy backend dist + node_modules (production only)
COPY --from=backend-builder /app/backend/dist ./dist
COPY backend/package*.json ./
# better-sqlite3 has no prebuilt musl/Alpine binary, so node-gyp needs a C++
# toolchain here too — install it just for this layer, then remove it so the
# final image doesn't carry compiler tooling.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --only=production --prefer-offline \
    && apk del .build-deps

# Copy compiled frontend into the dist/public directory
# Fastify @fastify/static will serve it from there
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Data directory (will be volume-mounted in production)
RUN mkdir -p /data && chown appuser:appgroup /data
VOLUME ["/data"]

# Copy entrypoint script that fixes /data ownership then drops to appuser
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

EXPOSE 3000

# Container-level liveness probe — Docker / Kubernetes use this to restart the
# container if the app deadlocks. Fast endpoint that only confirms the process
# is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/livez >/dev/null || exit 1

# Run as root so the entrypoint can chown /data, then su-exec drops to appuser
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]

# ── Multi-arch build ──────────────────────────────────────────────────────────
# To build & push a multi-arch image:
#   docker buildx create --use --name seo-indexer || docker buildx use seo-indexer
#   docker buildx build \
#     --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/<your-org>/seo-website-indexer:latest \
#     --push .
