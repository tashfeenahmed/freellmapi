FROM node:20-bookworm-slim

WORKDIR /app

# Should set PORT/ENCRYPTION_KEY via environment variables.
ENV NODE_ENV=production
ENV PORT=3001

# Copy only manifests first for better layer caching.
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
COPY shared/package*.json ./shared/

# Install workspace dependencies (includes dev deps needed for build).
RUN npm ci

# Copy source and build both server + client.
COPY . .
RUN npm run build

# Remove dev dependencies after build.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# Ensure SQLite directory exists (mount persistent volume).
RUN mkdir -p /app/server/data

EXPOSE 3001

CMD ["npm", "run", "start", "-w", "server"]
