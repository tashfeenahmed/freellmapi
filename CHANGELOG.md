# Changelog — meliani/freellmapi fork

Changes made on top of upstream [`tashfeenahmed/freellmapi`](https://github.com/tashfeenahmed/freellmapi) for self-hosted deployment on Dokploy / Docker Swarm infrastructure.

---

## [Unreleased] — 2026-05-23 / 2026-05-24

### Added

#### Docker / Self-hosting support

The upstream repo ships no container image or build config. These commits add everything needed to deploy FreeLLMAPI on any Docker host or Dokploy instance.

**`Dockerfile`** (multi-stage, Node 22 Alpine)

```
ca0bfde  Add Dockerfile and docker-compose for self-hosted Dokploy deployment
e61a429  Fix build: copy workspace package.json files before npm ci
8529949  Fix production image: add client/dist and bump to node:22-alpine
```

- Two-stage build: `node:22-alpine` build stage runs `npm ci` + `npm run build`; lean production stage copies only compiled output.
- Explicit `COPY server/package*.json` and `COPY client/package*.json` before `npm ci` — required for npm workspaces so devDependencies (including `tsc`) are installed in the correct workspace.
- Production stage copies both `server/dist/` **and** `client/dist/` so the React dashboard is served correctly. (Missing `client/dist` caused `ENOENT /app/client/dist/index.html` at startup.)
- Base image: `node:22-alpine` (LTS). The original draft used `node:20-alpine` which has 11 known high CVEs as of May 2026.

**`docker-compose.yml`**

```
ca0bfde  Add Dockerfile and docker-compose for self-hosted Dokploy deployment
```

- Builds from the local Dockerfile.
- Named volume mounted at `/app/server/data` (actual SQLite path derived from `server/src/db/index.ts`).
- Connects to external `proxy-network` so Traefik auto-discovers the service.
- Traefik labels pre-configured for `freellm.rab.dc.microservice.ma` internal routing.
- `restart: unless-stopped`.

**`nixpacks.toml`**

```
7b91d54  Add nixpacks.toml for faster Dokploy builds
```

- Explicit `install`, `build`, and `start` phases for Nixpacks build system.
- Without this file, Nixpacks auto-detection fails: the root `package.json` has no `start` script (the app is started with `node server/dist/index.js`).
- Allows switching between Dockerfile and Nixpacks build types in Dokploy for faster cached rebuilds.

```toml
[phases.install]
cmds = ["npm ci --loglevel=error"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "node server/dist/index.js"
```

---

### Fixed

#### Build noise suppression

```
9b5b51f  Suppress build noise: npm deprecation warnings and vite chunk size warning
```

- `npm ci --loglevel=error` — silences deprecation warnings from transitive dependencies (`prebuild-install`, `node-domexception`, `esbuild-kit`) that are upstream issues, not errors.
- `client/vite.config.ts`: added `build: { chunkSizeWarningLimit: 1000 }` — suppresses the Vite "chunk size exceeded 500 kB" warning caused by vendor bundle size, which does not affect runtime behaviour.

#### Router: exponential backoff for 429 cooldowns

```
ce7d922  Add exponential backoff for 429 cooldowns (2min->10min->1h->24h)
```

**Problem:** The router placed a fixed 120-second cooldown on a model+key after any 429 or 5xx error (`proxy.ts:416`). For providers with *daily* quotas (e.g. OpenRouter free: 50 req/day; Cohere free: ~33 req/day), the key exhausts its quota for the day, gets a 2-minute cooldown, is retried, fails again immediately, and repeats — consuming all 20 fallback slots and returning a 429 to the caller without ever succeeding.

**Fix:** `server/src/services/ratelimit.ts` — added `getNextCooldownDuration()` which tracks how many times each key has been placed on cooldown within the last 24 hours and returns an escalating duration:

| Cooldown # (within 24 h) | Duration |
|---|---|
| 1st | 2 minutes |
| 2nd | 10 minutes |
| 3rd | 1 hour |
| 4th and beyond | **24 hours** |

`proxy.ts:416` now calls `getNextCooldownDuration(platform, modelId, keyId)` instead of the hardcoded `120_000`. After 4 consecutive failures the key is effectively quarantined until the next day's quota reset — without needing to distinguish per-minute from per-day rate limit errors.

**Files changed:**
- `server/src/services/ratelimit.ts` — `cooldownHits` map + `getNextCooldownDuration()` export
- `server/src/routes/proxy.ts` — import + use `getNextCooldownDuration`

---

## Commits in this fork (oldest → newest)

| Commit | Date | Summary |
|---|---|---|
| `ca0bfde` | 2026-05-23 | Add Dockerfile and docker-compose for self-hosted Dokploy deployment |
| `e61a429` | 2026-05-23 | Fix build: copy workspace package.json files before npm ci |
| `9b5b51f` | 2026-05-23 | Suppress build noise: npm deprecation warnings and vite chunk size warning |
| `8529949` | 2026-05-23 | Fix production image: add client/dist and bump to node:22-alpine |
| `7b91d54` | 2026-05-23 | Add nixpacks.toml for faster Dokploy builds |
| `ce7d922` | 2026-05-24 | Add exponential backoff for 429 cooldowns (2min->10min->1h->24h) |
