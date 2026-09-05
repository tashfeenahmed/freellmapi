**English** · [简体中文](../../zh-cn/env/CHANGELOG.md)

# Changelog

Revision history for `docs/env/`, listing the commits that shaped the runtime configuration surface documented here. Most recent first.

| Commit | Date | Summary |
| --- | --- | --- |
| `46ea0de` | 2026-09-02 | feat(proxy): honor TRUST_PROXY for reverse-proxied client IPs (#1041) — adds `TRUST_PROXY` (`false\|true\|<hops>\|addr/CIDR`, `.env.example:314`, `server/src/lib/config.ts:95-110` `parseTrustProxy`) forwarded to Express `trust proxy` so Analytics + `PROXY_RATE_LIMIT_RPM`/`ADMIN_RATE_LIMIT_RPM` see real client IP; default `false` (no spoof). |
| `4a8f095` | 2026-09-01 | Prune the quota observation log in 5k-row chunks (#1124) — quota audit trail refinement: chunk `20k→5k` rows (`QUOTA_OBSERVATIONS_PRUNE_CHUNK`) to keep each 60s tick near `250ms` budget (`QUOTA_OBSERVATIONS_PRUNE_BUDGET_MS`, `server/src/services/request-retention.ts:89-90`), backlog drains one chunk per minute until `done`. |
| `77e0ecc` | 2026-09-01 | perf: stop the quota panel from ranking the whole observation log on every poll (#1123) — introduces `QUOTA_OBSERVATIONS_RETENTION_DAYS=30` / `QUOTA_OBSERVATIONS_MAX_ROWS=200000` (`.env.example:230-233`, `server/src/services/request-retention.ts:22-24` `DEFAULT_QUOTA_OBSERVATIONS_*`), audit trail behind `provider_quota_state` (only newest row per pool read via indexed seek `20260901_000002`), pruned daily by age+count in budgeted chunks, client `staleTime 5s→30s` (`/api/health` 4.9s→12ms). |
| `36b877d` | 2026-09-01 | feat(proxy): Idempotency-Key support — stop client retries from double-spending free-tier quota (#1095) — introduces `IDEMPOTENCY_TTL_MS=24h` (`server/src/services/idempotency.ts:36,40-42` `idempotencyTtlMs()` → `24*60*60*1000`, `envNum` guard), hash `sha256(key)` + fingerprint `sha256(model+messages+…)` , `409` on conflict, non-streaming `POST /v1/chat/completions` only, in-flight NOT deduped. |
| `95bc46f` | 2026-09-01 | docs(idempotency): the in-flight window is not deduplicated, say so (#1110) — corrects `server/src/services/idempotency.ts:16-20` header: duplicate while original still running is `miss` (both execute), no pending-claim state; deliberately out of scope vs wedged key. |
| `86368ac` | 2026-09-01 | feat(proxy): auto-detect system-wide proxy settings as a last-resort fallback (#838) — adds `detectSystemProxy()` (`server/src/lib/proxy.ts:52-414` `scutil --proxy` / registry `ProxyEnable+ProxyServer` / `gsettings` GNOME `manual`+`http host/port`) at end of `PROXY_URL→dashboard→ALL_PROXY→HTTPS_PROXY→HTTP_PROXY→detectSystemProxy()→direct` chain (`resolveProxySource`), closes #353/#1069, best-effort 2s timeout, never throws. |
| `56eb257` | 2026-08-26 | Add an opt-in Fetch Relay outbound transport (#975) — adds `PROXY_MODE` (`forward` default, `fetch-relay` opt-in, `.env.example:76`, `server/src/lib/proxy.ts:52` `PROXY_MODES`) and `FETCH_RELAY_TOKEN` (bearer, encrypted at rest, empty=unauthenticated, `FETCH_RELAY_TOKEN` env precedence over DB, `.env.example:78`, `server/src/lib/proxy.ts:389-417`, `isLoopbackRelayHostname` / `fetchRelayUrlError` loopback guard, `Fetch-Relay-Target/Authorization` headers), cross-links to `../proxy/01-fetch-relay.md`. |
| `74df985` | 2026-08-23 | Server log viewer in the dashboard (#993) — added `SERVER_LOGS_RETENTION_DAYS` and `SERVER_LOGS_MAX_ROWS` for persisted warn/error logs. |
| `fe7744c` | 2026-08-23 | fix(proxy): never route loopback destinations through the proxy (#963) — added `FREEAPI_PROXY_LOCAL_DESTINATIONS` to opt in to proxying local/LAN endpoints via an ssh tunnel. |
| `473d790` | 2026-08-20 | fix(modelscope): stop health checks burning magic-grain quota (#882) — basis for the `MODELSCOPE_VALIDATE_CACHE_MS` entry. |
| `48591a8` | 2026-08-12 | fix(router): warn when MODEL_ROUTING_OVERRIDES never apply (#857) — boot-log warning for unmatched model ids. |
| `8f27336` | 2026-08-12 | feat(vision): end-to-end image input, body limits, inbound normalization (#852) — introduced `REQUEST_BODY_LIMIT_MB` and the `IMAGE_NORMALIZE*` knobs. |
| `c3f538e` | 2026-08-11 | feat(routing): per-model weight overrides via MODEL_ROUTING_OVERRIDES (#747) — introduced the routing override variable. |
| `ba39318` | 2026-08-11 | feat(dashboard): automatic update check w/ release-notes dialog (#782) — automatic release reminder behind the update-checker settings. |
| `8cb75ac` | 2026-08-10 | feat(proxy): opt-in X-Fallback-Detail header (#792) — introduced `FALLBACK_DETAIL_HEADER`. |
| `a6f7718` | 2026-08-06 | fix(db): harden data dir so WAL sidecars are covered (#795) — data-directory restriction and `FREEAPI_DB_DIR_HARDENING`. |
| `29eb340` | 2026-08-06 | feat: in-dashboard update checker (#635) — `FREELLMAPI_UPDATE_CHECK` and related variables. |

Regenerate with `git log --oneline -- .env.example`.
