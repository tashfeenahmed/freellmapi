[English](../../en/desktop/01-desktop-app.md) · **简体中文**

# 桌面应用

## 包清单

`desktop/package.json` `freellmapi-desktop@0.9.2` —— Electron `38.8.6`、`better-sqlite3@12.10.0`、`electron-builder@25.1.8`、`esbuild@0.24.0`。入口 `build/main.mjs`（`type: module`）。AppId `com.freellmapi.desktop`，发布 `github:tashfeenahmed/freellmapi`（`desktop/electron-builder.yml`）。`asar` + `client-dist` 位于 `extraResources`；按系统划分的签名目标（mac `dmg` `arm64` 经 `refresh-mac-update-metadata.mjs` 签名/公证/钉装、win `nsis`+`zip` `x64`、linux `AppImage`+`deb`+`tar.xz`+`rpm` `x64` 自 #981 `d8fae97` 起）。

## 构建流水线

```
bundle:server → build:main / build:preload → stage:client → electron-builder
```

- `scripts/bundle-server.mjs` esbuild `define: { 'process.env.FREELLMAPI_COMMIT_SHA', 'process.env.FREELLMAPI_INSTALL_METHOD' }` 取自 `GITHUB_SHA`（40 位十六进制）；在 `server-host.ts` 中镜像进运行时的 `process.env`，以便 `routes/update.ts` 正确解析。
- `build/main.mjs` 打包 `src/main.ts`（`--platform=node --format=esm --external:electron --external:./server.mjs`），`build/preload` 对应 `preload.ts`/`preload-popover.ts`。
- `scripts/stage-client.mjs` 将 `client/dist` 复制到 `build/client-dist` 或已打包应用中的 `Resources/client-dist`；开发环境经 `FREEAPI_REPO` 覆盖。

## 运行时布局

| 路径 | 说明 |
| --- | --- |
| `<userData>/freeapi.db` | SQLite 数据库（`freeapi.db` + WAL/`-shm`），与 Docker/Node 同一 schema |
| `<userData>/config.json` | 端口（默认 `31415`）、`lanAccess`、主题/语言 |
| `<userData>/logs/freeapi.log` | 1 MB + `freeapi.log.1` 轮转（`desktop/src/logger.ts`） |
| `<userData>/backups` | 服务端转储（`services/backups.ts` `dataDir()`） |
| `Resources/client-dist` | 已打包客户端；开发环境：经 `FREEAPI_REPO` 的 `client/dist` |

`~/Library/Application Support/FreeLLMAPI`（macOS）、`%APPDATA%/FreeLLMAPI`（Windows）、`~/.config/FreeLLMAPI`（Linux）。

## 内嵌 server-host

`desktop/src/server-host.ts` 是**唯一**允许引入 `server/src/*` 的模块（`desktop/README.md`）。它经 `bundle-server.mjs` 打包服务端，并重新导出 DB 单例（`getDb`、`getUnifiedApiKey`）以避免主包中出现第二份拷贝。

启动序列与 `server/src/index.ts` 逐步骤镜像（#949）；`__tests__/server-host-boot.test.ts` 交叉校验该列表，使 `index.ts` 新增的步骤不会在桌面端静默遗漏（`startBackupScheduler` 曾被遗漏）：

`installLogRedaction` → `installProcessSafetyNet` → `initDb` → `ensureSessionToken` → `restoreProxySettings`/`flushProxyCache` → `startHealthChecker`/`checkAllKeys` → `startCatalogSync` → `startCooldownProbe` → `startCustomModelSync` → `startBackupScheduler` → `cleanupExpiredCooldowns` → `startWakeDetect` → `createApp` → `listenWithScan`（端口 `31415`，冲突时扫描 `+50`，持久化到 `config.json`）。

刻意**未**镜像：`restoreDbBackupIfNeeded`/`startDbBackupPump`（`FREEAPI_DB_BACKUP_*` 仅环境变量， 已打包应用不继承 shell 环境）。

`listenWithScan` 默认绑定 `127.0.0.1`；`lanAccess` → `0.0.0.0`（需重启）。

## 主进程连线（`desktop/src/main.ts`）

- 单实例锁（`app.requestSingleInstanceLock`）；二次启动聚焦已有窗口。
- 来自 `FREEAPI_REPO` 开发路径的 `userData` 覆盖。
- `installFileLogger` 顺序 —— 必须在服务器将要发出的任何 `console.log` 之前运行。
- 来自系统的主题/语言镜像。
- `FREEAPI_SHOT` 截图捕获模式。

## 托盘 / 悬浮窗 / 窗口

- `desktop/src/tray.ts` —— 菜单栏图标、`打开日志文件夹` / `打开备份文件夹`（`logger.ts:openLogsFolder`/`openBackupsFolder` 经 `shell.openPath`）、`打开 FreeLLMAPI`、退出。
- `desktop/src/popover.ts` —— 用于快捷访问的悬浮窗。
- `desktop/src/window.ts` —— 主 BrowserWindow 外观。

## 相关

- [日志与更新](02-logging-and-updates.md) —— `freeapi.log` 轮转、更新分发、签名。
- [安装与部署](../install/01-install.md) —— 桌面端 vs Docker vs 本地开发。
- [日志查看器](../logs/01-server-logs-viewer.md) —— 桌面日志抽头所供给的轮询 API。
