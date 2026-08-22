# Docs directory overview

## Scope

This directory holds FreeLLMAPI's user-facing documentation: how to install and deploy the gateway, the OpenAI-compatible API reference, the router's architecture and honest limitations, integration recipes for clients and coding agents, the prompt compression pipeline, and the guide for translating the dashboard and docs.

The root [README](../README.md) is the product overview; this directory contains the detailed guides. [README.md](README.md) here is the documentation index.

## File index

| File | Description |
| --- | --- |
| [README.md](README.md) | Documentation index: links every guide plus related docs elsewhere in the repo. |
| [install.md](install.md) | Install & deploy: one-liner quick start, Docker Compose, local development, declarative startup config, the Docker image, desktop app, and data locations. |
| [api.md](api.md) | API reference: chat completions, `auto:*` routing strategies, streaming, tool calling, vision, embeddings, response headers, and the Anthropic Messages surface. |
| [clients.md](clients.md) | Clients & coding agents: OpenAI-compatible clients, setup recipes for Claude Code / Codex CLI / Cline / Continue / Aider / opencode / Cursor, MCP server, autocomplete, Context Handoff. |
| [compression.md](compression.md) | Prompt compression: request-side modes, safeguards, per-request controls, custom tool-output filters, statistics, and preview APIs. |
| [architecture.md](architecture.md) | Architecture & internals: how the router works, routing and operational details, what is not supported, limitations, and the provider Terms-of-Service review. |
| [translating.md](translating.md) | Translating: rules for locale files, the validator, and the settled zh-CN terminology table. |
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

> `index.html` and `success.html` are static website assets shipped with the docs directory, not markdown documentation.
