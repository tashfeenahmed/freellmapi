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

## Windows: "Smart App Control blocked an app that may be unsafe"

**Symptom:** On Windows 11 with Smart App Control on, the `FreeLLMAPI-Setup-*.exe` installer (or the app it installs) is blocked with "could not verify the publisher" and there is no "Run anyway" button (#1933).

**Cause:** The GitHub `.exe` is not code-signed. Smart App Control only runs files Microsoft's cloud already trusts or that carry a signature from a trusted certificate authority, and it has no per-app exception.

**Fix:** Install FreeLLMAPI from the **[Microsoft Store](https://apps.microsoft.com/detail/9PBN6G8K2B7F)**: the Store signs its package, so it runs with Smart App Control on, and the Store keeps it updated. Docker Desktop also works (see `install/01-install.md`). Turning Smart App Control off also works, but on some Windows builds it cannot be turned back on without reinstalling Windows.

The Store package is built by `npm --prefix desktop run dist:store` on Windows and by the release workflow's "Package Microsoft Store MSIX" step; the `store` job submits it when the `MSSTORE_SUBMIT` repository variable is `draft` or `auto`. Microsoft certifies each Store version, which takes one to three days, so the Store copy can be a release or two behind GitHub. The `store` job does not replace a submission that is still in certification, and the `Microsoft Store catch-up` workflow sends the newest release once the Store is clear (#2103).

## Update-check shows no update / unsigned build won't auto-update

**Symptom:** Dashboard checker shows `latest > running` but `Squirrel.Mac` refuses, or DMG auto-update fails.

**Cause:** `Squirrel.Mac` verifies code signature. An unsigned local `npm run dist` without certs produces an app but no valid update feed (`desktop/02-logging-and-updates.md`). DMG needs re-stamp via `refresh-mac-update-metadata.mjs` after `Apple stapler`.

**Fix:** Download the signed release from GitHub Releases, or sign with `CSC_*` / `APPLE_ID`.

## Reverse proxy `TRUST_PROXY` not seeing real client IP

**Symptom:** Analytics / rate limiting shows `127.0.0.1` instead of real client.

**Cause:** `TRUST_PROXY` defaults `false` (no spoof).

**Fix:** `TRUST_PROXY=1` for single reverse proxy (Caddy/nginx/Traefik on same host), or CIDR list (`TRUST_PROXY=100.64.0.0/10,192.168.1.10`). See `env/01-variables.md` `TRUST_PROXY` + `server/src/lib/config.ts:95-110` `parseTrustProxy()`.

## Claude Code compacts near 105k tokens

**Symptom:** Claude Code through FreeLLMAPI shows a context of about 105k (`/context` shows `… / 104.9k`). On a large project it compacts on the first or second prompt. (#2122, #2087)

**Cause:** Connect and `setup-claude` set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to the `context_window` of `auto`. That value is the window that most of your models hold (the upper median, #1717), divided by the router's 1.25 safety margin. Many free models have 131,072 tokens, so the value is 131,072 / 1.25 = 104,857. Claude Code then keeps about 33k free for its answer and a buffer, so it compacts at about 72k. A few 1M models in the pool do not change the median.

**Why not always the largest window:** Above the median, only your large-window models can serve the request. When they are rate limited (for example a Gemini free tier with 20 requests a day), the request fails, and a compaction of that long conversation fails too. Compaction at the median keeps the session on models that you have many of.

**Fix:** If your large-window models have enough quota, size Claude Code to them:

```bash
npx freellmapi setup-claude --url http://localhost:3001 --context-window max
# or for one session:
npx freellmapi launch --context-window max
```

`max` uses `max_context_window` on the `auto` entry of `GET /v1/models`: the largest window among the active chain's enabled, tool-capable models that have a key, after the 1.25 margin and the model's per-minute token limit. It can be lower than the default when the large models have no tool support or a small per-minute token limit. `setup-claude` prints the window it wrote, and the larger one when there is one. You can also give a number (`--context-window 400k`). Claude Code does not accept values below 100k. Prompts above the median window then go only to the models that can hold them. Run the command again after you add or remove keys for large-window models.

## Related

- [Desktop](../desktop/OVERVIEW.md) — `freeapi.log` rotation.
- [Proxy transports](../proxy/OVERVIEW.md) — fetch-relay protocol.
- [Env vars](../env/01-variables.md) — all knobs.
