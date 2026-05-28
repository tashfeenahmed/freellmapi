# syntax=docker/dockerfile:1

FROM node:20-bookworm AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY shared/package.json ./shared/

RUN npm ci

COPY . .

RUN npm run build
RUN npm prune --omit=dev --workspace server --workspace shared

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/shared ./shared

RUN mkdir -p /app/server/data

EXPOSE 3001

CMD ["node", "server/dist/index.js"]
