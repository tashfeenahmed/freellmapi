# Environment configuration overview

## Scope

This domain documents FreeLLMAPI's runtime configuration surface: every variable the server reads from `.env`, how provider API keys are encrypted at rest, and how outbound traffic can be steered through proxies. The single source of truth is [`.env.example`](../../.env.example) at the repository root; the references here are derived from it (and from the code paths it describes) and never invent values.

For getting an install running in the first place, see [Install & deploy](../install.md).

## File index

| File | Description |
| --- | --- |
| [01-variables.md](01-variables.md) | Full variable reference grouped by concern (server/bind, security, rate limits, routing overrides, outbound proxies, body/media limits, misc), with defaults taken verbatim from `.env.example`. |
| [02-security-and-keys.md](02-security-and-keys.md) | `ENCRYPTION_KEY` lifecycle: generation, dev auto-generated key file, AES-256-GCM at-rest encryption of stored provider keys, key-file-out-of-DB hardening, and data-directory permissions. |
| [03-outbound-proxies.md](03-outbound-proxies.md) | Outbound proxy configuration: scheme support, resolution-chain precedence (`PROXY_URL` through `HTTP_PROXY`), `NO_PROXY` bypasses, the Docker `host.docker.internal` gotcha, and the related inbound rate-limit knobs. |

## Conventions

- Variables are loaded by [`server/src/env.ts`](../../server/src/env.ts) via dotenv; `FREEAPI_ENV_PATH` selects an alternate `.env` location for embedders.
- Commented lines in `.env.example` are optional; uncommented ones ship active defaults.
- Where a variable can also be changed at runtime from the dashboard, the runtime settings key is noted and always takes precedence over the environment value.
