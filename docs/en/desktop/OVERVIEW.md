**English** · [简体中文](../../zh-cn/desktop/OVERVIEW.md)

# Desktop Domain — Overview & File Index

## Scope

This domain documents the FreeLLMAPI desktop app — a lean Electron menu-bar utility (`desktop/`) that bundles the entire router and dashboard into a single local process. The app has no attached `stdout` when launched from Finder/Explorer, so operational lines (including the one-time password-reset code) would otherwise be lost; it pins the server to a scanned loopback port, mints a hidden machine user (`desktop@localhost`) for the dashboard, and exposes tray, popover, and update plumbing that do not exist in the Docker or plain-Node flows.

Authoritative sources: [`desktop/package.json`](../../../desktop/package.json) (version `0.9.2`, `electron@38.8.6`, `better-sqlite3@12.10.0`, scripts), [`desktop/electron-builder.yml`](../../../desktop/electron-builder.yml) (AppId `com.freellmapi.desktop`, publish provider `github:tashfeenahmed/freellmapi`, `asar` + `client-dist` extraResources, per-OS signing targets), [`desktop/src/logger.ts`](../../../desktop/src/logger.ts) (file tee at `<userData>/logs/freeapi.log`, 1 MB rotation, synchronous never-crash wrapper), [`desktop/src/server-host.ts`](../../../desktop/src/server-host.ts) (only module allowed to import `server/src/*`, `startServer`/`ensureSessionToken`/`listenWithScan`, boot parity with `server/src/index.ts` cross-checked by `__tests__/server-host-boot.test.ts`), [`desktop/src/main.ts`](../../../desktop/src/main.ts) (single-instance lock, `userData` override, `installFileLogger` ordering, theme/locale mirroring, LAN toggle, `FREEAPI_SHOT`), [`desktop/src/config.ts`](../../../desktop/src/config.ts), [`desktop/src/tray.ts`](../../../desktop/src/tray.ts), [`desktop/src/window.ts`](../../../desktop/src/window.ts), [`desktop/src/popover.ts`](../../../desktop/src/popover.ts), [`desktop/scripts/bundle-server.mjs`](../../../desktop/scripts/bundle-server.mjs) (esbuild `define` for `FREELLMAPI_COMMIT_SHA` + `FREELLMAPI_INSTALL_METHOD`), and [`desktop/scripts/refresh-mac-update-metadata.mjs`](../../../desktop/scripts/refresh-mac-update-metadata.mjs) (DMG re-stamp after stapling).

For installation from the user's point of view — quick start, Docker vs local dev vs desktop, data locations, and FAQ — see [Install & deploy](../install/01-install.md). For the image/Compose path, see [deployment/](../deployment/OVERVIEW.md). For the dashboard log viewer that the desktop embedder feeds, see [logs/](../logs/OVERVIEW.md) and the internals note in [architecture/06-observability.md](../architecture/06-observability.md).

## File Index

| File | Description |
| --- | --- |
| [01-desktop-app.md](01-desktop-app.md) | The Electron app shape: package manifest, build pipeline (`bundle:server` → `build:main`/`build:preload` → `stage:client` → `electron-builder`), runtime layout (`<userData>/freeapi.db`, `config.json`, `client-dist` in `extraResources`), embedded `server-host` boot sequence and its parity guard, main-process wiring (single instance, `userData` override, theme/locale, tray/popover/dashboard, LAN toggle, `FREEAPI_SHOT` capture), window chrome, and per-OS packaging/signing targets. |
| [02-logging-and-updates.md](02-logging-and-updates.md) | File logging and update delivery: why `freeapi.log` exists (#824 password-reset story), `logger.ts` `FileSink` + rotation + `installFileLogger`/`openLogsFolder`/`openBackupsFolder`, ordering under the redaction tap (the only dashboard-logs feed on desktop, #993), tray discoverability, and the update surface (`electron-builder` `publish` + `latest.yml`, `FREELLMAPI_COMMIT_SHA` `define` mirrored into `process.env`, `FREEAPI_VERSION` from `app.getVersion()`, in-dashboard checker #635/#703, macOS signing/notarization #373/#1035, DMG re-stamping after ticket stapling, and why unsigned builds cannot auto-update via `Squirrel.Mac`). |
| [CHANGELOG.md](CHANGELOG.md) | Doc revision history for this domain, seeded from desktop-relevant commits. |

## Quick facts

| Aspect | Value |
| --- | --- |
| Package | `freellmapi-desktop` `0.9.2` at [`desktop/package.json`](../../../desktop/package.json) |
| Entry | `build/main.mjs` (`type: module`, Electron `38.8.6`) |
| DB + config | `<userData>/freeapi.db` + `<userData>/config.json` (`~/Library/Application Support/FreeLLMAPI` on macOS, `%APPDATA%/FreeLLMAPI` on Windows) |
| Log file | `<userData>/logs/freeapi.log` (1 MB, rotated to `freeapi.log.1`, sync tee — [`desktop/src/logger.ts`](../../../desktop/src/logger.ts)) |
| Backups | `<userData>/backups` (tray → Open Backups Folder; server writes via `services/backups.ts`) |
| Default port | `31415` on `127.0.0.1`; scans `+50` on conflict, persisted to `config.json`; `lanAccess` → `0.0.0.0` (relaunch required) |
| Client bundle | `Resources/client-dist` (packaged) or `client/dist` from the monorepo in dev (`FREEAPI_REPO` override) |
| Build identity | `bundle-server.mjs` `define: { 'process.env.FREELLMAPI_COMMIT_SHA', 'process.env.FREELLMAPI_INSTALL_METHOD' }` stamped from `GITHUB_SHA` (40-hex), mirrored into live `process.env` in `server-host.ts` so `routes/update.ts` resolves correctly |
| Packaged targets | mac `dmg` `arm64` (signed, notarized, stapled), win `nsis` + `zip` `x64`, linux `AppImage`+`deb`+`tar.xz`+`rpm` `x64` (+ `rpm` since #981 `d8fae97`) |

## Related

- [Desktop README](../../../desktop/README.md) — prerequisites, `npm run desktop:dist`/`desktop:dev`, native rebuild note.
- [Install & deploy](../install/01-install.md) — desktop column next to Docker/local-dev, data-location table, uninstall/FAQ.
- [Deployment](../deployment/OVERVIEW.md) — Docker image/Compose operations (the other install shape).
- [Logs viewer](../logs/01-server-logs-viewer.md) and [Observability](../architecture/06-observability.md) — the polling API and store internals that the desktop log tap feeds.
- [Providers](../providers/OVERVIEW.md) — what the embedded router actually proxies once running.

## Navigation

- ← [Documentation root](../README.md)
- ↑ [Docs index](../OVERVIEW.md)
