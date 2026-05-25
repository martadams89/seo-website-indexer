# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend ────────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --prefer-offline
COPY backend/ ./
RUN npm run build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Install dumb-init for proper signal handling and su-exec for privilege drop
RUN apk add --no-cache dumb-init su-exec

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy backend dist + node_modules (production only)
COPY --from=backend-builder /app/backend/dist ./dist
COPY backend/package*.json ./
RUN npm ci --only=production --prefer-offline

# Copy compiled frontend into the dist/public directory
# Fastify @fastify/static will serve it from there
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Data directory (will be volume-mounted in production)
RUN mkdir -p /data && chown appuser:appgroup /data
VOLUME ["/data"]

# Copy entrypoint script that fixes /data ownership then drops to appuser
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

EXPOSE 3000

# Run as root so the entrypoint can chown /data, then su-exec drops to appuser
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
