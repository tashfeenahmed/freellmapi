# freellmapi-model-sync

An independent sidecar that discovers newly-free models on OpenRouter and
registers them into your local FreeLLMAPI deployment automatically, sooner
than FreeLLMAPI's monthly catalog snapshot.

It talks to FreeLLMAPI only through its HTTP dashboard API (`POST /api/keys/custom`,
`PATCH /api/models/:id`). It never patches FreeLLMAPI source, never writes to the
SQLite DB directly, and survives normal FreeLLMAPI image updates.

## What it does (one sync pass)

1. Logs in to the FreeLLMAPI dashboard (`POST /api/auth/login`) to get a bearer token.
2. Reads the local model inventory (`GET /api/models`) and finds the OpenRouter
   custom endpoint key (`GET /api/keys`), if any.
3. Calls OpenRouter `/api/v1/models` and keeps only models whose
   `pricing.prompt` and `pricing.completion` are both exactly `0`.
4. For free models not already covered locally (either as a native `openrouter`
   catalog row or as one of our custom rows), probes OpenRouter with a 1-token
   request using your key. Only callable models are added.
5. Adds them via `POST /api/keys/custom` (same path the dashboard's "Add custom
   provider" uses), bound to `https://openrouter.ai/api/v1` with your key.
6. For models we previously synced that have disappeared from OpenRouter's free
   list: increments a miss counter; after `DISABLE_AFTER_MISSES` (default 3)
   consecutive misses it disables the row (`PATCH enabled:false`) — it never
   deletes. If a disabled model reappears, it is re-enabled.
7. Writes structured logs and a small JSON state file (`state/sync-state.json`).

## Why a sidecar when FreeLLMAPI already has `custom-model-sync`?

The built-in `custom-model-sync` (env `CUSTOM_MODEL_SYNC_INTERVAL_MS`,
`CUSTOM_MODEL_SYNC_FREE_PATTERNS`) walks configured custom endpoints and
registers new models, but it filters "free" with a **static glob allowlist**
you maintain by hand. It cannot detect a model that *just became free* (like
`stealth/ox-alpha`) unless you add a pattern for it. This sidecar filters by
**actual upstream price == 0**, probes before adding, and applies 3-strike
disable/restore — none of which the built-in pass does. The two coexist fine
(both are add-only and idempotent).

## Files

- `sync.js` — the service (zero npm dependencies; Node 20 built-ins only).
- `Dockerfile`, `package.json` — container build.
- `docker-compose.yml` — standalone compose that joins FreeLLMAPI's network.
- `.env.example` — copy to `.env` and fill in.
- `state/` — created automatically; holds `sync-state.json`.

## Setup

1. Copy this directory somewhere stable, e.g. next to your FreeLLMAPI repo:
   `E:\AI\freellmapi-model-sync` (or keep it here).

2. Find the FreeLLMAPI docker network name:

   ```powershell
   docker network ls
   ```

   It is usually `freellmapi_default` (compose project = repo folder name). Set
   `FREEAPI_NETWORK` in `.env` to match.

3. Copy `.env.example` to `.env` and fill in:
   - `FREEAPI_EMAIL` / `FREEAPI_PASSWORD` — your FreeLLMAPI dashboard login.
   - `OPENROUTER_API_KEY` — your OpenRouter key (used for discovery, probe, and
     as the credential bound to the registered custom endpoint).
   - Leave `DRY_RUN=true` for the first run.

## Back up FreeLLMAPI before the first real (non-dry-run) add

The sidecar only uses the HTTP API, but back up the DB once before the first
write, as good practice. This is a safe **online** backup via better-sqlite3
inside the running container (handles WAL correctly):

```powershell
docker exec freellmapi-freellmapi_1 node -e "const Database=require('better-sqlite3');const db=new Database('/app/server/data/freeapi.db');const dest='/app/server/data/freeapi.db.bak-'+Date.now();db.backup(dest);console.log('backed up to',dest)"
```

Copy the backup out of the volume if you want it off-disk:

```powershell
docker cp freellmapi-freellmapi_1:/app/server/data/freeapi.db.bak-<timestamp> .\
```

## First run — dry run

```powershell
cd E:\AI\freellmapi-model-sync   # (or wherever you placed it)
docker compose build
docker compose up
```

With `DRY_RUN=true` it prints `[dry-run-would-add]` lines for each new free
model and writes nothing. Confirm `stealth/ox-alpha` (and the other free
models) are listed and not already covered. `Ctrl+C` to stop after the first
pass, or set `RUN_ONCE=true` to exit after one pass automatically.

## Real run

Edit `.env`: set `DRY_RUN=false`. Then:

```powershell
docker compose up -d
docker compose logs -f
```

You should see `[registered]`, `[probe-ok]`, and `[sync-done]` lines. Models are
added as `platform=custom`, `source=user`, bound to the OpenRouter endpoint key,
and appended to the fallback chain and active profiles (FreeLLMAPI does this in
the same `POST /api/keys/custom` transaction).

## Verify

```powershell
# Sidecar logs
docker compose logs --tail=100

# State file
type state\sync-state.json

# Inside FreeLLMAPI: our synced custom models + their endpoint
docker exec freellmapi-freellmapi_1 node -e "const Database=require('better-sqlite3');const db=new Database('/app/server/data/freeapi.db');console.table(db.prepare(\"SELECT id,platform,model_id,source,key_id,endpoint_scope,enabled FROM models WHERE platform='custom' AND endpoint_scope='https://openrouter.ai/api/v1'\").all());"

# Dashboard: open http://127.0.0.1:3001, Models tab — the auto-synced models
# appear as custom models under the "OpenRouter (auto-sync)" endpoint.

# Call one through FreeLLMAPI's unified proxy (use your FreeLLMAPI API key):
curl -s http://127.0.0.1:3001/v1/chat/completions -H "Authorization: Bearer <FREEAPI_API_KEY>" -H "Content-Type: application/json" -d "{\"model\":\"stealth/ox-alpha\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16}"
```

Restart FreeLLMAPI (`docker restart freellmapi-freellmapi_1`) and confirm the
synced models are still present (they are normal DB rows, not ephemeral).

## Idempotency & the 3-strike disable test

Run a second pass: nothing new is added (`[new-candidates] count: 0`); already
synced models are skipped. To test the 3-strike disable, temporarily point
`OPENROUTER_BASE_URL` at a stub that returns no free models (or remove one model
id from the upstream response), run 3 passes, and watch `[upstream-miss]` →
`[disabled]`. Restore the real URL and the next pass logs `[restored]`.

## Logs reference

Events you'll see: `sync-start`, `login`, `local-inventory`, `upstream-free`,
`new-candidates`, `probe-ok`, `probe-failed`, `registered`, `upstream-miss`,
`disabled`, `restored`, `sync-done`, plus `dry-run-would-add/disable/restore`
when `DRY_RUN=true`.

## Updating

Pull new `sync.js`/compose files and rebuild: `docker compose build && docker
compose up -d`. FreeLLMAPI image updates do not affect this sidecar. If a
future FreeLLMAPI catalog snapshot natively includes a model this sidecar
already added as custom, both rows coexist (different `platform`); the sidecar
will skip re-adding it because it's already "covered" by the native row. You can
manually disable the custom duplicate from the dashboard if desired.

## Rollback / uninstall

The sidecar adds models through the normal API, so rollback is just normal
dashboard cleanup:

```powershell
# Stop the sidecar
docker compose down

# Remove all auto-synced custom models (disables fallback/profile rows too):
# either delete them in the dashboard, or via the API:
#   DELETE /api/keys/custom/:id  (removes the endpoint key + its models)
# or per model:
#   DELETE /api/models/<dbId>
```

To restore the DB from backup (only if something went wrong):

```powershell
docker stop freellmapi-freellmapi_1
docker cp ./freeapi.db.bak-<timestamp> freellmapi-freellmapi_1:/app/server/data/freeapi.db
docker start freellmapi-freellmapi_1
```

## Config reference

| Env | Default | Purpose |
|---|---|---|
| `FREEAPI_BASE_URL` | `http://freellmapi:3001` | FreeLLMAPI base URL (in-network) |
| `FREEAPI_EMAIL` / `FREEAPI_PASSWORD` | — | Dashboard login (required) |
| `FREEAPI_NETWORK` | `freellmapi_default` | Docker network to join |
| `OPENROUTER_API_KEY` | — | OpenRouter key (required) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Upstream base URL |
| `OPENROUTER_LABEL` | `OpenRouter (auto-sync)` | Label for the custom endpoint |
| `SYNC_INTERVAL_MS` | `28800000` (8h) | Pass interval; handoff suggests 6–12h |
| `DISABLE_AFTER_MISSES` | `3` | Consecutive misses before disable |
| `DRY_RUN` | `true` | First-pass safety; set `false` to write |
| `RUN_ONCE` | `false` | One pass then exit |
| `PROBE_TIMEOUT_MS` | `30000` | Per-model probe timeout |
| `LOG_MODELS` | `false` | Verbose: log every free model id |

## Scope & safety

- OpenRouter only for now; more providers can be added later.
- No secrets are printed in logs (only statuses and model ids).
- All writes go through FreeLLMAPI's own transactional API, so routing state
  (`fallback_config`, `profile_models`) stays consistent.
