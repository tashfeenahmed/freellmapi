# Install guides overview

## Scope

Platform-specific installation guides that do not fit the main [Install & deploy](../install.md) page. These cover running FreeLLMAPI on unusual platforms or form factors, with platform-specific requirements, steps, and troubleshooting.

Start with [install.md](../install.md) for the standard paths: the one-liner Docker quick start, Docker Compose, local development, and the desktop app.

## Guides

| File | Description |
| --- | --- |
| [android-termux.md](android-termux.md) | Experimental Android installation under Termux: runs locally on the device using Node's built-in SQLite driver instead of `better-sqlite3` (no NDK toolchain). Covers requirements (Android 7+, Node 22.13+), install and LAN access, keeping the process awake with a wake lock, troubleshooting, and updating. |
