[English](../../../../testing/03-compatibility-suite.md) · **简体中文**

# 兼容性套件

## 它是什么

编程智能体兼容性套件（提交 `19168ac`，#629，2026-07-27）证明的是真实的 AI 编程智能体能对着 FreeLLMAPI 的各个端面工作——而不仅仅是端点存在。它覆盖智能体触及的三层集成：它调用的线上 API、被指过去的配置文件，以及网关对其流量施加的客户端分类。

## 覆盖什么、位于哪里

### 原生 Gemini `/v1beta` 端面

[`server/src/__tests__/routes/gemini.test.ts`](../../../../../server/src/__tests__/routes/gemini.test.ts) 经 HTTP 驱动组装完成的 Express 应用：

- 模型发现、`generateContent`（JSON 与 SSE 流式）、`countTokens`；
- Gemini 的 schema 方言与上游提供方之间的工具/思考/结构化输出翻译；
- 面向 Gemini CLI 的系列映射与正确默认值（输出上限、动态思考、省略 `tool_choice`）。

### Ollama 模拟（需主动开启）

[`server/src/__tests__/routes/ollama.test.ts`](../../../../../server/src/__tests__/routes/ollama.test.ts) 覆盖 NDJSON 的 `chat`/`generate`、`tags`/`show`/`version`、嵌入，以及模式矩阵（off / open loopback / key-required 加按 IP 限流），还有协议保真细节：generate 帧、旧版 embeddings 正文、load 探测、`done_reason` 词汇表。

### Setup CLI

`cli/` 工作区（同一提交加入，由根链测试）为 Claude Code、Codex CLI、Cline、Continue、OpenCode、Goose、Qwen Code、Roo/Kilo/Crush 和 Cursor 生成各自的配置——13 个数据驱动的生成器，带保留注释的结构化合并（TOML 能在已有 MCP 表之下存活）、备份、dry run、凭据安全的启动器，以及 Claude Code 发现别名。测试：`cli/src/tools.test.ts`、`cli/src/config-files.test.ts`（含快照）、`cli/src/index.test.ts`。

### 客户端分类与 URL 令牌

客户端分类器测试（`server/src/__tests__/lib/client-context.test.ts` 及同侪）钉住喂给仪表盘「智能体」页和按智能体分析的识别逻辑；[`routes/url-tokens.test.ts`](../../../../../server/src/__tests__/routes/url-tokens.test.ts) 覆盖供无请求头客户端使用的、可单独撤销的 URL 令牌，校验过程防时序攻击。

## 它证明了什么

1. **协议保真**：说原生 Gemini 或 Ollama 线上格式的智能体得到的是语义正确的回答——流式帧、工具调用翻译、词元计数——而不只是一个 200。
2. **零配置接入**：setup CLI 写出的智能体配置文件即使已含有无关内容也依然正确（结构化合并而非覆盖），且绝不把凭据泄漏进生成的启动器。
3. **加固的回归安全**：#629 审查加固中的修复（Gemini CLI 默认值、Ollama 协议边角、TOML 合并存活、防时序的令牌检查）都以测试的形式钉死。

提交信息里注明：该套件曾在一个隔离部署上用真实提供方密钥对所有新端面做过线上验证——这些测试把那些观测编码下来，让保证在重构之后依然成立。
