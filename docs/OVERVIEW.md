# Docs directory overview

## Scope

This file is the domain index for `docs/` — a complete file map of every guide and domain folder (install, API, clients, CLI, compression, architecture deep-dives, env, proxy, deployment, providers, testing, fallback, logs, desktop, troubleshooting, glossary, i18n). It lists where each document lives and how the domain folders relate.

For getting started as a user, see [en/README.md](en/README.md) (English entry point); for the product overview, see the root [README](../README.md).

## File index

| File | Description |
| --- | --- |
| [en/](en/OVERVIEW.md) | **English** — all domains (api with 00-high-level-index, cli, clients, desktop, env, fallback, glossary, install, logs, proxy, providers, testing, troubleshooting). |
| [zh-cn/](zh-cn/OVERVIEW.md) | **简体中文** — Chinese translations (mirrors `en/`, see `en/` for authoritative source; `zh-cn/` currently stubs — see `i18n/` for coverage). |
| [TRANSLATION.md](TRANSLATION.md) | Translating: rules for locale files, the validator, and the settled terminology table. |
| [index.html](index.html) | Static website asset (not a doc): redirect page to freellmapi.co. |
| [success.html](success.html) | Static website asset (not a doc): post-install success page. |
| [install.sh](install.sh) | Unix Docker bootstrap script served by the project website. |
| [install.ps1](install.ps1) | PowerShell bootstrap script served by the project website. |

> `index.html` and `success.html` are static website assets shipped with the docs directory, not markdown documentation.
