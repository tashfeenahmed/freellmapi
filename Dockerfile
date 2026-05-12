FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
COPY shared/package.json shared/package.json

RUN npm ci

COPY . .
RUN npm run build


FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/app/data/freellmapi.sqlite

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
COPY shared/types.ts shared/types.ts

RUN npm ci --omit=dev --workspace server --include-workspace-root=false

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
