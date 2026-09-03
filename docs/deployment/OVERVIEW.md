# Deployment overview

## Scope

Operating FreeLLMAPI in Docker: the published image, Compose quickstart, persistence, healthchecks, the container-networking gotchas, and the ongoing maintenance work — upgrading, backups, and declarative configuration. Content is derived from [`Dockerfile`](../../Dockerfile), [`docker-compose.yml`](../../docker-compose.yml), [`.dockerignore`](../../.dockerignore), and [`docs/install.md`](../install.md).

For installation paths beyond Docker (one-liner script, local development, desktop app), see [Install & deploy](../install.md).

## File index

| File | Description |
| --- | --- |
| [01-docker.md](01-docker.md) | The image (multi-stage build on `node:20-bookworm-slim`), Compose quickstart, ports and LAN access, volumes and persistence, healthcheck, non-root runtime, native `better-sqlite3` compile rationale, and why a container cannot reach providers the host can (#733). |
| [02-updates-and-backup.md](02-updates-and-backup.md) | Upgrade flow (`docker compose pull && docker compose up -d`), the dashboard update checker (#635/#703), backing up the SQLite data volume, and declarative config/catalog controls (#f4cd7b4). |

## Quick facts

| Aspect | Value |
| --- | --- |
| Image | `ghcr.io/tashfeenahmed/freellmapi:latest` |
| Port | 3001 (published on `127.0.0.1` by default; `HOST_BIND=0.0.0.0` opens it to the LAN) |
| Data volume | Named volume `freellmapi-data`, mounted at `/app/server/data` |
| Runtime user | `node` (non-root) |
| Healthcheck | `GET /api/ping` every 30s via an in-container Node fetch |
