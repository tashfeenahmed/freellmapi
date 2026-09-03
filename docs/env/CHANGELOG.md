# Changelog

Revision history for `docs/env/`, listing the commits that shaped the runtime configuration surface documented here. Most recent first.

| Commit | Date | Summary |
| --- | --- | --- |
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
