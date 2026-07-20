# FreeLLMAPI documentation

This index points to the focused guides in the repository. The root [README](../README.md) remains the product overview and complete API reference.

## Install and deploy

- [Quick start](../README.md#quick-start) — Docker one-liner, manual Docker Compose, and local development.
- [Docker deployment](../docker/README.md) — container configuration and persistent storage.
- [Desktop app](../desktop/README.md) — build and package the Electron application.
- [Android with Termux](install/android-termux.md) — experimental local installation using Node's built-in SQLite driver.

## Configure and operate

- [Declarative startup configuration](../README.md#declarative-startup-config) — configure keys and custom providers from environment variables.
- [Credentials and local data](../README.md#credentials-and-where-your-data-lives) — desktop paths and credential storage.
- [Premium live catalog](../README.md#premium-live-catalog) — catalog update behavior and licensing.
- [Database migrations](../server/src/db/README.md) — create, apply, inspect, and roll back schema migrations.

## Integrate clients

- [OpenAI-compatible clients](../README.md#works-with-openai-compatible-clients) — SDK and tool configuration.
- [Coding agents](../README.md#coding-agents) — Codex CLI, Claude Code, OpenCode, and MCP clients.
- [Using the API](../README.md#using-the-api) — request examples for chat, streaming, tools, images, and audio.
- [Embeddings](../README.md#embeddings) — embedding-model routing and custom endpoints.
- [Anthropic and Claude clients](../README.md#anthropic--claude-clients) — Messages API compatibility.

## Develop and contribute

- [Contributor guide](../CONTRIBUTING.md) — development loop, testing expectations, and contribution policy.
- [How the router works](../README.md#how-it-works) — architecture and fallback behavior.
- [Database migration guide](../server/src/db/README.md) — migration CLI and conventions.

## Website assets in this directory

- [`index.html`](index.html) — project landing page.
- [`install.sh`](install.sh) — Unix Docker bootstrap script.
- [`install.ps1`](install.ps1) — PowerShell bootstrap script.
- [`success.html`](success.html) — post-install success page.
