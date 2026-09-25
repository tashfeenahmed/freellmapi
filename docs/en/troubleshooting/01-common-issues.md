**English** · [简体中文](../../zh-cn/troubleshooting/01-common-issues.md)

# Common issues

## Docker container cannot reach providers

**Symptom:** `ECONNREFUSED` or timeouts to `127.0.0.1:11434` (Ollama) or `localhost` from inside the container, but the host can reach them.

**Cause:** `127.0.0.1` inside the container is the container itself, not the host. See `deployment/01-docker.md` container-cannot-reach-providers gotcha.

**Fix:** Use `host.docker.internal` (Docker Desktop) or `172.17.0.1` / host's LAN IP (Linux), and ensure the proxy (Clash/v2rayN/sing-box) listens on `0.0.0.0` not `127.0.0.1`. Compose `host-gateway` mapping: `extra_hosts: ["host.docker.internal:host-gateway"]`.

**Diagnose:** `docker exec freellmapi curl -v http://host.docker.internal:11434/api/tags`.

## Empty chain `400`

**Symptom:** `POST /v1/chat/completions` returns `400 active chain is empty` (or fallback ladder empty).

**Cause:** The active fallback chain exists but has no models enabled since `e852ff1`/`b3bf20f` — empty chains are now authoritative, not silently falling back to the catalog.

**Fix:** Open `Fallback` page → enable models in the active chain, or set `profiles.auto_include_new_models=1`, or switch active profile. See `fallback/01-named-chains.md`.

## Fetch-relay loopback guard

**Symptom:** `fetchRelayUrlError` or `isLoopbackRelayHostname` 400 when using `PROXY_MODE=fetch-relay`.

**Cause:** Loopback `PROXY_URL` (`127.0.0.1`, `::1`) is blocked by `enforceRelayUrlPolicy` unless explicitly allowed; SOCKS is rejected for fetch-relay (only `http`/`https`, `http` only for loopback).

**Fix:** Use a public `https://relay.example.workers.dev` URL. For local testing, check `server/src/lib/proxy.ts:339-350` policy. See `proxy/01-fetch-relay.md`.

## Idempotency `409` conflict

**Symptom:** `409 Idempotency-Key already used with different request` on retry.

**Cause:** The same `Idempotency-Key` was sent with a different fingerprint (`model`/`messages`/`temperature`/`top_p`/`max_tokens`/`tools`/`tool_choice` differ). See `api/02-idempotency.md`.

**Fix:** Use a fresh UUID per distinct request, or replay the identical body. In-flight window is NOT deduped (`95bc46f`) — a concurrent retry with the same key may still race.

## Quota panels show stale or ranking delay

**Symptom:** Quota panel slow to update or shows many rows.

**Fix:** `QUOTA_OBSERVATIONS_RETENTION_DAYS=30` / `QUOTA_OBSERVATIONS_MAX_ROWS=200000` prune daily in `5k`/`250ms` chunks (`4a8f095`); ensure the DB is on a fast volume. Check `server/src/services/request-retention.ts:68-137` and `provider-quota.ts:532-586` correlated `LIMIT 1` seek.

## Password-reset code not visible (desktop)

**Symptom:** `POST /api/auth/forgot-password` prints a one-time code but the desktop app shows nothing.

**Cause:** Finder/Explorer-launched Electron has no attached `stdout`.

**Fix:** Open tray → `Open Logs Folder` → `freeapi.log` (`desktop/src/logger.ts` tee, `installFileLogger` before server boot). Or use `docker logs`.

## Update-check shows no update / unsigned build won't auto-update

**Symptom:** Dashboard checker shows `latest > running` but `Squirrel.Mac` refuses, or DMG auto-update fails.

**Cause:** `Squirrel.Mac` verifies code signature. An unsigned local `npm run dist` without certs produces an app but no valid update feed (`desktop/02-logging-and-updates.md`). DMG needs re-stamp via `refresh-mac-update-metadata.mjs` after `Apple stapler`.

**Fix:** Download the signed release from GitHub Releases, or sign with `CSC_*` / `APPLE_ID`.

## Reverse proxy `TRUST_PROXY` not seeing real client IP

**Symptom:** Analytics / rate limiting shows `127.0.0.1` instead of real client.

**Cause:** `TRUST_PROXY` defaults `false` (no spoof).

**Fix:** `TRUST_PROXY=1` for single reverse proxy (Caddy/nginx/Traefik on same host), or CIDR list (`TRUST_PROXY=100.64.0.0/10,192.168.1.10`). See `env/01-variables.md` `TRUST_PROXY` + `server/src/lib/config.ts:95-110` `parseTrustProxy()`.

## Related

- [Desktop](../desktop/OVERVIEW.md) — `freeapi.log` rotation.
- [Proxy transports](../proxy/OVERVIEW.md) — fetch-relay protocol.
- [Env vars](../env/01-variables.md) — all knobs.
