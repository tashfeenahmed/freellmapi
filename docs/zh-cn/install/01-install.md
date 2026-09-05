[English](../../en/install/01-install.md) · **简体中文**

# 安装与部署

[← 返回 README](../README.md) · [文档索引](../README.md)

把 FreeLLMAPI 跑起来所需的一切：一行命令、Docker Compose、本地开发、声明式配置、生产构建、桌面应用，以及你的数据存放在哪里。

- [快速开始](#快速开始)
- [Docker Compose](#docker-compose)
- [本地开发](#本地开发)
- [声明式启动配置](#声明式启动配置)
- [Docker 镜像与运维](#docker-镜像与运维)
- [桌面应用](#桌面应用)
- [凭据与数据存放位置](#凭据与数据存放位置)

## 快速开始

需要 Docker。它会建好 `~/freellmapi`、生成加密密钥、拉取镜像并启动容器：

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

不放心直接管道给 bash？[脚本在这里](https://freellmapi.co/install.sh)。重复执行是安全的：你的 `.env`（以及加密密钥）会被保留，容器会更新到 `:latest`。可以用 `FREELLMAPI_DIR`、`PORT` 或 `HOST_BIND` 环境变量覆盖默认值。

在 Windows 上，最省事的方式是桌面版 **[Releases 里的 `.exe` 安装包](https://github.com/tashfeenahmed/freellmapi/releases/latest)**（见[下文](#桌面应用)）；上面的 Docker 步骤在 WSL 或任意 bash shell 里同样可用。

在 Android 上，参见实验性的 [Termux 安装指南](02-android-termux.md)。它使用 Node 内置的 SQLite 驱动，不需要 Android NDK。

打开 http://localhost:3001 ，在 **密钥** 页添加你的提供方密钥，按喜好调整 **回退链** 的顺序，然后在 **密钥** 页顶部拿到你的统一 API 密钥。这个统一密钥就是你的 OpenAI SDK 要指向的东西。

你的部署会自行从签名的目录源保持更新。当前的完整目录列在 [freellmapi.co/models](https://freellmapi.co/models.html)。

## Docker Compose

在 3001 端口上同时跑起 API 和仪表盘，并把 SQLite 持久化到一个具名卷里。

**前置条件：** Docker、Docker Compose、OpenSSL。

*在 macOS / Linux 上（Bash）：*
```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

# 生成用于静态存储密钥的加密密钥
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d
```

*在 Windows 上（PowerShell）：*
```powershell
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

$Bytes = New-Object Byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($Bytes)
$ENCRYPTION_KEY = -join ($Bytes | ForEach-Object { "{0:x2}" -f $_ })
"ENCRYPTION_KEY=$ENCRYPTION_KEY`nPORT=3001" | Out-File -Encoding utf8 .env
docker compose up -d
```

> **想从另一台机器访问？** 默认情况下容器只发布在 `127.0.0.1` 上，所以从别的设备打开 `http://<服务器 IP>:3001` 是加载不出来的（页面会一直卡住）。想把它暴露到局域网，比如让树莓派在 `http://192.168.1.x:3001` 上可访问，就用 `HOST_BIND=0.0.0.0` 启动：
>
> ```bash
> HOST_BIND=0.0.0.0 docker compose up -d
> ```
>
> 只在你信任的网络里这么做：这个代理是单用户的，唯一的防护就是那把统一 API 密钥。

> **宿主机连得上提供方，容器里却连不上？** 容器有自己独立的网络栈，所以有两件在你机器上成立的事，到了容器里并不成立：
>
> - **`127.0.0.1` 在容器里指的是容器自己，不是你的机器。** 如果你是通过宿主机上的代理客户端（Clash、v2rayN、sing-box，或公司代理）访问提供方，请把 FreeLLMAPI 指向宿主机：`PROXY_URL=socks5h://host.docker.internal:7890`。仓库自带的 `docker-compose.yml` 已经把 `host.docker.internal` 映射到宿主网关，所以在 Linux 上的原生 Docker 里同样可用，不只是 Docker Desktop。另外代理本身也要允许来自 loopback 以外的连接（Clash 里是 `allow-lan: true`）。
> - **纯 IPv6 的宿主机需要在 Docker 里开启 IPv6。** 默认的 bridge 网络只有 IPv4，所以在没有 IPv4 出口的宿主机上，容器什么都连不上，连 DNS 也一样。在 `/etc/docker/daemon.json` 里加上 `"ipv6": true`、`"ip6tables": true` 和一个 `"fixed-cidr-v6"` 网段，然后重启 Docker。
>
> 想知道自己属于哪一种，直接问容器：
>
> ```bash
> docker compose exec freellmapi node -e "fetch('https://generativelanguage.googleapis.com/').then(r=>console.log('ok',r.status)).catch(e=>console.log('fail',e.cause?.code||e.message))"
> ```

## 本地开发

**前置条件：** Node.js 20+、npm。

*在 macOS / Linux 上（Bash）：*
```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
npm run dev
```

*在 Windows 上（PowerShell）：*
```powershell
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
$ENCRYPTION_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
"ENCRYPTION_KEY=$ENCRYPTION_KEY`nPORT=3001" | Out-File -Encoding utf8 .env
npm run dev
```

启动必须要有 `ENCRYPTION_KEY`。当 `NODE_ENV` 不是 `production` 且没有设置它时，服务会自动生成一个开发用的密钥，并保存到 SQLite 数据库旁边的 `.encryption-key` 文件（权限 0600）里，而不是存进数据库。以前把密钥存在数据库里的旧安装，会在首次启动时迁移到这个文件。不要在放着真实提供方密钥的环境里依赖这个兜底行为，请显式设置 `ENCRYPTION_KEY`。

### 轮换加密密钥

存储的密文用的是 AES-256-GCM，所以直接改 `ENCRYPTION_KEY` 不会重新加密任何东西——它只会让所有提供方密钥、按密钥的代理覆盖、客户端配置档凭据以及已保存的 Fetch Relay 令牌同时解不开。请先停掉服务，把它们重新加密：

```bash
# 1. 生成新密钥
NEW_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"

# 2. 预演（只读，不写入任何内容）
cd server
ENCRYPTION_KEY=<旧密钥> npm run rotate-encryption-key -- \
  --new-key "$NEW_KEY" --dry-run

# 3. 正式轮换
ENCRYPTION_KEY=<旧密钥> npm run rotate-encryption-key -- --new-key "$NEW_KEY"
```

`--old-key <hex>` 可以覆盖从 `ENCRYPTION_KEY` 读到的密钥，`--db <path>` 用来指向 `server/data` 以外的数据库。只有当每一个值都能解密时才会写入，所以旧密钥填错会以非零状态退出，数据库保持原样。

之后把新密钥写进 `.env`（`ENCRYPTION_KEY=$NEW_KEY`）并重启。使用 Docker 时，在容器内对挂载的数据库执行这条命令，然后用更新后的 `.env` 重启容器。轮换前请先备份数据库文件。

请求分析数据默认保留 90 天或 100000 条请求记录，以先触发的那个上限为准。在 `.env` 里设置 `REQUEST_ANALYTICS_RETENTION_DAYS=0` 或 `REQUEST_ANALYTICS_MAX_ROWS=0` 可以分别关掉对应的保留上限。

打开 http://localhost:5173 （Vite 开发界面），在 **密钥** 页添加你的提供方密钥，按喜好调整 **回退链** 的顺序，然后在 **密钥** 页顶部拿到你的统一 API 密钥。这个统一密钥就是你的 OpenAI SDK 要指向的东西。

> **想从局域网里的另一台设备访问开发界面？** 用 `npm run dev:lan`。它会把 `--host` 透传给 Vite，Vite 随后会打印一个 `Network: http://<你的 IP>:5173` 的地址，你可以在手机或另一台机器上打开。（直接写 `npm run dev -- --host` 在这里*不*管用：根目录的 `dev` 脚本是一个 `concurrently` 包装器，这个参数根本传不到 Vite。）API 调用走 Vite 的开发代理，所以不需要额外的服务端配置。

不用 Docker 的生产构建：

```bash
npm run build
node server/dist/index.js     # 服务和仪表盘都在 :3001 上提供
```

## 声明式启动配置

为了让 Docker 或服务器安装可以重复复现，FreeLLMAPI 支持在每次启动时应用一份 JSON 配置。设置 `FREEAPI_CONFIG_PATH=/path/to/freellmapi.config.json`，或者把同样的 JSON 放进 `FREEAPI_CONFIG_JSON`。这份配置是幂等的：已存在的密钥、自定义提供方、模型改动、回退链条目和路由设置会被更新，而不是重复添加。

```json
{
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "main" },
    { "platform": "google", "key": "AIza...", "enabled": true }
  ],
  "customProviders": [
    {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "label": "Ollama",
      "models": [
        { "model": "llama3.1:8b", "displayName": "Local Llama", "supportsTools": true }
      ]
    }
  ],
  "models": [
    {
      "platform": "groq",
      "modelId": "llama-3.3-70b-versatile",
      "displayName": "Llama 3.3 70B",
      "supportsTools": true,
      "fallbackEnabled": true
    }
  ],
  "routing": { "strategy": "balanced" }
}
```

如果两个自定义端点提供同一个模型 id，请在 `models` 或 `fallback` 条目里加上 `"endpoint"` 来指明你说的是哪一个，填端点的 URL，或者仪表盘显示在它旁边的那个短标识。不加的话，一条能匹配到多个端点的条目会被直接拒绝，而不是随便挑一个应用：

```json
{
  "models": [
    { "platform": "custom", "modelId": "deepseek-v3.1", "endpoint": "https://relay-b.example.com/v1", "enabled": false }
  ]
}
```

## Docker 镜像与运维

FreeLLMAPI 发布一个生产镜像，里面包含 Express 服务和构建好的 React 仪表盘：

```bash
docker pull ghcr.io/tashfeenahmed/freellmapi:latest   # 也可以固定到某个版本，例如 :v1.2.3
```

镜像是多架构的（`linux/amd64` 和 `linux/arm64`，所以树莓派上也能跑）。发布的标签有：`latest`（默认分支）、`v*.*.*`（git 发布标签）和 `sha-<commit>`。

仓库里自带的 `docker-compose.yml` 是推荐的安装方式：

```bash
docker compose up -d
docker compose logs -f freellmapi
```

容器端口默认绑定在 `127.0.0.1`（仅本机）。想从网络里的另一台机器访问仪表盘或 API，用 `HOST_BIND=0.0.0.0 docker compose up -d` 把它发布到所有网卡上。只在可信的局域网里这么做，因为这个代理是单用户的。

用局域网地址走纯 HTTP 是可以直接工作的：那些只对 HTTPS 生效的安全响应头（`upgrade-insecure-requests`、`Cross-Origin-Opener-Policy`、`Origin-Agent-Cluster`）只有在请求确实经由 TLS 到达时才会发出，或者是在 loopback 上，因为浏览器本来就把 loopback 当作安全上下文。放在 HTTPS 反向代理后面时它们会自动恢复，只要代理转发了 `X-Forwarded-Proto`。如果你的部署有特殊需要，`CSP_UPGRADE_INSECURE_REQUESTS=true|false` 可以强制开关那条升级指令。

SQLite 数据存放在 `freellmapi-data` 卷的 `/app/server/data` 下。升级时请保持 `.env` 里的 `ENCRYPTION_KEY` 和这个卷不变，因为提供方密钥是加密存储的。如果你的宿主机只持久化某个特定目录，可以设置 `FREEAPI_DB_PATH=/that/path/freellmapi.db`。

在磁盘不持久的宿主机上，配置一个加密备份目标：

```env
FREEAPI_DB_BACKUP_PATH=/app/server/data/freellmapi.db.backup
# 或者：
FREEAPI_DB_BACKUP_URL=https://example.com/freellmapi.db.backup
FREEAPI_DB_BACKUP_TOKEN=optional-bearer-token
FREEAPI_DB_BACKUP_KEY=64-char-hex-backup-key
FREEAPI_DB_BACKUP_INTERVAL_MS=300000
```

启动时如果数据库文件不存在，FreeLLMAPI 会先恢复备份，再执行迁移。服务运行期间，它会定期上传一份新的加密备份。如果没有设置 `FREEAPI_DB_BACKUP_KEY`，备份信封也会使用 `ENCRYPTION_KEY`。

更多 Docker 运维内容和示例在 [docker/README.md](../../../docker/README.md)。

## 桌面应用

[`desktop/`](../../../desktop) 里有一个原生的菜单栏应用：整个路由器加仪表盘就在你的托盘里本地运行，还有一个玻璃质感的悬浮窗显示实时请求统计。

![FreeLLMAPI 桌面应用](../../../repo-assets/desktop.png)

**[从 Releases 下载](https://github.com/tashfeenahmed/freellmapi/releases/latest)** —— macOS 的 `.dmg` 和 Windows 的 `.exe` 安装包由 [`desktop-release`](../../../.github/workflows/desktop-release.yml) 工作流在每个版本发布时构建并附带。你也可以花几分钟从本仓库自己构建：

> **Windows 用户从源码构建的注意事项：** 构建桌面应用需要为 Electron 编译原生 SQLite 模块。在执行 `npm install` 之前，你必须先装好 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（具体来说是「使用 C++ 的桌面开发」工作负载）以及 Python。

```bash
npm install
npm install --prefix desktop  # 安装桌面端依赖
npm run desktop:dist          # macOS  → desktop/dist-electron/FreeLLMAPI-…-arm64.dmg
npm run desktop:dist:win      # Windows → "desktop/dist-electron/FreeLLMAPI Setup ….exe"
```

> 本地构建出来的应用没有签名，所以 Windows SmartScreen 首次运行时可能会警告（点「更多信息」→「仍要运行」）；macOS 构建则不会触发 Gatekeeper 提示。
> 完整说明见 [desktop/README.md](../../../desktop/README.md)。

## 凭据与数据存放位置

桌面应用 **不需要设置用户名或密码**。服务器版会用邮箱加密码的账号把仪表盘挡在登录后面，而桌面版不同：它用一个隐藏的本地账号自动登录仪表盘，所以你永远不会被要求输入凭据，也不需要有一个。

你唯一需要的凭据是那把 **统一 API 密钥**，也就是你的 OpenAI/Anthropic 客户端要指向的 `freellmapi-…` 令牌。可以从这两个地方拿到：

- 托盘悬浮窗：点击托盘图标，然后点 **复制密钥**；或者
- 仪表盘 **密钥** 页的顶部（托盘 → **打开仪表盘**）。

你不需要手动打开或编辑 `freeapi.db`。

你的设置和数据按操作系统存放在一个文件夹里（迁移到另一台机器或搬进容器时，复制它就行）：

| 操作系统 | 位置 |
|----|----------|
| Windows | `%APPDATA%\FreeLLMAPI\`（例如 `C:\Users\<你>\AppData\Roaming\FreeLLMAPI\`） |
| macOS | `~/Library/Application Support/FreeLLMAPI/` |
| Linux | `~/.config/FreeLLMAPI/` |

这个文件夹里有 `freeapi.db`（全部密钥、模型和设置，加密存储）和 `config.json`（窗口、主题、端口、局域网偏好）。搬迁安装时两个都要复制。对于服务器（非桌面）部署，对应的状态是 `.env` 文件和位于 `server/data/freeapi.db`（或者 `FREEAPI_DB_PATH` 指向的位置）的 SQLite 数据库。
