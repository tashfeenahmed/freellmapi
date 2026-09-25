[English](../../en/desktop/OVERVIEW.md) · **简体中文**

# 桌面应用域 —— 概览与文件索引

## 范围

本域文档记录 FreeLLMAPI 桌面应用 —— 一个精简的 Electron 菜单栏工具（`desktop/`），它把整个路由器与仪表盘打包进单一本地进程。该应用从 Finder/Explorer 启动时没有附带的 `stdout`，因此操作输出（包括一次性密码重置码）原本会丢失；它把服务器钉在扫描到的环回端口、为仪表盘铸造隐藏的机器用户（`desktop@localhost`），并暴露托盘、悬浮窗与更新管道——这些在 Docker 或纯 Node 流程中并不存在。

权威来源：[`desktop/package.json`](../../../desktop/package.json)（版本 `0.9.2`、`electron@38.8.6`、`better-sqlite3@12.10.0`、scripts）、[`desktop/electron-builder.yml`](../../../desktop/electron-builder.yml)（AppId `com.freellmapi.desktop`、发布方 `github:tashfeenahmed/freellmapi`、`asar` + `client-dist` extraResources、按系统划分的签名目标）、[`desktop/src/logger.ts`](../../../desktop/src/logger.ts)（在 `<userData>/logs/freeapi.log` 的文件分流，1 MB 轮转、同步永不崩溃包装）、[`desktop/src/server-host.ts`](../../../desktop/src/server-host.ts)（唯一允许引入 `server/src/*` 的模块，`startServer`/`ensureSessionToken`/`listenWithScan`，启动一致性与 `server/src/index.ts` 经 `__tests__/server-host-boot.test.ts` 交叉校验）、[`desktop/src/main.ts`](../../../desktop/src/main.ts)（单实例锁、`userData` 覆盖、`installFileLogger` 顺序、主题/语言镜像、局域网开关、`FREEAPI_SHOT`）、[`desktop/src/config.ts`](../../../desktop/src/config.ts)、[`desktop/src/tray.ts`](../../../desktop/src/tray.ts)、[`desktop/src/window.ts`](../../../desktop/src/window.ts)、[`desktop/src/popover.ts`](../../../desktop/src/popover.ts)、[`desktop/scripts/bundle-server.mjs`](../../../desktop/scripts/bundle-server.mjs)（为 `FREELLMAPI_COMMIT_SHA` + `FREELLMAPI_INSTALL_METHOD` 的 esbuild `define`）、以及 [`desktop/scripts/refresh-mac-update-metadata.mjs`](../../../desktop/scripts/refresh-mac-update-metadata.mjs)（票据钉装后对 DMG 的重新戳记）。

从用户视角的安装 —— 快速开始、Docker vs 本地开发 vs 桌面端、数据位置与 FAQ —— 见[安装与部署](../install/01-install.md)。镜像/Compose 路径见 [deployment/](../deployment/OVERVIEW.md)。关于桌面嵌入器所供给的仪表盘日志查看器，见 [logs/](../logs/OVERVIEW.md) 及 [architecture/06-observability.md](../architecture/06-observability.md) 中的内部说明。

## 文件索引

| 文件 | 说明 |
| --- | --- |
| [01-desktop-app.md](01-desktop-app.md) | Electron 应用形态：包清单、构建流水线（`bundle:server` → `build:main`/`build:preload` → `stage:client` → `electron-builder`）、运行时布局（`<userData>/freeapi.db`、`config.json`、`client-dist` 位于 `extraResources`）、内嵌 `server-host` 启动序列及其一致性守卫、主进程连线（单实例、`userData` 覆盖、主题/语言、托盘/悬浮窗/仪表盘、局域网开关、`FREEAPI_SHOT` 截图）、窗口外观以及按系统划分的打包/签名目标。 |
| [02-logging-and-updates.md](02-logging-and-updates.md) | 文件日志与更新分发：`freeapi.log` 为何存在（#824 密码重置故事）、`logger.ts` `FileSink` + 轮转 + `installFileLogger`/`openLogsFolder`/`openBackupsFolder`、在脱敏抽头之下的顺序（桌面端唯一的仪表盘日志供给，#993）、托盘可发现性，以及更新面（`electron-builder` `publish` + `latest.yml`、`FREELLMAPI_COMMIT_SHA` `define` 镜像进 `process.env`、`FREEAPI_VERSION` 取自 `app.getVersion()`、仪表盘内检查器 #635/#703、macOS 签名/公证 #373/#1035、票据钉装后 DMG 重戳，以及为何未签名构建无法经 `Squirrel.Mac` 自动更新）。 |
| [CHANGELOG.md](CHANGELOG.md) | 本域文档修订历史，播种自与桌面相关的提交。 |

## 速览

| 方面 | 取值 |
| --- | --- |
| 包 | `freellmapi-desktop` `0.9.2` 位于 [`desktop/package.json`](../../../desktop/package.json) |
| 入口 | `build/main.mjs`（`type: module`，Electron `38.8.6`） |
| 数据库 + 配置 | `<userData>/freeapi.db` + `<userData>/config.json`（macOS 上为 `~/Library/Application Support/FreeLLMAPI`，Windows 上为 `%APPDATA%/FreeLLMAPI`） |
| 日志文件 | `<userData>/logs/freeapi.log`（1 MB，轮转至 `freeapi.log.1`，同步分流 —— [`desktop/src/logger.ts`](../../../desktop/src/logger.ts)） |
| 备份 | `<userData>/backups`（托盘 → 打开备份文件夹；服务端经 `services/backups.ts` 写入） |
| 默认端口 | `31415` 于 `127.0.0.1`；冲突时扫描 `+50`，持久化到 `config.json`；`lanAccess` → `0.0.0.0`（需重启） |
| 客户端包 | `Resources/client-dist`（已打包）或开发环境中来自 monorepo 的 `client/dist`（`FREEAPI_REPO` 覆盖） |
| 构建标识 | `bundle-server.mjs` `define: { 'process.env.FREELLMAPI_COMMIT_SHA', 'process.env.FREELLMAPI_INSTALL_METHOD' }` 由 `GITHUB_SHA`（40 位十六进制）戳记，并在 `server-host.ts` 中镜像进运行时的 `process.env`，以便 `routes/update.ts` 正确解析 |
| 打包目标 | mac `dmg` `arm64`（已签名、已公证、已钉装）、win `nsis` + `zip` `x64`、linux `AppImage`+`deb`+`tar.xz`+`rpm` `x64`（`rpm` 自 #981 `d8fae97` 起） |

## 相关

- [桌面端 README](../../../desktop/README.md) —— 前置条件、`npm run desktop:dist`/`desktop:dev`、原生重建说明。
- [安装与部署](../install/01-install.md) —— 桌面端与 Docker/本地开发并列、数据位置表、卸载/FAQ。
- [部署](../deployment/OVERVIEW.md) —— Docker 镜像/Compose 运维（另一种安装形态）。
- [日志查看器](../logs/01-server-logs-viewer.md) 与 [可观测性](../architecture/06-observability.md) —— 桌面日志抽头所供给的轮询 API 与存储内部。

## 导航

- ← [文档根目录](../README.md)
- ↑ [文档索引](../OVERVIEW.md)
