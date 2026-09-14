[English](../en/OVERVIEW.md) · **简体中文**

# 文档 —— 简体中文

简体中文文档的语言级索引。每个文件都与 `docs/en/` 中同一位置的英文原文一一对应；术语遵循 [../TRANSLATION.md](../TRANSLATION.md) 中约定的中文术语表（提供方、词元、令牌……），与仪表盘界面保持一致。

## 域

| 域 | 对应英文 | 说明 |
| --- | --- | --- |
| [api/](api/OVERVIEW.md) | [en/api/](api/OVERVIEW.md) | API 参考：聊天补全、流式、工具调用、视觉、嵌入、响应头、Anthropic Messages 接口、幂等键。 |
| [architecture/](architecture/OVERVIEW.md) | [en/architecture/](architecture/OVERVIEW.md) | 架构深入解析：老虎机路由与评分、额度与冷却引擎、流式管线、降级模式与故障转移、目录同步、可观测性。另见 [00-high-level-index.md](architecture/00-high-level-index.md)。 |
| [cli/](cli/OVERVIEW.md) | [en/cli/](cli/OVERVIEW.md) | 安装 CLI：`setup-*` 生成器、配置文件合并层。 |
| [clients/](clients/OVERVIEW.md) | [en/clients/](clients/OVERVIEW.md) | 客户端与编程智能体：兼容 OpenAI 的客户端、配置配方、MCP、编辑器补全。 |
| [compression/](compression/OVERVIEW.md) | [en/compression/](compression/OVERVIEW.md) | 提示词压缩：模式、安全保护、按请求控制、过滤器、统计。 |
| [deployment/](deployment/OVERVIEW.md) | [en/deployment/](deployment/OVERVIEW.md) | Docker 运维：镜像、Compose、网络、升级、备份。 |
| [desktop/](desktop/OVERVIEW.md) | [en/desktop/](desktop/OVERVIEW.md) | 桌面应用：Electron 结构、文件日志、更新分发。 |
| [env/](env/OVERVIEW.md) | [en/env/](env/OVERVIEW.md) | 运行时配置：`.env` 变量、加密密钥、出站代理。 |
| [fallback/](fallback/OVERVIEW.md) | [en/fallback/](fallback/OVERVIEW.md) | 命名回退链：生命周期、`auto:<name>`、目录同步回填。 |
| [glossary/](glossary/OVERVIEW.md) | [en/glossary/](glossary/OVERVIEW.md) | 术语表：余量、RPD/TPD、池键、`auto:<name>`、模型年龄闸。 |
| [install/](install/OVERVIEW.md) | [en/install/](install/OVERVIEW.md) | 安装：快速开始、Docker Compose、本地开发、桌面应用、Termux。 |
| [logs/](logs/OVERVIEW.md) | [en/logs/](logs/OVERVIEW.md) | 服务器日志查看器：实时面板、两级存储、轮询 API。 |
| [providers/](providers/OVERVIEW.md) | [en/providers/](providers/OVERVIEW.md) | 提供方集成：支持的平台目录、额度核算、添加新提供方。 |
| [proxy/](proxy/OVERVIEW.md) | [en/proxy/](proxy/OVERVIEW.md) | 出站代理传输：正向代理与 Fetch Relay、系统自动检测。 |
| [testing/](testing/OVERVIEW.md) | [en/testing/](testing/OVERVIEW.md) | 测试：本地矩阵、服务端套件、端到端兼容性套件。 |
| [troubleshooting/](troubleshooting/OVERVIEW.md) | [en/troubleshooting/](troubleshooting/OVERVIEW.md) | 常见问题：Docker、空链、Fetch Relay、幂等、额度、TRUST_PROXY。 |
| [i18n](../TRANSLATION.md) | — | 翻译流程与术语表 —— 跨语言指南，位于语言目录之外。 |

## 翻译状态

文件集合与英文完全一致：每个英文页面在这里都有同名的中文页面，且所有页面都已有中文内容。少数较长的页面（如 API 参考、安装、出站代理和几篇架构深入解析）在英文原文新增章节后尚未同步，以英文版为准；每个页面页首的语言切换都能直接跳到对应原文。想补齐其中一篇，欢迎提 PR：直接编辑 `docs/zh-cn/` 下的同名文件即可，不要改动文件名或目录结构。

## 其他入口

- [README.md](README.md) —— 中文文档入口页。
- [../../README.zh-cn.md](../../README.zh-cn.md) —— 项目总览（中文 README）。
- [../OVERVIEW.md](../OVERVIEW.md) —— `docs/` 目录总索引。

另见：[English](../en/OVERVIEW.md) · [翻译指南](../TRANSLATION.md)
