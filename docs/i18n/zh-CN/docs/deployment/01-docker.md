[English](../../../../deployment/01-docker.md) · **简体中文**

# Docker

生产镜像、Compose 快速开始，以及在容器里运行 FreeLLMAPI 的一切：持久化、端口、健康检查和网络坑点。

- [镜像](#镜像)
- [Compose 快速开始](#compose-快速开始)
- [端口与局域网访问](#端口与局域网访问)
- [卷与持久化](#卷与持久化)
- [健康检查](#健康检查)
- [非 root 运行时](#非-root-运行时)
- [为什么 better-sqlite3 要从源码编译](#为什么-better-sqlite3-要从源码编译)
- [排障：容器够不着提供方（#733）](#排障容器够不着提供方733)

## 镜像

FreeLLMAPI 发布单个生产镜像，内含 Express 服务器和构建好的 React 仪表盘：

```bash
docker pull ghcr.io/tashfeenahmed/freellmapi:latest   # 或固定到某个发布版本，如 :v1.2.3
```

已发布的标签：`latest`（默认分支）、`v*.*.*`（git release 标签）和 `sha-<commit>`。镜像是多架构的（`linux/amd64` + `linux/arm64`，所以树莓派也能跑）。

构建形态（[Dockerfile](../../../../../Dockerfile)）：

- 基于 `node:20-bookworm-slim` 的三个阶段（`deps` → `build` → `runtime`）；只有已构建完成的产物会被复制进 runtime 阶段。
- runtime 阶段设置 `NODE_ENV=production`、`PORT=3001` 和 `FREELLMAPI_INSTALL_METHOD=docker`；进程为 `node server/dist/index.js`。
- 一对 `FREELLMAPI_COMMIT_SHA` ARG/ENV 刻意放在所有 `COPY` 层之后：SHA 每次提交都会变，放得更高会让每次构建都使整个镜像的层缓存失效。
- runtime 还会复制 `desktop/package.json`（一个约 400 字节的清单），让容器安装能报出自己的发布版本（#703）。
- `.dockerignore` 把秘密和本地状态挡在构建上下文之外：`.env`、`.env.*`、`*.db`（含 `-wal`/`-shm` 边车文件）、`.encryption-key` 以及 `server/data` 永远不会进入镜像。

## Compose 快速开始

前置条件：Docker、Docker Compose、OpenSSL。macOS/Linux：

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

# 生成用于静态存储密钥的加密密钥
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d
```

Windows PowerShell 版本和 curl 一行命令引导见 [`docs/install.md`](../install.md#docker-compose)。然后跟踪日志：

```bash
docker compose logs -f freellmapi
```

打开 http://localhost:3001 ，在「密钥」页添加提供方密钥，并从该页顶部拿到你的统一 API 密钥——你的 OpenAI SDK 要指向的就是它。

## 端口与局域网访问

Compose 文件把端口发布为 `"${HOST_BIND:-127.0.0.1}:${PORT:-3001}:3001"`。默认仪表盘/API 只能从运行 Docker 的那台机器访问；想从其他设备访问它（例如树莓派上的 `http://192.168.1.x:3001`）：

```bash
HOST_BIND=0.0.0.0 docker compose up -d
```

只在可信网络上这么做——这个代理是单用户的，唯一的防护就是统一 API 密钥。

## 卷与持久化

SQLite 数据存放在命名卷 `freellmapi-data` 中，挂载于 `/app/server/data`。升级时保持同一个 `.env` 的 `ENCRYPTION_KEY` 和同一个卷，因为提供方密钥是静态加密的。如果你的主机只有一个特定目录做了持久化，用 `FREEAPI_DB_PATH=/that/path/freellmapi.db` 把数据库指过去。

Dockerfile 有意不为 `/app/server/data` 声明 `VOLUME`。持久化是部署方的职责——Compose 文件在那里映射命名卷，普通 `docker run` 则用 `-v`。改在镜像里声明的话，每个没有覆盖它的容器都会创建一个匿名卷：从 Dockerfile 构建的 PaaS 运行时（Railway、Render、Coolify、Dokploy、CapRover）要么拒绝该镜像，要么悄悄给每次重新部署发一个全新的空卷；这条声明还会遮蔽挂载在同一路径的 bind mount。

这个卷的备份见 [02-updates-and-backup.md](02-updates-and-backup.md)。

## 健康检查

Dockerfile 和 Compose 文件定义了同一个探针：一条 Node 单行命令，在容器内请求 `http://127.0.0.1:<port>/api/ping`，响应不 OK 就以非零码退出。

| 设置 | 取值 |
| --- | --- |
| 间隔 | 30s |
| 超时 | 5s |
| 启动期 | 15s |
| 重试次数 | 3 |

## 非 root 运行时

runtime 阶段在 `EXPOSE 3001` 之前切换到 `USER node`。服务器数据目录 `/app/server/data` 在构建期间创建并 chown 给 `node:node`，保证运行用户拥有它；所有复制的产物都带 `--chown=node:node`。

## 为什么 better-sqlite3 要从源码编译

`better-sqlite3` 是原生模块。在没有可用预编译二进制的 slim 镜像上——尤其是 QEMU 下的 `linux/arm64` 架构——node-gyp 会从源码编译它，这需要 Python 和一套 C++ 工具链。因此构建阶段通过 apt 安装 `python3 make g++`，而 runtime 镜像直接复制已经编译好的 `node_modules`，让发布的镜像保持干净、不带构建工具。（这套工具链由 #143 加入，此前没有它会构建失败。）

一个相关的打包细节：npm 会把某些生产包嵌套在工作区之下而不是提升到顶层（`undici` 位于 `server/node_modules/undici`）。跳过 `server/node_modules` 的复制曾导致发布镜像里 HTTP(S) 代理分发器加载失败、所有请求都静默直连（#550，c6589ff 修复）。

## 排障：容器够不着提供方（#733）

宿主机一切正常，容器里的提供方却不可达？容器有自己独立的网络栈，有两件在你机器上顺理成章的事不会自动延续过去：

- **`127.0.0.1` 上的代理不是你的机器。** 在容器内部，环回地址指容器自己。如果你经由宿主机上的代理客户端（Clash、v2rayN、sing-box 或公司代理）访问提供方，就让 FreeLLMAPI 指向宿主机：`PROXY_URL=socks5h://host.docker.internal:7890`。随附的 `docker-compose.yml` 通过 `extra_hosts` 把 `host.docker.internal` 映射到宿主机网关，所以在原生 Linux Docker 上和 Docker Desktop 里都可用。代理还得接受来自环回之外的连接（在 Clash 里是 `allow-lan: true`）。更多细节见 [../env/03-outbound-proxies.md](../env/03-outbound-proxies.md#docker-127001-指的是容器)。
- **纯 IPv6 的宿主机需要在 Docker 里启用 IPv6。** 默认桥接网络只有 IPv4，所以在没有 IPv4 路由的主机上容器什么都够不着，DNS 也一样。在 `/etc/docker/daemon.json` 中以 `"ipv6": true`、`"ip6tables": true` 和一段 `"fixed-cidr-v6"` 网段启用，然后重启 Docker。

想分辨自己撞上的是哪种情况，直接问容器本身：

```bash
docker compose exec freellmapi node -e "fetch('https://generativelanguage.googleapis.com/').then(r=>console.log('ok',r.status)).catch(e=>console.log('fail',e.cause?.code||e.message))"
```
