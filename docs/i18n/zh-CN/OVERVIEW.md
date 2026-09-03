# zh-CN Translations

## Scope

Simplified Chinese translations of the core documentation: the pages that cover
what FreeLLMAPI is, how to install it, and how to call its API. Each file below
mirrors an English original at the same position in the tree, with
`docs/i18n/zh-CN/` removed from the path.

Terminology follows the settled zh-CN table in
[../01-translating.md](../01-translating.md) so these docs and the dashboard UI
use the same words (提供方, 词元, 令牌, ...).

## File index

| File | Mirrors | Description |
| --- | --- | --- |
| [README.md](README.md) | [../../../README.md](../../../README.md) | Project overview: what the gateway does, supported providers, quick start, and configuration - the full root README in Simplified Chinese. |
| [docs/README.md](docs/README.md) | [../../../docs/README.md](../../../docs/README.md) | Documentation index page listing every guide in the docs tree. |
| [docs/install.md](docs/install.md) | [../../../docs/install.md](../../../docs/install.md) | Installation guide covering Docker Compose, local setup, and desktop app installs. |
| [docs/api/01-rest-api.md](docs/api/01-rest-api.md) | [../../../docs/api/01-rest-api.md](../../../docs/api/01-rest-api.md) | API reference for the OpenAI-compatible `/v1` endpoints, authentication, and request formats. |

### Translated domain subtrees

Each folder below mirrors a `docs/` subdomain (OVERVIEW, numbered topic
docs, CHANGELOG):

| Folder | Mirrors | Contents |
| --- | --- | --- |
| [docs/env/](docs/env/OVERVIEW.md) | [../../../docs/env/](../../../docs/env/) | Runtime configuration surface: the full `.env` variable reference, encryption-key handling, and outbound proxy configuration. |
| [docs/deployment/](docs/deployment/OVERVIEW.md) | [../../../docs/deployment/](../../../docs/deployment/) | Docker operations: image, Compose quickstart, persistence, healthchecks, upgrades, and backups. |
| [docs/providers/](docs/providers/OVERVIEW.md) | [../../../docs/providers/](../../../docs/providers/) | Provider layer: supported platforms catalog, quotas/cooldowns/key health, and how to add a new provider. |
| [docs/testing/](docs/testing/OVERVIEW.md) | [../../../docs/testing/](../../../docs/testing/) | Test matrix across workspaces, server suite conventions, and the coding-agent compatibility suite. |
| [docs/logs/](docs/logs/OVERVIEW.md) | [../../../docs/logs/](../../../docs/logs/) | Live server log viewer in the dashboard: two-tier store, polling API, level counts, clear endpoint, env vars, redaction integration. |
| [docs/architecture/](docs/architecture/OVERVIEW.md) | [../../../docs/architecture/](../../../docs/architecture/) | Deep-dive server architecture: bandit router, quota/cooldown engine, streaming pipeline, degraded mode, catalog sync, observability. |

Pages not listed here have no translation yet; they link to their English
originals by design.

## Navigation

- Up one level: [../OVERVIEW.md](../OVERVIEW.md)
- Language toggle: every README above links back to
  **[English](../../../README.md)** via the centered language bar at the top.
