# Stage 1: Build
FROM node:25.9.0-alpine AS builder

# Install build dependencies for native modules (like better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy manifests first for better layer caching
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
COPY shared/package*.json ./shared/

# Install all dependencies (including dev)
RUN npm ci

# Copy source and build both server + client
COPY . .
RUN npm run build

# Remove dev dependencies to keep the production image lean
RUN npm prune --omit=dev --workspaces --include-workspace-root

# Stage 2: Production
FROM node:25.9.0-alpine

# Better-sqlite3 needs libstdc++ at runtime on Alpine
RUN apk add --no-cache libstdc++

WORKDIR /app
ENV NODE_ENV=production

# Copy manifests and the pruned node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy server artifacts
COPY --from=builder /app/server/package*.json ./server/
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/node_modules ./server/node_modules

# Copy client static files (served by the server)
COPY --from=builder /app/client/dist ./client/dist

# Copy shared workspace (server needs it as a dependency)
COPY --from=builder /app/shared ./shared

# Ensure SQLite directory exists and set permissions for the non-root user
RUN mkdir -p /app/server/data && chown -R node:node /app

USER node

EXPOSE 3001

# Use node directly instead of npm for better signal handling
CMD ["node", "server/dist/index.js"]
