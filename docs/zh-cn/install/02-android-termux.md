[English](../../en/install/02-android-termux.md) · **简体中文**

# Android（Termux）安装

> 实验性功能，由社区维护。FreeLLMAPI 直接运行在 Android 设备本地。

FreeLLMAPI 可以在 [Termux](https://termux.dev/) 中运行，无需 Android NDK 工具链。在 Android 上，服务器使用 Node 内置的 SQLite 驱动，而不是原生的 `better-sqlite3` 包。

## 要求

- Android 7 或更新版本
- 约 1 GB 可用存储空间
- [F-Droid 上的 Termux](https://f-droid.org/packages/com.termux/)（Play 商店的版本已过时）
- Node.js 22.13 或更新版本；推荐 Node 24 LTS

不要混用来自不同商店的 Termux 或其附加包。

## 安装

更新 Termux 并安装所需的包：

```bash
pkg update
pkg upgrade -y
pkg install -y nodejs-lts git
```

确认 Node 的版本足够新，能提供 `node:sqlite`：

```bash
node --version
```

然后克隆并启动 FreeLLMAPI：

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install --no-audit --no-fund
npm run dev
```

安装时关于可选包 `better-sqlite3` 的警告在 Android 上无害。如果 npm 要求批准依赖的安装脚本，批准 `esbuild` 的脚本后再运行一次 `npm install`。

在手机浏览器中打开 `http://localhost:5173`。API 位于 `http://localhost:3001/v1`。

## 从其他设备访问

仪表盘包含 API 密钥和管理控制项，只在可信网络中暴露它。

```bash
HOST=0.0.0.0 npm run dev:lan
```

在 Android 的 Wi-Fi 设置中查看手机的局域网地址，或运行：

```bash
ip addr show wlan0
```

在同一网络的另一台设备上打开 `http://PHONE_IP:5173`。不要把这些开发服务器直接端口转发到公网；需要远程访问时请使用 Tailscale 之类的私有 VPN。

## 保持进程运行

屏幕关闭后 Android 可能会挂起 Termux。从与 Termux 相同的商店安装 Termux:API 附加组件，然后运行：

```bash
pkg install -y termux-api
termux-wake-lock
```

停止服务器后释放唤醒锁：

```bash
termux-wake-unlock
```

## 故障排查

### `node:sqlite` 不可用

升级 Termux 的包，并确认 `node --version` 报告 22.13 或更新版本：

```bash
pkg update
pkg upgrade -y
pkg install -y nodejs-lts
```

### `concurrently: not found`

依赖安装没有完成。再运行一次 `npm install --no-audit --no-fund`，并处理它报告的第一个非可选错误。

### 端口已被占用

停止占用 3001 或 5173 端口的进程，或在仓库的 `.env` 文件中配置另一个 `PORT`。

### 屏幕关闭后进程停止

使用 `termux-wake-lock`，并在 Android 设置中为 Termux 关闭电池优化。

## 更新

先停止正在运行的开发服务器，然后运行：

```bash
git pull --ff-only
npm install --no-audit --no-fund
npm run dev
```

反馈 Android 相关问题时，请附上 Android 版本、Termux 的来源与版本、设备架构、`node --version` 的输出以及完整的错误信息。
