**English** · [简体中文](../../zh-cn/install/OVERVIEW.md)

# Install guides overview

## Scope

This domain covers all installation paths for FreeLLMAPI — standard and platform-specific.

Start with [Install & deploy](01-install.md) for the standard paths: the one-liner Docker quick start, Docker Compose, local development, declarative startup config, the Docker image, and the desktop app. The guides below cover unusual platforms or form factors.

## Guides

| File | Description |
| --- | --- |
| [01-install.md](01-install.md) | Install & deploy: one-liner quick start, Docker Compose, local development, declarative startup config, the Docker image, desktop app, and data locations. |
| [02-android-termux.md](02-android-termux.md) | Experimental Android installation under Termux: runs locally on the device using Node's built-in SQLite driver instead of `better-sqlite3` (no NDK toolchain). Covers requirements (Android 7+, Node 22.13+), install and LAN access, keeping the process awake with a wake lock, troubleshooting, and updating. |
