[English](../../../README.md) · **简体中文**

# FreeLLMAPI 文档

根目录的 [README](../README.md) 是产品总览，详细指南在这里。

> **翻译状态：** 「安装与部署」和「API 参考」已翻译成中文。其余三篇指南目前只有英文版，
> 链接直接指向英文原文。完整状态见 [这里](../../README.md#status)。想认领其中一篇，欢迎提 PR。

## 指南

- **[安装与部署](install.md)** —— 快速开始、Docker Compose、本地开发、声明式启动配置、Docker 镜像、备份、桌面应用，以及你的数据存放在哪里。
- **[API 参考](api/01-rest-api.md)** —— 聊天补全、`auto:*` 路由策略、流式、工具调用、视觉、Gemini 的 Google 搜索接地、嵌入、响应头，以及 Anthropic Messages 接口。
- **[客户端与编程智能体](../../../clients/01-agent-clients.md)** —— 兼容 OpenAI 的客户端，Claude Code / Codex CLI / Cline / Continue / Aider / opencode / Cursor 的配方，MCP 服务，编辑器补全，以及上下文交接。
- **[提示词压缩](../../../compression/01-compression-pipeline.md)** —— 请求侧的各种模式、安全保护、按请求的控制项、自定义工具输出过滤器、统计数据和预览 API。
- **[架构与内部实现](../../../architecture.md)** —— 路由器如何工作、路由与运维细节、哪些还不支持、诚实的局限性说明，以及各提供方的服务条款审查。

## 更多

- [在 Android 上用 Termux 安装](../../../install/android-termux.md) —— 实验性的本地安装方式，使用 Node 内置的 SQLite 驱动。
- [Docker 部署](../../../../docker/README.md) —— 容器配置与持久化存储。
- [桌面应用](../../../../desktop/README.md) —— 构建和打包 Electron 应用。
- [贡献者指南](../../../../CONTRIBUTING.md) —— 开发流程、测试要求和贡献政策。
- [数据库迁移](../../../../server/src/db/README.md) —— 创建、应用、查看和回滚 schema 迁移。
- [翻译指南](../../01-translating.md) —— 仪表盘字符串的规则，以及中文术语约定。

## docs 目录里的站点资源

- [`index.html`](../../../index.html) —— 项目落地页。
- [`install.sh`](../../../install.sh) —— Unix 下的 Docker 引导脚本。
- [`install.ps1`](../../../install.ps1) —— PowerShell 引导脚本。
- [`success.html`](../../../success.html) —— 安装成功页。
