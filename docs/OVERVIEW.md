# Docs directory overview

## Scope

This file is the domain index for `docs/` — a complete file map of every guide and domain folder (install, API, clients, compression, architecture deep-dives, env, deployment, providers, testing, fallback, logs, i18n). It lists where each document lives and how the domain folders relate.

For getting started as a user, see [README.md](README.md) (the user entry point); for the product overview, see the root [README](../README.md).

## File index

| File | Description |
| --- | --- |
| [README.md](README.md) | Documentation index: links every guide plus related docs elsewhere in the repo. |
| [install.md](install.md) | Install & deploy: one-liner quick start, Docker Compose, local development, declarative startup config, the Docker image, desktop app, and data locations. |
| [api/01-rest-api.md](api/01-rest-api.md) | API reference: chat completions, `auto:*` routing strategies, streaming, tool calling, vision, embeddings, response headers, and the Anthropic Messages surface. |
| [clients/01-agent-clients.md](clients/01-agent-clients.md) | Clients & coding agents: OpenAI-compatible clients, setup recipes for Claude Code / Codex CLI / Cline / Continue / Aider / opencode / Cursor, MCP server, autocomplete, Context Handoff. |
| [compression/01-compression-pipeline.md](compression/01-compression-pipeline.md) | Prompt compression: request-side modes, safeguards, per-request controls, custom tool-output filters, statistics, and preview APIs. |
| [architecture.md](architecture.md) | Architecture & internals (high-level index): how the router works, routing and operational details, what is not supported, limitations, and the provider Terms-of-Service review. |
| [architecture/](architecture/OVERVIEW.md) | Architecture deep-dives: bandit routing & scoring, quota & cooldown engine, streaming pipeline, degraded mode & failover, catalog sync, observability; see its own [OVERVIEW.md](architecture/OVERVIEW.md). |
| [i18n/01-translating.md](i18n/01-translating.md) | Translating: rules for locale files, the validator, and the settled zh-CN terminology table. |
| [index.html](index.html) | Static website asset (not a doc): redirect page to freellmapi.co. |
| [success.html](success.html) | Static website asset (not a doc): post-install success page. |
| [install.sh](install.sh) | Unix Docker bootstrap script served by the project website. |
| [install.ps1](install.ps1) | PowerShell bootstrap script served by the project website. |
| [env/](env/OVERVIEW.md) | Runtime configuration: full `.env` variable reference, encryption-key lifecycle, and outbound-proxy configuration; see its own [OVERVIEW.md](env/OVERVIEW.md). |
| [deployment/](deployment/OVERVIEW.md) | Docker operations: image & Compose reference, container networking gotchas, upgrades, backups, declarative config; see its own [OVERVIEW.md](deployment/OVERVIEW.md). |
| [providers/](providers/OVERVIEW.md) | Provider integrations: supported-platform catalog with auth models and adapter classes, per-key quota accounting and cooldowns, and a contributor walkthrough for adding a provider; see its own [OVERVIEW.md](providers/OVERVIEW.md). |
| [testing/](testing/OVERVIEW.md) | Testing: local test command matrix and CI summary, server-suite layout and conventions, and the e2e coding-agent compatibility suite; see its own [OVERVIEW.md](testing/OVERVIEW.md). |
| [i18n/](i18n/OVERVIEW.md) | Translated documentation tree (zh-CN); see its own [OVERVIEW.md](i18n/OVERVIEW.md). |
| [install/](install/OVERVIEW.md) | Platform-specific installation guides; see its own [OVERVIEW.md](install/OVERVIEW.md). |
| [logs/](logs/OVERVIEW.md) | Server logs viewer: live dashboard panel, two-tier store, polling API, and configuration; see its own [OVERVIEW.md](logs/OVERVIEW.md). |
| [fallback/](fallback/OVERVIEW.md) | Named fallback chains: chain lifecycle, empty-chain authoritative 400, `auto:<name>` discovery, catalog-sync backfill (`auto_include_new_models`); see its own [OVERVIEW.md](fallback/OVERVIEW.md). |

> `index.html` and `success.html` are static website assets shipped with the docs directory, not markdown documentation.
