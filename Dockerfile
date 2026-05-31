# syntax=docker/dockerfile:1.7

# Build stages use the Docker Hardened Image *dev* variant: it ships a shell,
# apt, and a C/C++ toolchain (and runs as root) so node-gyp can compile the
# better-sqlite3 native module. The runtime stage uses the non-dev hardened
# variant: nonroot, no shell, no package manager — only the compiled output.
#
# dhi.io requires a Docker Hardened Images subscription with `node` mirrored to
# your org and a `docker login`. Override both ARGs to fall back to stock images
# (e.g. --build-arg NODE_BUILD_IMAGE=node:24-bookworm --build-arg NODE_RUNTIME_IMAGE=node:24-bookworm-slim)
# if DHI is unavailable. Adjust the tag suffix (e.g. 24-debian13-dev) to match
# your DHI catalog.
ARG NODE_BUILD_IMAGE=dhi.io/node:24-dev
ARG NODE_RUNTIME_IMAGE=dhi.io/node:24

# Numeric uid:gid the hardened runtime image runs as. DHI non-dev images run as
# a nonroot user (commonly 65532). The data dir and copied files are chowned to
# this so the named volume inherits writable ownership. Change if your DHI
# image uses a different nonroot uid.
ARG RUNTIME_UID=65532
ARG RUNTIME_GID=65532

FROM ${NODE_BUILD_IMAGE} AS deps
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

RUN npm ci

FROM deps AS build
WORKDIR /app

COPY . .

RUN npm run build
RUN npm prune --omit=dev

# Pre-create the runtime data dir here (the runtime stage has no shell to
# mkdir/chown) so it can be copied over with nonroot ownership below.
ARG RUNTIME_UID
ARG RUNTIME_GID
RUN mkdir -p /app/server/data \
  && chown -R ${RUNTIME_UID}:${RUNTIME_GID} /app/server/data

FROM ${NODE_RUNTIME_IMAGE} AS runtime
WORKDIR /app

ARG RUNTIME_UID
ARG RUNTIME_GID

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/package.json /app/package-lock.json ./
COPY --from=build --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/node_modules ./node_modules
COPY --from=build --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/shared ./shared
COPY --from=build --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/server/package.json ./server/package.json
COPY --from=build --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/server/dist ./server/dist
COPY --from=build --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/client/dist ./client/dist
COPY --from=build --chown=${RUNTIME_UID}:${RUNTIME_GID} /app/server/data ./server/data

# Hardened runtime already defaults to nonroot; set it explicitly by uid so the
# image is correct regardless of base default.
USER ${RUNTIME_UID}:${RUNTIME_GID}

EXPOSE 3001
VOLUME ["/app/server/data"]

# Exec form (no shell in the hardened runtime image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/ping').then((res) => { if (!res.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "server/dist/index.js"]
