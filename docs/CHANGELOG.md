# Changelog

Revision history for `docs/`, derived from git commits touching this directory. Most recent first. Rows marked "landed via #N" describe work done on a contributor branch and squash-merged; the commit shown is the squash on `main`.

## 2026-09-05 — Per-language structure

| Commit | Date | Summary |
| --- | --- | --- |
| `ef1b9ce` | 2026-09-05 | docs(zh-cn): translate the four stub pages, fix the Chinese index, anchors and language switchers (#1167) |
| `eab992f` | 2026-09-05 | docs: per-language layout `docs/{en,zh-cn}`, Chinese README, redirect stubs at the old paths (#1164). Squash of the contributor branch: scaffold `en/` and `zh-cn/`, move the 17 English domains under `en/`, migrate the Chinese translations out of `docs/i18n/zh-CN/docs/` into `zh-cn/`, translate the cli, desktop, proxy, fallback, glossary and troubleshooting domains, fix link depths. |
| `36850e8` | 2026-09-01 | docs: per-domain folders with OVERVIEW/CHANGELOG metadata (#979). Squash of the contributor branch whose rows are dated 2026-08-22 to 2026-08-25 below. |

## 2026-09-02

| Commit | Date | Summary |
| --- | --- | --- |
| `eab992f` | 2026-09-02 | docs(proxy): create proxy domain and move Fetch Relay into it — `01-fetch-relay.md` moved from flat `fetch-relay.md`, `detectSystemProxy()` OS auto-detect, `TRUST_PROXY` (landed via #1164) |
| `eab992f` | 2026-09-02 | docs(env): cover `PROXY_MODE`, `FETCH_RELAY_TOKEN`, `TRUST_PROXY`, `QUOTA_OBSERVATIONS_*`, `IDEMPOTENCY_TTL_MS` — full precedence chain, callout boxes (landed via #1164) |
| `eab992f` | 2026-09-02 | docs(api): document Idempotency-Key safe retries (`02-idempotency.md`) — replay/409/miss, fingerprint, curl example (landed via #1164) |

## 2026-08-25

| Commit | Date | Summary |
| --- | --- | --- |
| `36850e8` | 2026-08-25 | docs(api): document video platforms (pollinations/huggingface, 5-min bound, fal queue), free-tier budget API (`GET /api/free-tier`, pool-deduped), and backups API (`GET /api/backups`, DUMP_FORMAT=1, sha256 fingerprint) (landed via #979) |
| `36850e8` | 2026-08-25 | docs(fallback): add named-chains domain — chain lifecycle, empty-chain authoritative 400 (`activeChainOrThrow`, e852ff1), `auto:<name>` in `GET /v1/models` (cc1e985), `profiles.auto_include_new_models` (b3bf20f), named-chain manager UI (8bb2004) (landed via #979) |
| `36850e8` | 2026-08-25 | docs(observability): dedupe 06-observability.md against logs viewer, cross-link both ways, add desktop `freeapi.log` file-logger note (90aaa5b) (landed via #979) |
| `36850e8` | 2026-08-25 | docs(providers): refresh free-tier numbers to 34 providers / 474 families / 635 endpoints (~7.4B tokens/month) in providers/OVERVIEW.md and providers/01-supported-platforms.md (landed via #979) |

## 2026-08-23

| Commit | Date | Summary |
| --- | --- | --- |
| `36850e8` | 2026-08-23 | docs(meta): fix broken links from 2026-08-23 doc updates — 24 links fixed across 16 files (api/compression/clients/i18nzh) (landed via #979) |
| `1a0ce48` | 2026-08-23 | feat(cli): setup-dsh — configure DeepSeek Harness in one command (#995) |
| `cf0c216` | 2026-08-23 | perf(compression): early-exit protected-span check in the per-line hot path (#990) |
| `74df985` | 2026-08-23 | Server log viewer in the dashboard, under an Analytics nav menu (#993) |
| `36850e8` | 2026-08-22 | docs(meta): index providers/testing domains and log today's additions (landed via #979) |
| `36850e8` | 2026-08-22 | docs(testing): add test matrix and compatibility-suite documentation (landed via #979) |
| `36850e8` | 2026-08-22 | docs(providers): add platform catalog and integration guides (landed via #979) |
| `36850e8` | 2026-08-22 | docs(deployment): add Docker operations and maintenance domain (landed via #979) |
| `36850e8` | 2026-08-22 | docs(env): add runtime configuration reference domain (landed via #979) |


## 2026-08-10 and earlier

| Commit | Date | Summary |
| --- | --- | --- |
| `8cb75ac` | 2026-08-10 | feat(proxy): opt-in X-Fallback-Detail header with per-hop failover timings (#792) |
| `35af82c` | 2026-08-10 | fix(anthropic): stop silently dropping document content blocks (#793) |
| `c7a71a2` | 2026-08-03 | fix(i18n): polish zh-CN strings (#740) |
| `5d51fec` | 2026-08-03 | docs(docker): explain why a container cannot reach providers the host can (#737) |
| `72658ad` | 2026-08-03 | fix(headers,clipboard): serve dashboard cleanly over plain HTTP (#735) |
| `93afdca` | 2026-08-01 | docs(i18n): give the zh README a 贡献者 heading (#701) |
| `76c3e6b` | 2026-07-31 | docs: center language toggle above hero screenshot (#691) |
| `3ea33cb` | 2026-07-31 | docs(i18n): translate install.md and api.md into zh-CN (#690) |
| `41527f2` | 2026-07-31 | docs(i18n): add translated-docs tree + zh-CN README (#689) |
| `c8be5a6` | 2026-07-31 | docs(i18n): pin zh glossary, land two agreed zh-CN fixes (#683) |
| `36eea7b` | 2026-07-30 | cli: publish freellmapi to npm (#672) |
| `e0befba` | 2026-07-29 | feat(custom): per-endpoint identity for relay models (#659) |
| `d695bbc` | 2026-07-28 | fix(server): make X-Routed-Via header-safe (#639) |
| `19168ac` | 2026-07-27 | Add end-to-end coding-agent compatibility suite (#629) |
| `878fb89` | 2026-07-27 | Add prompt and context compression pipeline (#628) |
| `90d291d` | 2026-07-27 | Split README into focused docs pages (#627) |
| `099fcd5` | 2026-07-20 | Termux support, docs index, health-check error surfacing (#573) |
| `03da4bb` | 2026-06-20 | ci(desktop): Windows .exe + macOS .dmg installers; Windows install path (#349) |
| `076fa69` | 2026-06-10 | feat: Premium live catalog — signed sync, license keys, self-serve billing |
| `9c2fa1b` | 2026-06-07 | feat(catalog): V24 Zen roster refresh |
| `2127a42` | 2026-06-07 | feat(catalog): V23 free-tier audit |
| `dd5b015` | 2026-05-31 | docs(site): landing page update to 16 providers (~1.7B tokens) (#150) |
| `8257eff` | 2026-05-02 | fix(catalog): 400 on explicit unknown/disabled model + sync docs (#24) |
| `b5f8f4d` | 2026-05-02 | docs: Open Graph + Twitter Card meta + OG image (#21) |

Regenerate with `git log --oneline -- docs/`.
