[English](../../en/cli/02-config-files.md) · **简体中文**

# 配置文件

## 注册表 —— `cli/tools.json`

`cli/tools.json` 是生成器清单的唯一事实来源。每个条目包含 `id`、`name`、`category`（`code`|`agent`）、`configType`（`file`|`guide`）、`protocol`（`Anthropic Messages`|`OpenAI Chat`|`OpenAI Responses`）、`baseUrlSupport`、`command`（`setup-*`）和 `docsUrl`。`client/src/data/agent-tools.json` 是仪表盘侧的副本（保持同步）。

## `cli/src/config-files.ts` —— 合并层

`cli/src/tools.ts` 中的每个 `Xxx()` 生成器都会返回一个 `Generation { files: { path, format, sensitive, value }[], notes }`。`config-files.ts` 按以下方式应用每个文件：

- **JSON**（`settings.json`、`config.json`）—— 深度合并，保留无关键；写入时设 `0600`（`0o600`）。
- **TOML**（Codex、AtomCode 的 `config.toml`）—— 结构化合并，保留其他 `[providers.*]` 表；Codex 的单文件 `~/.codex/config.toml` 使用 `[profiles.NAME]` 表，而不是按配置档分文件。
- **YAML**（Goose 的 `config.yaml`）—— 类似合并。

### 备份

首次写入前，`config-files.ts` 会把已有文件复制为 `<path>.bak.<ISO 时间戳>`（例如 `settings.json.bak.2026-09-02T10-30-00-000Z`）。若文件原本不存在则不做备份。备份同样设为 `0600`。

### Dry run

`--dry-run` 在内存中执行合并、打印 diff 后退出，不触碰磁盘。

### `tools.test.ts` 快照

`cli/src/__snapshots__/tools.test.ts.snap` 固定了每个生成器的生成文件内容；改动生成器后请执行 `npm run test -- -u` 更新快照。

## 新增生成器

1. 在 `cli/tools.json` 中新增条目（`id`、`name`、`category`、`configType`、`protocol`、`baseUrlSupport`、`command`、`docsUrl`）。
2. 在 `cli/src/tools.ts` 中新增 `function myTool(ctx: GenerateContext): Generation` —— 返回正确的 `path`/`format`/`value` 的 `files` 以及供 CLI 输出的 `notes`。使用辅助函数 `rootUrl()`/`v1Url()`/`primaryModel()`/`contextWindow()`。
3. 在 `cli/src/tools.test.ts` 中新增快照用例。
4. 在 [01-generators.md](01-generators.md) 表格与 `docs/en/clients/01-agent-clients.md` 章节中补充文档。
5. 若仪表盘会列出它，需同步 `client/src/data/agent-tools.json`。

## 相关

- [生成器](01-generators.md) —— 全部 `setup-*` 命令与目标文件。
- [客户端与编程智能体](../clients/01-agent-clients.md) —— 按智能体配方。
