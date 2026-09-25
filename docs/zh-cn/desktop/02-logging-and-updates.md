[English](../../en/desktop/02-logging-and-updates.md) · **简体中文**

# 日志与更新 —— 桌面端

## 为何存在 `freeapi.log`（#824）

内嵌服务器把运行输出打印到 `console` —— 包括 `POST /api/auth/forgot-password` 打印且别处永不显示的一次性密码重置码。服务器运维者可从 `docker logs` 或终端读到它。从 Finder/Explorer 启动的 Electron 应用没有附带的 `stdout`，因此该码曾不可见，重置流程也就永远无法完成。于是 `desktop/src/logger.ts` 把 `console` 分流到 `<userData>/logs/freeapi.log`（90aaa5b）。

## `logger.ts` —— `FileSink` + 轮转

- `LOG_NAME=freeapi.log`、`PREVIOUS_NAME=freeapi.log.1`、`MAX_LOG_BYTES=1 MB`（`desktop/src/logger.ts:18-21`）。两个文件，各 1 MB —— 足够记录一次重置或异常启动，又小到不会占用磁盘。
- `createFileSink(dir, maxBytes=1M)` —— 追加到 `freeapi.log`，超过 `maxBytes` 时轮转到 `freeapi.log.1`（在**将要**跨过上限的那次写入前轮转，空文件永不轮转）。同步 `fs.writeSync`，因此应用退出前一刻打印的码已落盘。每次文件系统调用均被包装 —— 日志永不使应用崩溃。
- `installFileLogger(dir=logsDir())` —— 包装 `console.log/info/warn/error`，前缀 `ISO 时间戳 [level]`，同时转发到原始 console **与** `sink.write`。幂等（`installed` 标志）。`process.on('exit', () => sink.close())`。桌面端唯一的仪表盘日志供给就是此抽头（#993 与 `server/src/lib/server-logs.ts` 协调 —— 服务端的内存环 + 数据库持久化 `warn`/`error`）。
- `openLogsFolder()` / `openBackupsFolder()` —— `fs.mkdirSync(..., { recursive: true })` 后 `shell.openPath`；先创建目录，即使尚未写入任何内容也能正确揭示。托盘 → “打开日志文件夹” / “打开备份文件夹”。

```ts
// 顺序很重要 —— 在任何服务端 console 输出前安装
import { installFileLogger } from './logger.js';
installFileLogger(); // 在 createApp / 服务端启动之前
```

## 托盘可发现性

托盘菜单同时暴露两个文件夹；`openBackupsFolder` 解析到 `<userData>/backups`（`server/src/services/backups.ts` `dataDir()` 写入转储之处）。仪表盘的备份面板显示相对于该目录的路径。

## 更新分发

### Electron-builder 发布

`desktop/electron-builder.yml` `publish: { provider: github, owner: tashfeenahmed, repo: freellmapi }` —— 产物（`dmg`、`nsis`、`zip`、`AppImage`、`deb`、`tar.xz`、`rpm`）在 `desktop-release.yml` 上上传（`*.rpm` 通配自 d8fae97）。按渠道生成 `latest.yml` / `latest-mac.yml`。

### 构建标识

`scripts/bundle-server.mjs` `define: { 'process.env.FREELLMAPI_COMMIT_SHA': JSON.stringify(GITHUB_SHA), 'process.env.FREELLMAPI_INSTALL_METHOD': '"desktop"' }` —— 构建时戳记的 40 位十六进制 SHA，在 `server-host.ts` 中镜像进运行时的 `process.env`，以便 `server/src/routes/update.ts` 解析运行中提交 vs `GET /api/update` 可用版本。`FREEAPI_VERSION` 取自 `app.getVersion()`（`0.9.2`）。

### 仪表盘内检查器

仪表盘轮询 `GET /api/update`（检查器 #635/#703）—— 当 `latest > running` 时展示横幅及发行说明。桌面端与 Docker/Node 共享同一检查器；桌面端额外经 Squirrel 提供自动更新。

### macOS 签名 / 公证

经 `electron-builder` 签名 + 公证（#373/#1035）：`CSC_*`、`APPLE_ID` 密钥位于 `desktop-release.yml`。票据钉装后经 `scripts/refresh-mac-update-metadata.mjs` 对 DMG 重戳（`latest-mac.yml` 的 `sha512` 必须匹配已钉装的 DMG，而非钉装前）。

### 为何未签名构建无法自动更新

`Squirrel.Mac` 在应用更新前校验代码签名。未签名的 `dmg`（无证书的本地 `npm run dist`）能产生有效应用，却没有有效更新源 —— 自动更新器会拉取 `latest-mac.yml` 随后拒绝应用。需手动下载。

## 相关

- [桌面应用](01-desktop-app.md) —— 包清单、构建流水线、运行时布局。
- [日志查看器](../logs/01-server-logs-viewer.md) —— 桌面抽头所供给的轮询 API。
- [可观测性](../architecture/06-observability.md) —— 服务端存储内部（环 + 数据库）。
