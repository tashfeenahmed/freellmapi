[English](../../../../deployment/OVERVIEW.md) · **简体中文**

# 部署总览

## 范围

在 Docker 中运营 FreeLLMAPI：已发布的镜像、Compose 快速开始、持久化、健康检查、容器网络坑点，以及日常维护工作——升级、备份和声明式配置。内容取材自 [`Dockerfile`](../../../../../Dockerfile)、[`docker-compose.yml`](../../../../../docker-compose.yml)、[`.dockerignore`](../../../../../.dockerignore) 与 [`docs/install.md`](../install.md)。

Docker 之外的安装路径（一行命令脚本、本地开发、桌面应用）见「[安装与部署](../install.md)」。

## 文件索引

| 文件 | 说明 |
| --- | --- |
| [01-docker.md](01-docker.md) | 镜像本身（基于 `node:20-bookworm-slim` 的多阶段构建）、Compose 快速开始、端口与局域网访问、卷与持久化、健康检查、非 root 运行时、原生 `better-sqlite3` 编译缘由，以及为什么容器够不着宿主机能到达的提供方（#733）。 |
| [02-updates-and-backup.md](02-updates-and-backup.md) | 升级流程（`docker compose pull && docker compose up -d`）、仪表盘更新检查器（#635/#703）、SQLite 数据卷的备份，以及声明式配置/目录控制项（#f4cd7b4）。 |

## 速览

| 方面 | 取值 |
| --- | --- |
| 镜像 | `ghcr.io/tashfeenahmed/freellmapi:latest` |
| 端口 | 3001（默认发布在 `127.0.0.1`；`HOST_BIND=0.0.0.0` 对局域网开放） |
| 数据卷 | 命名卷 `freellmapi-data`，挂载于 `/app/server/data` |
| 运行用户 | `node`（非 root） |
| 健康检查 | 每 30 秒一次 `GET /api/ping`，由容器内的 Node fetch 发起 |
