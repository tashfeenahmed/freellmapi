# Logging and updates — desktop

## Why `freeapi.log` exists (#824)

The embedded server prints operational output to `console` — including the one-time password-reset code that `POST /api/auth/forgot-password` prints and nothing else ever shows. A server operator reads it from `docker logs` or the terminal. A Finder/Explorer-launched Electron app has no attached `stdout`, so that code was unreadable and the reset flow could never complete. Hence `desktop/src/logger.ts` tees `console` into `<userData>/logs/freeapi.log` (90aaa5b).

## `logger.ts` — `FileSink` + rotation

- `LOG_NAME=freeapi.log`, `PREVIOUS_NAME=freeapi.log.1`, `MAX_LOG_BYTES=1 MB` (`desktop/src/logger.ts:18-21`). Two files, 1 MB each — enough history for a reset or bad boot, small enough nobody's disk notices.
- `createFileSink(dir, maxBytes=1M)` — appends to `freeapi.log`, rotates to `freeapi.log.1` once it passes `maxBytes` (rotate *before* the write that would cross the limit, never on empty file). Synchronous `fs.writeSync` so a code printed a moment before the app quits is already on disk. Every filesystem call wrapped — logging never crashes the app.
- `installFileLogger(dir=logsDir())` — wraps `console.log/info/warn/error`, prefixes `ISO timestamp [level]`, forwards to original console *and* `sink.write`. Idempotent (`installed` flag). `process.on('exit', () => sink.close())`. The only dashboard-logs feed on desktop is this tap (#993 coordination with `server/src/lib/server-logs.ts` — the server's in-memory ring + DB persisted `warn`/`error`).
- `openLogsFolder()` / `openBackupsFolder()` — `fs.mkdirSync(..., { recursive: true })` then `shell.openPath`; create dir first so reveal works even before anything written. Tray → “Open Logs Folder” / “Open Backups Folder”.

```ts
// Ordering matters — install before any server console output
import { installFileLogger } from './logger.js';
installFileLogger(); // before createApp / server boot
```

## Tray discoverability

The tray menu exposes both folders; `openBackupsFolder` resolves to `<userData>/backups` (where `server/src/services/backups.ts` `dataDir()` writes dumps). The dashboard's Backups panel shows paths relative to that directory.

## Update delivery

### Electron-builder publish

`desktop/electron-builder.yml` `publish: { provider: github, owner: tashfeenahmed, repo: freellmapi }` — artifacts (`dmg`, `nsis`, `zip`, `AppImage`, `deb`, `tar.xz`, `rpm`) upload on `desktop-release.yml` (`*.rpm` glob since d8fae97). `latest.yml` / `latest-mac.yml` generated per channel.

### Build identity

`scripts/bundle-server.mjs` `define: { 'process.env.FREELLMAPI_COMMIT_SHA': JSON.stringify(GITHUB_SHA), 'process.env.FREELLMAPI_INSTALL_METHOD': '"desktop"' }` — 40-hex SHA stamped at build, mirrored into live `process.env` in `server-host.ts` so `server/src/routes/update.ts` resolves the running commit vs `GET /api/update` available. `FREEAPI_VERSION` from `app.getVersion()` (`0.9.2`).

### In-dashboard checker

The dashboard polls `GET /api/update` (checker #635/#703) — shows banner when `latest > running`, with release notes. Desktop and Docker/Node share the same checker; desktop additionally offers auto-update via Squirrel.

### macOS signing / notarization

Signed + notarized via `electron-builder` (`#373`/`#1035`): `CSC_*`, `APPLE_ID` secrets in `desktop-release.yml`. DMG re-stamp after ticket stapling via `scripts/refresh-mac-update-metadata.mjs` (the `latest-mac.yml` `sha512` must match the stapled DMG, not the pre-staple one). Linux `rpm` beside `deb` since `d8fae97`.

### Why unsigned builds cannot auto-update

`Squirrel.Mac` verifies the code signature before applying an update. An unsigned `dmg` (local `npm run dist` without certs) produces a valid app but no valid update feed — the auto-updater will fetch `latest-mac.yml` then refuse to apply. Manual download is required.

## Related

- [Desktop app](01-desktop-app.md) — package manifest, build pipeline, runtime layout.
- [Logs viewer](../logs/01-server-logs-viewer.md) — the polling API the desktop tap feeds.
- [Observability](../architecture/06-observability.md) — server store internals (ring + DB).
