**English** · [简体中文](../../zh-cn/desktop/01-desktop-app.md)

# Desktop app

## Package manifest

`desktop/package.json` `freellmapi-desktop@0.9.2` — Electron `38.8.6`, `better-sqlite3@12.10.0`, `electron-builder@25.1.8`, `esbuild@0.24.0`. Entry `build/main.mjs` (`type: module`). AppId `com.freellmapi.desktop`, publish `github:tashfeenahmed/freellmapi` (`desktop/electron-builder.yml`). `asar` + `client-dist` in `extraResources`; per-OS signing targets (mac `dmg` `arm64` signed/notarized/stapled via `refresh-mac-update-metadata.mjs`, win `nsis`+`zip` `x64`, linux `AppImage`+`deb`+`tar.xz`+`rpm` `x64` since #981 `d8fae97`).

## Build pipeline

```
bundle:server → build:main / build:preload → stage:client → electron-builder
```

- `scripts/bundle-server.mjs` esbuild `define: { 'process.env.FREELLMAPI_COMMIT_SHA', 'process.env.FREELLMAPI_INSTALL_METHOD' }` from `GITHUB_SHA` (40-hex); mirrored into live `process.env` in `server-host.ts` so `routes/update.ts` resolves.
- `build/main.mjs` bundles `src/main.ts` (`--platform=node --format=esm --external:electron --external:./server.mjs`), `build/preload` for `preload.ts`/`preload-popover.ts`.
- `scripts/stage-client.mjs` copies `client/dist` → `build/client-dist` or `Resources/client-dist` in packaged app; dev override via `FREEAPI_REPO`.

## Runtime layout

| Path | Notes |
| --- | --- |
| `<userData>/freeapi.db` | SQLite DB (`freeapi.db` + WAL/`-shm`), same schema as Docker/Node |
| `<userData>/config.json` | Port (`31415` default), `lanAccess`, theme/locale |
| `<userData>/logs/freeapi.log` | 1 MB + `freeapi.log.1` rotation (`desktop/src/logger.ts`) |
| `<userData>/backups` | Server dumps (`services/backups.ts` `dataDir()`) |
| `Resources/client-dist` | Packaged client; dev: `client/dist` via `FREEAPI_REPO` |

`~/Library/Application Support/FreeLLMAPI` (macOS), `%APPDATA%/FreeLLMAPI` (Windows), `~/.config/FreeLLMAPI` (Linux).

## Embedded server-host

`desktop/src/server-host.ts` is the **only** module allowed to import `server/src/*` (`desktop/README.md`). It bundles the server via `bundle-server.mjs` and re-exports the DB singleton (`getDb`, `getUnifiedApiKey`) to avoid a second copy in the main bundle.

Boot sequence mirrors `server/src/index.ts` step-for-step (`#949`); `__tests__/server-host-boot.test.ts` cross-checks the list so a new step added to `index.ts` fails a desktop test instead of silently never running (how `startBackupScheduler` was missed):

`installLogRedaction` → `installProcessSafetyNet` → `initDb` → `ensureSessionToken` → `restoreProxySettings`/`flushProxyCache` → `startHealthChecker`/`checkAllKeys` → `startCatalogSync` → `startCooldownProbe` → `startCustomModelSync` → `startBackupScheduler` → `cleanupExpiredCooldowns` → `startWakeDetect` → `createApp` → `listenWithScan` (port `31415`, scan `+50` on conflict, persist to `config.json`).

Deliberately NOT mirrored: `restoreDbBackupIfNeeded`/`startDbBackupPump` (`FREEAPI_DB_BACKUP_*` env-only, packaged app inherits no shell env).

`listenWithScan` binds `127.0.0.1` by default; `lanAccess` → `0.0.0.0` (relaunch required).

## Main-process wiring (`desktop/src/main.ts`)

- Single-instance lock (`app.requestSingleInstanceLock`); second launch focuses existing window.
- `userData` override from `FREEAPI_REPO` dev path.
- `installFileLogger` ordering — must run before any `console.log` the server will emit.
- Theme/locale mirroring from system.
- `FREEAPI_SHOT` capture mode for screenshots.

## Tray / popover / window

- `desktop/src/tray.ts` — menu-bar icon, `Open Logs Folder` / `Open Backups Folder` (`logger.ts:openLogsFolder`/`openBackupsFolder` via `shell.openPath`), `Open FreeLLMAPI`, quit.
- `desktop/src/popover.ts` — popover window for quick access.
- `desktop/src/window.ts` — main BrowserWindow chrome.

## Related

- [Logging and updates](02-logging-and-updates.md) — `freeapi.log` rotation, update delivery, signing.
- [Install & deploy](../install/01-install.md) — desktop vs Docker vs local dev.
- [Logs viewer](../logs/01-server-logs-viewer.md) — the polling API the desktop log tap feeds.
