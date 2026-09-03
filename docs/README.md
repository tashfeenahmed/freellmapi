**English** · [简体中文](i18n/zh-CN/docs/README.md)

# FreeLLMAPI documentation

This is the user entry point — start here to install the gateway, call the OpenAI-compatible API, connect coding agents and understand the high-level architecture. The root [README](../README.md) is the product overview; this index gets you running.

## Guides

- **[Install & deploy](install.md)** — quick start, Docker Compose, local development, declarative startup config, the Docker image, backups, the desktop app, where your data lives, and an FAQ on password resets, logs and uninstalling.
- **[API reference](api/01-rest-api.md)** — chat completions, `auto:*` routing strategies, streaming, tool calling, vision, Gemini Google Search grounding, embeddings, response headers, and the Anthropic Messages surface.
- **[Clients & coding agents](clients/01-agent-clients.md)** — OpenAI-compatible clients, recipes for Claude Code / Codex CLI / Cline / Continue / Aider / opencode / Cursor, the MCP server, editor autocomplete, and Context Handoff.
- **[Prompt compression](compression/01-compression-pipeline.md)** — request-side modes, safeguards, per-request controls, custom tool-output filters, statistics, and preview APIs.
- **[Fetch Relay](fetch-relay.md)** — route provider HTTP requests through a user-controlled, streaming application-layer relay.
- **[Architecture & internals](architecture.md)** — how the router works, routing and operational details, what's not supported, honest limitations, and the provider Terms-of-Service review.

## More

- [Android with Termux](install/android-termux.md) — experimental local installation using Node's built-in SQLite driver.
- [Fallback chains](fallback/01-named-chains.md) — named fallback-chain lifecycle, empty-chain authoritative 400, `auto:<name>` routing, and catalog-sync backfill.
- [Docker deployment](../docker/README.md) — container configuration and persistent storage.
- [Desktop app](../desktop/README.md) — build and package the Electron application.
- [Contributor guide](../CONTRIBUTING.md) — development loop, testing expectations, and contribution policy.
- [Database migrations](../server/src/db/README.md) — create, apply, inspect, and roll back schema migrations.

## Website assets in this directory

- [`index.html`](index.html) — project landing page.
- [`install.sh`](install.sh) — Unix Docker bootstrap script.
- [`install.ps1`](install.ps1) — PowerShell bootstrap script.
- [`success.html`](success.html) — post-install success page.
