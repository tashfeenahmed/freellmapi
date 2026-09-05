[English](../en/README.md) · **简体中文**

# FreeLLMAPI 文档

这里是用户入口 —— 从这里开始安装网关、调用兼容 OpenAI 的 API、接入编程智能体并了解整体架构。根目录的 [README](../../README.zh-cn.md) 是产品总览；这份索引帮你把服务跑起来。

> **翻译状态：** 所有页面都已有中文版，下面的链接指向中文页面。少数页面在英文原文更新后尚未同步，以英文版为准；每页页首都可切换到英文原文。完整状态见 [翻译状态](OVERVIEW.md#翻译状态)。想补齐其中一篇，欢迎提 PR。

## 指南

- **[安装与部署](install/01-install.md)** —— 快速开始、Docker Compose、本地开发、声明式启动配置、Docker 镜像、备份、桌面应用、数据存放位置，以及关于密码重置、日志和卸载的常见问题。
- **[API 参考](api/01-rest-api.md)** —— 聊天补全、`auto:*` 路由策略、流式、工具调用、视觉、Gemini 的 Google 搜索接地、嵌入、响应头，以及 Anthropic Messages 接口。
- **[客户端与编程智能体](clients/01-agent-clients.md)** —— 兼容 OpenAI 的客户端，Claude Code / Codex CLI / Cline / Continue / Aider / opencode / Cursor 的配方，MCP 服务，编辑器补全，以及上下文交接。
- **[提示词压缩](compression/01-compression-pipeline.md)** —— 请求侧的各种模式、安全保护、按请求的控制项、自定义工具输出过滤器、统计数据和预览 API。
- **[代理传输](proxy/OVERVIEW.md)** —— 出站代理传输：正向代理与 Fetch Relay、系统自动检测、入站的 `TRUST_PROXY`；中继协议与 Cloudflare Worker 参考实现见 [Fetch Relay 传输](proxy/01-fetch-relay.md)。
- **[架构与内部实现](architecture/00-high-level-index.md)** —— 路由器如何工作、路由与运维细节、哪些还不支持、诚实的局限性说明，以及各提供方的服务条款审查。

## 更多

- [在 Android 上用 Termux 安装](install/02-android-termux.md) —— 实验性的本地安装方式，使用 Node 内置的 SQLite 驱动。
- [回退链](fallback/01-named-chains.md) —— 命名回退链的生命周期、空链的权威 `400`、`auto:<name>` 路由，以及目录同步回填。
- [Docker 部署](../../docker/README.md) —— 容器配置与持久化存储。
- [桌面应用](../../desktop/README.md) —— 构建和打包 Electron 应用。
- [贡献者指南](../../CONTRIBUTING.md) —— 开发流程、测试要求和贡献政策。
- [数据库迁移](../../server/src/db/README.md) —— 创建、应用、查看和回滚 schema 迁移。
- [翻译指南](../TRANSLATION.md) —— 仪表盘字符串的规则，以及中文术语约定。

## docs 目录里的站点资源

- [`index.html`](../index.html) —— 项目落地页。
- [`install.sh`](../install.sh) —— Unix 下的 Docker 引导脚本。
- [`install.ps1`](../install.ps1) —— PowerShell 引导脚本。
- [`success.html`](../success.html) —— 安装成功页。
