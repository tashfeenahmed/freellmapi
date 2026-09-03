# Docker

The production image, the Compose quickstart, and everything about running FreeLLMAPI in a container: persistence, ports, health, and the networking gotchas.

- [The image](#the-image)
- [Compose quickstart](#compose-quickstart)
- [Ports & LAN access](#ports--lan-access)
- [Volumes & persistence](#volumes--persistence)
- [Healthcheck](#healthcheck)
- [Non-root runtime](#non-root-runtime)
- [Why better-sqlite3 is compiled from source](#why-better-sqlite3-is-compiled-from-source)
- [Troubleshooting: container cannot reach providers (#733)](#troubleshooting-container-cannot-reach-providers-733)

## The image

FreeLLMAPI publishes a single production image containing the Express server and the built React dashboard:

```bash
docker pull ghcr.io/tashfeenahmed/freellmapi:latest   # or pin a release, e.g. :v1.2.3
```

Published tags: `latest` (default branch), `v*.*.*` (git release tags), and `sha-<commit>`. The image is multi-arch (`linux/amd64` + `linux/arm64`, so it runs on a Raspberry Pi).

Build shape ([Dockerfile](../../Dockerfile)):

- Three stages on the `node:20-bookworm-slim` base (`deps` → `build` → `runtime`); only already-built artifacts are copied into the runtime stage.
- The runtime sets `NODE_ENV=production`, `PORT=3001`, and `FREELLMAPI_INSTALL_METHOD=docker`; the process is `node server/dist/index.js`.
- A `FREELLMAPI_COMMIT_SHA` ARG/ENV pair sits deliberately after all `COPY` layers: the SHA changes every commit, and placing it higher would invalidate the layer cache for the whole image on each build.
- The runtime also copies `desktop/package.json` (a 400-byte manifest) so a container install can name its own release version (#703).
- `.dockerignore` keeps secrets and local state out of the build context: `.env`, `.env.*`, `*.db` (+ `-wal`/`-shm` sidecars), `.encryption-key`, and `server/data` never enter an image.

## Compose quickstart

Prerequisites: Docker, Docker Compose, OpenSSL. macOS/Linux:

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

# Generate an encryption key for at-rest key storage
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d
```

Windows PowerShell variant and a curl one-liner bootstrap live in [`docs/install.md`](../install.md#docker-compose). Then follow the logs:

```bash
docker compose logs -f freellmapi
```

Open http://localhost:3001, add provider keys on the **Keys** page, and grab your unified API key from that page's header — that key is what your OpenAI SDK points at.

## Ports & LAN access

The compose file publishes `"${HOST_BIND:-127.0.0.1}:${PORT:-3001}:3001"`. By default the dashboard/API is reachable only from the machine running Docker; to reach it from other devices (e.g. a Raspberry Pi at `http://192.168.1.x:3001`):

```bash
HOST_BIND=0.0.0.0 docker compose up -d
```

Only do this on a trusted network — the proxy is single-user and guarded only by the unified API key.

## Volumes & persistence

SQLite data lives in the named volume `freellmapi-data`, mounted at `/app/server/data`. Keep the same `.env` `ENCRYPTION_KEY` and the same volume when upgrading, because provider keys are encrypted at rest. If your host only persists one specific directory, point the database there with `FREEAPI_DB_PATH=/that/path/freellmapi.db`.

The Dockerfile declares **no** `VOLUME` for `/app/server/data` on purpose. Persistence is the deployment's job — the compose file maps the named volume there, and plain `docker run` takes `-v`. Declaring it in the image instead would create an ANONYMOUS volume on every container that doesn't override it: PaaS runtimes that build from the Dockerfile (Railway, Render, Coolify, Dokploy, CapRover) would then either refuse the image or silently hand each redeploy a fresh empty volume, and the declaration would also shadow a bind mount made at the same path.

See [02-updates-and-backup.md](02-updates-and-backup.md) for backups of this volume.

## Healthcheck

Both the Dockerfile and the compose file define the same probe: a Node one-liner fetching `http://127.0.0.1:<port>/api/ping` inside the container, exiting non-zero unless the response is OK.

| Setting | Value |
| --- | --- |
| Interval | 30s |
| Timeout | 5s |
| Start period | 15s |
| Retries | 3 |

## Non-root runtime

The runtime stage switches to `USER node` before `EXPOSE 3001`. The server data directory `/app/server/data` is created and chowned to `node:node` during the build so the running user owns it; all copied artifacts carry `--chown=node:node`.

## Why better-sqlite3 is compiled from source

`better-sqlite3` is a native module. On slim images without a usable prebuilt binary — notably the `linux/arm64` leg under QEMU — node-gyp compiles it from source, which needs Python and a C++ toolchain. The build stages therefore install `python3 make g++` via apt, and the runtime image copies the already-compiled `node_modules` instead, keeping the shipped image free of build tooling. (This toolchain was added by #143 after builds broke without it.)

A related packaging subtlety: npm nests some production packages under the workspace instead of hoisting them (`undici` lives at `server/node_modules/undici`). Skipping the `server/node_modules` copy shipped images where the HTTP(S) proxy dispatcher failed to load and every request silently went direct (#550, fixed in c6589ff).

## Troubleshooting: container cannot reach providers (#733)

Providers unreachable from the container, but fine from the host? A container has its own network stack, so two things that work on your machine do not carry over:

- **A proxy on `127.0.0.1` is not your machine.** Inside the container, loopback is the container itself. If you reach providers through a proxy client on the host (Clash, v2rayN, sing-box, a corporate proxy), point FreeLLMAPI at the host instead: `PROXY_URL=socks5h://host.docker.internal:7890`. The bundled `docker-compose.yml` maps `host.docker.internal` to the host gateway via `extra_hosts`, so this works on plain Linux Docker as well as Docker Desktop. The proxy also has to accept connections from outside loopback (in Clash, `allow-lan: true`). More detail in [03-outbound-proxies.md](../env/03-outbound-proxies.md#docker-127001-is-the-container).
- **An IPv6-only host needs IPv6 enabled in Docker.** The default bridge network is IPv4-only, so on a host with no IPv4 route the container cannot reach anything, DNS included. Enable it in `/etc/docker/daemon.json` with `"ipv6": true`, `"ip6tables": true` and a `"fixed-cidr-v6"` range, then restart Docker.

To see which case you are hitting, ask the container directly:

```bash
docker compose exec freellmapi node -e "fetch('https://generativelanguage.googleapis.com/').then(r=>console.log('ok',r.status)).catch(e=>console.log('fail',e.cause?.code||e.message))"
```
