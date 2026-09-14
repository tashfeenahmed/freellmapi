[English](../../en/cli/OVERVIEW.md) · **简体中文**

# CLI 域 —— 概览与文件索引

## 范围

本域文档记录 FreeLLMAPI 安装 CLI（`cli/`）—— 通过 `npx freellmapi` 一键将编程智能体接入本地网关的生成器集合。每个生成器（`setup-claude`、`setup-codex` 等）都会拉取实时目录、备份已有配置、绝不覆盖无关键，并为 `freellmapi launch` / `launch-codex` 零持久化启动器以及 `freellmapi doctor` 记录 `tools.json` 元数据。

权威来源：[`cli/src/tools.ts`](../../../cli/src/tools.ts)（全部 `Xxx()` 生成器函数）、[`cli/tools.json`](../../../cli/tools.json)（注册表）、[`cli/src/config-files.ts`](../../../cli/src/config-files.ts)（合并 + `0600` + 带时间戳备份）、[`cli/README.md`](../../../cli/README.md)、[`client/src/data/agent-tools.json`](../../../client/src/data/agent-tools.json)。

关于按智能体的一对一接入配方与 MCP/无头客户端的说明，见[客户端与编程智能体](../clients/OVERVIEW.md)。关于 CLI 注入的环境变量（`FREELLMAPI_API_KEY`、`FREELLMAPI_MODEL`），见 [env/](../env/OVERVIEW.md)。

## 文件索引

| 文件 | 说明 |
| --- | --- |
| [01-generators.md](01-generators.md) | 全部 `setup-*` 生成器（claude/codex/cline/continue/aider/opencode/goose/qwen/roo/kilo/crush/cursor/dsh/mimo/atomcode/generic）、目标文件、合并行为、`--model` 解析以及 `launch`/`launch-codex`/`doctor` 命令。 |
| [02-config-files.md](02-config-files.md) | 配置文件层：`tools.json` 注册表、`config-files.ts` 合并策略（JSON/TOML/YAML）、`0600` 权限、带时间戳备份、`--dry-run` 以及如何新增生成器。 |
| [CHANGELOG.md](CHANGELOG.md) | 本域文档修订历史。 |

## 导航

- ← [文档根目录](../README.md)
- ↑ [文档索引](../OVERVIEW.md)
