FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy only manifests first for better layer caching.
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
COPY shared/package*.json ./shared/

# Install all deps needed to compile TypeScript workspaces.
RUN npm ci --include=dev

# Copy source and build both server + client.
COPY . .
RUN npm run build

# Keep only runtime dependencies for production image.
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Copy production node_modules and required app artifacts.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/shared ./shared

# Ensure SQLite directory exists (mount persistent volume).
RUN mkdir -p /app/server/data

EXPOSE 3001

CMD ["npm", "run", "start", "-w", "server"]
