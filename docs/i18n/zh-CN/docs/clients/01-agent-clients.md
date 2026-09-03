[English](../../../../clients/01-agent-clients.md) · **简体中文**

# 客户端与编程智能体

[← 返回 README](../README.md) · [文档索引](../README.md)

- [OpenAI 兼容客户端](#openai-兼容客户端)
- [编程智能体](#编程智能体)
- [原生 Gemini 客户端](#原生-gemini-客户端)
- [Ollama 客户端](#ollama-客户端)
- [无头客户端](#无头客户端)
- [MCP 服务器](#mcp-服务器)
- [VS Code 幽灵文本自动完成](#vs-code-幽灵文本自动完成)
- [上下文交接](#上下文交接)

## OpenAI 兼容客户端

任何能指向 OpenAI 兼容 base URL 的客户端都能使用 FreeLLMAPI：

- **LangChain、LlamaIndex、官方 OpenAI SDK**：把 `base_url` 设为
  `http://localhost:3001/v1`，使用仪表盘里的统一密钥。
- **本地 GPU 盒子**：为 Ollama、llama.cpp、LM Studio、vLLM 或内部网关添加自定义 OpenAI 兼容端点。

## 编程智能体

用生成器代替手改客户端配置：

```bash
export FREELLMAPI_API_KEY=<统一密钥>   # 或每条命令传 --api-key
npx freellmapi setup-claude --url http://localhost:3001 --dry-run
npx freellmapi setup-claude --url http://localhost:3001
npx freellmapi setup-dsh --url http://localhost:3001 --api-key <统一密钥>
```

`--dry-run` 打印差异。真实写入会与现有配置合并，并先创建带时间戳的备份。`--profile <name>` 创建一个命名的 Claude/Codex 配置档。实时 `/v1/models` 目录提供模型 id 和上下文窗口。

| 智能体 | 自动化命令 | 手动 base URL | 线上协议 |
| --- | --- | --- | --- |
| **Claude Code** | `setup-claude` 或免凭证 `launch` | `http://localhost:3001` | Anthropic Messages |
| **Codex CLI** | `setup-codex` 或 `launch-codex` | `http://localhost:3001/v1` | Responses (`wire_api = "responses"`) |
| **Cline** | `setup-cline` | `http://localhost:3001/v1` | OpenAI Chat |
| **Continue** | `setup-continue` | `http://localhost:3001/v1` | OpenAI Chat / 旧版 Completions |
| **Aider** | `setup-aider` | `http://localhost:3001/v1` | OpenAI Chat |
| **OpenCode** | `setup-opencode` | `http://localhost:3001/v1` | OpenAI Chat |
| **Goose** | `setup-goose` | `http://localhost:3001/v1` | OpenAI Chat |
| **Qwen Code** | `setup-qwen` | `http://localhost:3001/v1` | OpenAI Chat（原生 Gemini 也可用） |
| **Roo Code** | `setup-roo` | `http://localhost:3001/v1` | OpenAI Chat |
| **Kilo Code** | `setup-kilo` | `http://localhost:3001/v1` | OpenAI Chat |
| **Crush** | `setup-crush` | `http://localhost:3001/v1` | OpenAI Chat |
| **DeepSeek Harness** | `setup-dsh` | `http://localhost:3001/v1` | OpenAI Chat (`api: openai-completions`) |
| **Cursor** | `setup-cursor` 打印指引 | 公共 `https://…/v1` | OpenAI Chat |
| **其他** | `setup-generic` 打印现成配置块 | `http://localhost:3001/v1` | OpenAI Chat |

根路径与 `/v1` 的区别很重要：Claude Code 期望服务器根路径，因为它会追加 Anthropic Messages 路径。本表中兼容 OpenAI 的客户端——包括 Cline、Aider、Goose、Codex、Continue、OpenCode、Qwen、Roo、Kilo、Crush 和 DeepSeek Harness——期望它们配置的 base URL 包含 `/v1`。

### DeepSeek Harness (`dsh`)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 把每个提供方都作为一条路由放在
`llm-pi-ai.providers` 下面，文件是 `$DSH_HOME/settings.yaml`（默认 `~/.dsh`）。
`setup-dsh` 在那里添加一条 `freellmapi` 路由——`api: openai-completions`、网关的 `/v1` base URL、以及实时目录作为该路由的 `models` 列表（DSH 要求提供方在其自带目录里没有的模型也得列出来）——并把 `freellmapi/auto` 设为默认模型。密钥写进 `$DSH_HOME/.env`（权限 0600）作为 `FREELLMAPI_API_KEY`，这是 DSH 自己读取的环境层，所以无需导出。两次写入都是结构化合并：文件里其他的路由、注释、设置保持原样。

```bash
npx freellmapi setup-dsh --url http://localhost:3001 --api-key <统一密钥>
npx @deepseek-ai/dsh web
```

设置是热重载的，所以运行中的 `dsh` 下一次请求就会用上这条路由。`--profile <name>` 添加第二条路由（`freellmapi-<name>`）而不改变默认模型；`--model <id>` 固定默认值。路由只声明文本——在 `freellmapi.models` 下给某模型条目加上 `input: [text, image]` 即可发图。尊重 `DSH_HOME`。

## 原生 Gemini 客户端

Gemini CLI 和 Gemini 系客户端能直接说 Google 的线上格式：

```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:3001
export GEMINI_API_KEY=freellmapi-your-unified-key
gemini
```

原生面实现了 `GET /v1beta/models`、模型元数据、`generateContent`、`streamGenerateContent`（含 `?alt=sse`）和 `countTokens`。鉴权接受 `x-goog-api-key`、Bearer 或 Gemini 的 `?key=` 兜底。首选头部：查询凭证会泄露进历史和代理日志。

**密钥 → 智能体** 标签页把 Gemini Pro、Flash 和 Flash-Lite 系列名映射到 Auto 或某个固定的目录模型。

## Ollama 客户端

Ollama 模拟默认关闭。在 **密钥 → 智能体** 里启用下列模式之一：

- `open-loopback`：本机免密钥。套接字对端必须是
  `127.0.0.1`/`::1`；启用桌面局域网访问不会扩大此范围。
  **Docker 注意事项：** 容器内套接字对端是 Docker 网桥 IP，不是环回，所以此模式甚至拒绝通过发布端口的宿主机本地流量——Docker 部署请用 `key-required`。
- `key-required`：客户端必须发送 `Authorization: Bearer <统一密钥>`。

确切端点是 `/api/tags`、`/api/chat`、`/api/generate`、`/api/show`、
`/api/version`、`/api/embed` 和旧版 `/api/embeddings`。流式用
换行分隔 JSON，而非 SSE。把 Zed、JetBrains AI Assistant 或其他
支持 Ollama 的客户端指向 `http://localhost:3001`。

## 无头客户端

如果客户端无法设置头部，在 **密钥 → 智能体** 里单独创建一个可撤销的令牌，然后用：

```text
http://localhost:3001/v1/t/<token>/chat/completions
http://localhost:3001/v1/t/<token>/responses
http://localhost:3001/v1/t/<token>/models
```

同一前缀也暴露 `/api/chat` 和 `/api/tags`。永远别把统一 API 密钥放进 URL。URL 令牌有独立哈希和即时撤销，因为 URL 经常泄露进 shell 历史、反向代理日志和遥测。

## MCP 服务器

在推理之上，路由器还是个 **MCP 服务器**：智能体能在会话中途内省它
（可用模型及各模型支持的参数、提供方健康度、用量与缓存统计、
路由策略）。对 Claude Code：

```bash
claude mcp add --transport http freellmapi http://localhost:3001/mcp \
  --header "Authorization: Bearer freellmapi-your-unified-key"
```

任何说 Streamable HTTP 的 MCP 客户端都一样：指向 `/mcp`，用统一密钥作 Bearer 令牌。

FreeLLMAPI 设计为本地优先、单用户。你的提供方密钥留在你的 SQLite 里，静态加密，请求从你的机器直达你启用的上游提供方。

## VS Code 幽灵文本自动完成

FreeLLMAPI 暴露 `/v1/completions` 给发旧版 OpenAI prompt/suffix 请求的编辑器自动完成客户端。Continue 配置示例：

```yaml
models:
  - name: FreeLLMAPI Autocomplete
    provider: openai
    model: auto
    apiBase: http://localhost:3001/v1
    apiKey: freellmapi-your-unified-key
    useLegacyCompletionsEndpoint: true
    roles:
      - autocomplete
```

## 上下文交接

当 FreeLLMAPI 在对话中途故障转移到另一个模型（额度、限流、冷却），新模型不知道它在接别人的活。**上下文交接**往出站请求里注入一条精简的 `system` 消息，精确告诉新模型这事：

```
FreeLLMAPI context handoff:
You are taking over an ongoing conversation from another model (groq:llama-3 → google:gemini-flash).
Continue the user's task using the conversation context already provided in this request.
Do not restart the task, re-ask already answered setup questions, or discard prior tool results.
Respect the user's latest message as the highest-priority instruction.

Recent session summary:
User: …
Assistant: …
```

**在 `.env` 里启用：**

```env
FREELLMAPI_CONTEXT_HANDOFF=on_model_switch
```

**工作原理：**

- 每会话消息存在内存里（TTL：3 小时）。
- 只有给定会话键的选中模型变了才注入。
- 首次请求、同模型续写、或已有交接消息时不注入。
- 会话键：有 `X-Session-Id` 头则用它，否则用首条用户消息的 SHA-1（同粘性会话）。
- 存储纯内存。不写磁盘、不记日志。

> **重要：** 上下文交接改善了经由 FreeLLMAPI 路由的对话的连贯性。它无法恢复提供方内部的隐藏状态，也无法挽回从未发给代理的消息。