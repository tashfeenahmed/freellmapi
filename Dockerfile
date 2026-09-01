# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# better-sqlite3 is a native module; on slim images without a usable prebuilt
# binary (notably the linux/arm64 leg under QEMU) it compiles from source via
# node-gyp, which needs Python + a C++ toolchain. These live only in the build
# stages — the runtime image copies the already-compiled node_modules.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY cli/package.json ./cli/

RUN npm ci

FROM deps AS build
WORKDIR /app

COPY . .

RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV FREELLMAPI_INSTALL_METHOD=docker

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# npm nests some production packages under the workspace instead of hoisting
# them (undici lives at server/node_modules/undici). Skipping this copy shipped
# images where the HTTP(S) proxy dispatcher failed to load and every request
# silently went direct — issue #550.
COPY --from=build --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
# The dashboard shows which RELEASE this is, and the release version lives in
# desktop/package.json (server/package.json tracks the workspace, not the app).
# One 400-byte manifest so a container install can name its own version (#703).
COPY --from=build --chown=node:node /app/desktop/package.json ./desktop/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/client/dist ./client/dist

RUN mkdir -p /app/server/data && chown -R node:node /app/server/data

# PaaS runtimes (Railway, Render) mount the persistent volume root-owned while
# the app runs as USER node, so better-sqlite3 cannot create the DB there.
# The entrypoint chowns the data dir as root, then drops back to node.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Deliberately last of the runtime layers: the SHA changes on every commit, and
# an ARG/ENV above the COPYs invalidates the cache for all of them on each build.
ARG FREELLMAPI_COMMIT_SHA
ENV FREELLMAPI_COMMIT_SHA=${FREELLMAPI_COMMIT_SHA}

# Runs as root so docker-entrypoint.sh can chown a root-owned volume mount on
# PaaS runtimes; the entrypoint drops back to the node user before exec'ing CMD.
USER root

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 3001

# No VOLUME for /app/server/data on purpose. Persistence is the deployment's
# job — docker-compose.yml maps the named `freellmapi-data` volume there, and a
# plain `docker run` takes -v. Declaring it here instead creates an ANONYMOUS
# volume on every container that doesn't override it: PaaS runtimes that build
# from the Dockerfile (Railway, Render, Coolify, Dokploy, CapRover) then either
# refuse the image or silently hand each redeploy a fresh empty volume, and the
# declaration also shadows a bind mount made at the same path.

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/ping').then((res) => { if (!res.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "server/dist/index.js"]
