# zh-CN Translations

## Scope

Simplified Chinese translations of the core documentation: the pages that cover
what FreeLLMAPI is, how to install it, and how to call its API. Each file below
mirrors an English original at the same position in the tree, with
`docs/i18n/zh-CN/` removed from the path.

Terminology follows the settled zh-CN table in
[../TRANSLATION.md](../TRANSLATION.md) so these docs and the dashboard UI
use the same words (提供方, 词元, 令牌, ...).

## File index

| File | Mirrors | Description |
| --- | --- | --- |
| [README.md](README.md) | [../../README.md](../../README.md) | Project overview: what the gateway does, supported providers, quick start, and configuration - the full root README in Simplified Chinese. |
| [../en/README.md](../en/README.md) | [../en/README.md](../en/README.md) | Documentation index page listing every guide in the docs tree. |
| [docs/install.md](../en/install/01-install.md) | [../../../docs/install.md](../en/install/01-install.md) | Installation guide covering Docker Compose, local setup, and desktop app installs. |
| [../en/api/01-rest-api.md](../en/api/01-rest-api.md) | [../en/api/01-rest-api.md](../en/api/01-rest-api.md) | API reference for the OpenAI-compatible `/v1` endpoints, authentication, and request formats. |

### Translated domain subtrees

Each folder below mirrors a `docs/` subdomain (OVERVIEW, numbered topic
docs, CHANGELOG):

| Folder | Mirrors | Contents |
| --- | --- | --- |
| [../en/env/](../en/env/OVERVIEW.md) | [../../../../en/env/](../en/env/) | Runtime configuration surface: the full `.env` variable reference, encryption-key handling, and outbound proxy configuration. |
| [../en/deployment/](../en/deployment/OVERVIEW.md) | [../../../../en/deployment/](../en/deployment/) | Docker operations: image, Compose quickstart, persistence, healthchecks, upgrades, and backups. |
| [../en/providers/](../en/providers/OVERVIEW.md) | [../../../../en/providers/](../en/providers/) | Provider layer: supported platforms catalog, quotas/cooldowns/key health, and how to add a new provider. |
| [../en/testing/](../en/testing/OVERVIEW.md) | [../../../../en/testing/](../en/testing/) | Test matrix across workspaces, server suite conventions, and the coding-agent compatibility suite. |
| [../en/logs/](../en/logs/OVERVIEW.md) | [../../../../en/logs/](../en/logs/) | Live server log viewer in the dashboard: two-tier store, polling API, level counts, clear endpoint, env vars, redaction integration. |
| [../en/architecture/](../en/architecture/OVERVIEW.md) | [../../../../en/architecture/](../en/architecture/) | Deep-dive server architecture: bandit router, quota/cooldown engine, streaming pipeline, degraded mode, catalog sync, observability. |
| [../en/cli/](../en/cli/OVERVIEW.md) | [../../../../en/cli/](../en/cli/) | Setup CLI: `setup-*` generators, config-file merge layer, zero-persistence launchers and `doctor`. |
| [../en/desktop/](../en/desktop/OVERVIEW.md) | [../../../../en/desktop/](../en/desktop/) | Desktop app: Electron shape, file logging and update delivery. |
| [../en/fallback/](../en/fallback/OVERVIEW.md) | [../../../../en/fallback/](../en/fallback/) | Named fallback chains: lifecycle, `auto:<name>`, catalog-sync backfill. |
| [../en/glossary/](../en/glossary/OVERVIEW.md) | [../../../../en/glossary/](../en/glossary/) | Glossary of recurring terms: headroom, RPD/TPD, pool key, `auto:<name>`, model-age gate. |
| [../en/proxy/](../en/proxy/OVERVIEW.md) | [../../../../en/proxy/](../en/proxy/) | Outbound proxy transports: forward vs fetch-relay, system auto-detect. |
| [../en/troubleshooting/](../en/troubleshooting/OVERVIEW.md) | [../../../../en/troubleshooting/](../en/troubleshooting/) | 常见问题：Docker 容器网络、空链 `400`、fetch-relay 环回防护、幂等 `409`、额度面板、更新检查、密码重置、反向代理 `TRUST_PROXY`。 |

Pages not listed here have no translation yet; they link to their English
originals by design.

## Navigation

- Up one level: [../OVERVIEW.md](../OVERVIEW.md)
- Language toggle: every README above links back to
  **[English](../../README.md)** via the centered language bar at the top.
