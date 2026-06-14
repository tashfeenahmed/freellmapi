**[English](./README.md)** | **中文**

<div align="center">

# FreeLLMAPI

**一个 OpenAI 兼容的 endpoint。十六个免费 LLM 供应商。每月约 17 亿 token。**

将 Google、Groq、Cerebras、SambaNova、NVIDIA、Mistral、OpenRouter、GitHub Models、Cohere、Cloudflare、HuggingFace、Z.ai（智谱）、Ollama、Kilo、Pollinations 和 LLM7 的免费额度 — 以及任何自定义 OpenAI 兼容 endpoint（llama.cpp、LM Studio、vLLM、本地 Ollama）— 聚合到一个 `/v1/chat/completions` endpoint 之后。密钥加密存储。路由器为每个请求选择最佳可用模型，在某个供应商触发限流时自动切换到下一个，并跟踪每个密钥的使用量，确保你始终在免费额度之内。

[![CI](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/tashfeenahmed/freellmapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#贡献)
[![Docker image](https://img.shields.io/badge/ghcr.io-freellmapi-2496ED?logo=docker&logoColor=white)](https://github.com/tashfeenahmed/freellmapi/pkgs/container/freellmapi)

![Fallback chain with per-provider token budget](repo-assets/fallback-chain.png)

</div>

---

## 目录

- [为什么做这个项目](#为什么做这个项目)
- [支持的供应商](#支持的供应商)
- [功能特性](#功能特性)
- [尚未支持](#尚未支持)
- [快速开始](#快速开始)
- [Docker](#docker)
- [桌面应用](#桌面应用)
- [使用 API](#使用-api)
- [截图](#截图)
- [工作原理](#工作原理)
- [局限性](#局限性)
- [贡献](#贡献)
- [服务条款审查](#服务条款审查)
- [免责声明](#免责声明)

## 为什么做这个项目

如今每个主流 AI 实验室都提供免费额度 — 每月几百万 token，每天几千次请求。单独看每个额度都不多，但叠加在一起，就能获得约 **每月 17 亿 token** 的可用推理能力，覆盖 100 多个模型，从小而快到相当能打的应有尽有。

问题是手动堆叠这些服务太痛苦了：十六个不同的 SDK、十六个不同的限流规则、十六个可能出错的节点。FreeLLMAPI 将它们压缩成一个 OpenAI 兼容的 endpoint。将任何 OpenAI 客户端库指向你的本地服务器，它会透明地在所有已添加密钥的供应商之间路由。

## 支持的供应商

<table>
<tr>
<td align="center" width="180"><a href="https://ai.google.dev"><b>Google</b><br/>Gemini 2.5 Flash · 3.x 预览版</a></td>
<td align="center" width="180"><a href="https://groq.com"><b>Groq</b><br/>Llama 3.3、Llama 4、GPT-OSS、Qwen3</a></td>
<td align="center" width="180"><a href="https://cerebras.ai"><b>Cerebras</b><br/>Qwen3 235B</a></td>
<td align="center" width="180"><a href="https://cloud.sambanova.ai"><b>SambaNova</b><br/>DeepSeek V3.x · Llama 4 · Gemma 3</a></td>
</tr>
<tr>
<td align="center"><a href="https://mistral.ai"><b>Mistral</b><br/>Large 3 · Medium 3.5 · Codestral · Devstral</a></td>
<td align="center"><a href="https://openrouter.ai"><b>OpenRouter</b><br/>21 个免费模型</a></td>
<td align="center"><a href="https://github.com/marketplace/models"><b>GitHub Models</b><br/>GPT-4.1 · GPT-4o</a></td>
<td align="center"><a href="https://developers.cloudflare.com/workers-ai"><b>Cloudflare</b><br/>Kimi K2 · GLM-4.7 · GPT-OSS · Granite 4</a></td>
</tr>
<tr>
<td align="center"><a href="https://cohere.com"><b>Cohere</b><br/>Command R+ · Command-A（试用）</a></td>
<td align="center"><a href="https://docs.z.ai"><b>Z.ai（智谱）</b><br/>GLM-4.5 · GLM-4.7 Flash</a></td>
<td align="center"><a href="https://build.nvidia.com"><b>NVIDIA</b><br/>NIM（默认禁用）</a></td>
<td align="center"><a href="https://huggingface.co/docs/inference-providers"><b>HuggingFace</b><br/>路由 → DeepSeek V4 · Kimi K2.6 · Qwen3</a></td>
</tr>
<tr>
<td align="center"><a href="https://ollama.com"><b>Ollama Cloud</b><br/>GLM-4.7 · Kimi K2 · gpt-oss · Qwen3</a></td>
<td align="center"><a href="https://kilo.ai"><b>Kilo Gateway</b><br/>:free 路由（无需注册）</a></td>
<td align="center"><a href="https://pollinations.ai"><b>Pollinations</b><br/>GPT-OSS 20B（无需注册）</a></td>
<td align="center"><a href="https://llm7.io"><b>LLM7</b><br/>GPT-OSS · Llama 3.1 · GLM（无需注册）</a></td>
</tr>
</table>

此外还有一个**自定义**供应商 — 可以在 Keys 页面指向任何 OpenAI 兼容的 endpoint（llama.cpp、LM Studio、vLLM、本地 Ollama 或远程网关）。

## 功能特性

- **OpenAI 兼容** — `POST /v1/chat/completions` 和 `GET /v1/models` 与官方 OpenAI SDK 及任何 OpenAI 兼容客户端（LangChain、LlamaIndex、Continue、Hermes 等）完全兼容。只需修改 `base_url`。
- **Responses API** — `POST /v1/responses`（当前 Codex CLI 版本所需的传输格式）作为同一路由器上的转换层实现，支持完整的流式事件和工具调用。
- **流式和非流式** — `stream: true` 时使用 Server-Sent Events，否则返回 JSON 响应。每个供应商适配器都实现了两种模式。
- **工具调用** — OpenAI 风格的 `tools` / `tool_choice` 请求会被透传，assistant 的 `tool_calls` + `tool` 角色的后续消息可以跨供应商往返传递。
- **向量嵌入** — `/v1/embeddings` 支持基于族的模型路由：故障转移只发生在提供*相同*模型的供应商之间（不同模型生成的向量不兼容），不会跨模型切换。参见[向量嵌入](#向量嵌入)。
- **自动故障转移** — 如果所选供应商返回 429、5xx 或超时，路由器会跳过它，将该密钥短暂冷却，并在回退链中的下一个模型上重试（最多 20 次）。
- **按密钥限流追踪** — 每个 `(平台, 模型, 密钥)` 组合都有 RPM、RPD、TPM 和 TPD 计数器，确保路由器始终选择未超额度的密钥。
- **粘性会话** — 多轮对话在 30 分钟内持续使用同一模型，避免对话中途切换模型导致的幻觉飙升。
- **加密密钥存储** — API 密钥在写入 SQLite 之前使用 AES-256-GCM 加密；仅在发送请求前在内存中解密。
- **统一 API 密钥** — 客户端使用单个 `freellmapi-…` bearer token 向你的代理进行身份验证。你永远不需要向上游应用暴露供应商密钥。
- **仪表盘登录** — 管理界面和所有 `/api/*` 路由都需要邮箱 + 密码账户认证（scrypt 哈希，session-token 认证），首次运行时设置。`/v1` 代理使用独立的统一密钥认证。
- **健康检查** — 定期探测将密钥标记为 `healthy`、`rate_limited`、`invalid` 或 `error`，路由器会自动跳过失效的密钥。
- **管理仪表盘** — React + Vite 界面，用于管理密钥、调整回退链顺序、查看分析数据以及在 Playground 中运行提示。支持深色模式。
- **数据分析** — 按请求记录延迟、token 数量、成功率和各供应商的统计明细。
- **随处运行** — 只要 Node 20+ 能跑的地方就行 — Windows、macOS、Linux 服务器，甚至小型 ARM 单板机（包括树莓派）。PM2 / systemd 或其他进程管理器下空闲时仅约 40 MB RSS。

## 尚未支持

范围是有意收窄的。如果某个功能不在下面的列表中，就假定它还不存在。

- **图像生成**（`/v1/images/*`）
- **音频 / 语音**（`/v1/audio/*`）
- **传统补全**（`/v1/completions`）— 仅实现了 chat endpoint
- **内容审核**（`/v1/moderations`）
- **`n > 1`**（单次请求多个补全）
- **按用户计费 / 多租户认证** — 单用户设计

非常欢迎提交添加以上功能的 PR。参见[贡献](#贡献)。

## 快速开始

**推荐方式：** Docker Compose。它会在 3001 端口同时运行 API 和仪表盘，并将 SQLite 数据持久化到命名卷中。

**前置条件：** Docker、Docker Compose、OpenSSL。

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi

# 生成密钥加密用的加密密钥
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d
```

打开 http://localhost:3001，在 **Keys** 页面添加你的供应商密钥，按喜好调整 **Fallback Chain** 的顺序，然后从 **Keys** 页面顶部获取你的统一 API 密钥。这个统一密钥就是你要指向 OpenAI SDK 的。

> **从其他机器访问？** 默认情况下容器仅在 `127.0.0.1` 上发布，所以从其他设备访问 `http://<服务器IP>:3001` 无法加载（页面会一直转圈）。要在局域网中暴露它 — 例如树莓派上的 `http://192.168.1.x:3001` — 使用 `HOST_BIND=0.0.0.0` 启动：
>
> ```bash
> HOST_BIND=0.0.0.0 docker compose up -d
> ```
>
> 请仅在可信网络上这样做：代理是单用户的，仅有统一 API 密钥保护。

### 本地开发

**前置条件：** Node.js 20+、npm。

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install
cp .env.example .env
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
npm run dev
```

`ENCRYPTION_KEY` 是启动必需的。服务器仅在 `DEV_MODE=true` 且 `NODE_ENV` 不是 `production` 时才会回退到数据库中存储的开发密钥；不要在包含真实供应商密钥时使用该回退机制。

请求分析数据默认保留 90 天或 100000 行，以先达到的限制为准进行清理。在 `.env` 中设置 `REQUEST_ANALYTICS_RETENTION_DAYS=0` 或 `REQUEST_ANALYTICS_MAX_ROWS=0` 可禁用对应的保留限制。

打开 http://localhost:5173（Vite 开发界面），在 **Keys** 页面添加你的供应商密钥，按喜好调整 **Fallback Chain** 的顺序，然后从 **Keys** 页面顶部获取你的统一 API 密钥。这个统一密钥就是你要指向 OpenAI SDK 的。

不使用 Docker 的生产构建：

```bash
npm run build
node server/dist/index.js     # 服务器 + 仪表盘均在 :3001 上提供服务
```

## Docker

FreeLLMAPI 发布一个包含 Express 服务器和构建好的 React 仪表盘的生产镜像：

```bash
docker pull ghcr.io/tashfeenahmed/freellmapi:latest   # 或固定版本，例如 :v1.2.3
```

该镜像支持多架构（`linux/amd64` + `linux/arm64`，可在树莓派上运行）。发布的标签：`latest`（默认分支）、`v*.*.*`（git 发布标签）和 `sha-<commit>`。

内置的 `docker-compose.yml` 是推荐的安装方式：

```bash
docker compose up -d
docker compose logs -f freellmapi
```

默认情况下容器端口绑定到 `127.0.0.1`（仅本地访问）。要从局域网中的其他机器访问仪表盘/API，使用 `HOST_BIND=0.0.0.0 docker compose up -d` 在所有接口上发布 — 请仅在可信局域网中使用，因为代理是单用户的。

SQLite 数据存储在 `freellmapi-data` 卷的 `/app/server/data` 路径下。升级时请保持相同的 `.env` 中的 `ENCRYPTION_KEY` 和数据卷，因为供应商密钥是加密存储的。

更多 Docker 操作和示例请参见 [docker/README.md](./docker/README.md)。

## 桌面应用

原生菜单栏应用位于 [`desktop/`](./desktop) 目录：完整的路由器 + 仪表盘从系统托盘本地运行，带有毛玻璃弹出窗口显示实时请求统计。

![FreeLLMAPI desktop app](repo-assets/desktop.png)

没有发布二进制文件 — 从本仓库构建只需几分钟：

```bash
npm install
npm run desktop:dist        # macOS: desktop/dist-electron/FreeLLMAPI-…-arm64.dmg
npm run desktop:dist:win    # Windows 安装包
```

> **Windows：** 构建配置已就绪但尚未测试 — 如果你尝试了，在 issue 中反馈一下（能用或不能用都行）将不胜感激。

本地构建的应用启动时不会触发 Gatekeeper / SmartScreen 警告 — 不涉及代码签名。完整说明请参见 [desktop/README.md](./desktop/README.md)。

## 使用 API

任何 OpenAI 兼容客户端都可以使用。示例：

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # 让路由器选择；或指定例如 "gemini-2.5-flash"
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

**curl**

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

**流式输出**

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream me a haiku about SQLite."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

**工具调用**

传入 OpenAI 风格的 `tools` 和 `tool_choice`；assistant 的响应会完全按照 OpenAI API 的方式通过代理往返传递。多步流程（assistant `tool_calls` → `tool` 角色后续 → 最终回答）可在路由器能访问的每个供应商上工作。

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

# 1. 模型请求工具调用
first = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What's the weather in Karachi?"}],
    tools=tools,
    tool_choice="required",
)
call = first.choices[0].message.tool_calls[0]

# 2. 你执行工具，将结果回传
final = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "What's the weather in Karachi?"},
        first.choices[0].message,
        {"role": "tool", "tool_call_id": call.id, "content": '{"temp_c": 32, "cond": "sunny"}'},
    ],
    tools=tools,
)
print(final.choices[0].message.content)
```

**视觉 / 图像输入**

使用标准 OpenAI 的 `image_url` 内容块发送图像（base64 `data:` URL 或 `http(s)` URL）。当请求包含图像时，路由器会限制为仅使用**支持视觉的模型**，并忽略纯文本模型。视觉模型在 Fallback Chain 页面上标有 **Vision** 徽章；当前集合包括 Gemini（2.5 / 3.x）、Llama 4 Scout/Maverick（Groq、NVIDIA、SambaNova）和 GitHub 的 GPT-4o / GPT-4.1。

```python
resp = client.chat.completions.create(
    model="auto",  # 自动路由到视觉模型
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}},
        ],
    }],
)
print(resp.choices[0].message.content)
```

如果没有启用的视觉模型，图像请求会返回明确的 `422` 错误（`code: "no_vision_model"`），而不是静默丢弃图像。（`/v1/responses` 上的图像输入尚未支持 — 请使用 `/v1/chat/completions`。）

同样支持 `stream=True` — 你会收到 `delta.tool_calls` 块，随后是 `finish_reason: "tool_calls"` 的结束标记。在底层，OpenAI 兼容的供应商（Groq、Cerebras、SambaNova、Mistral、OpenRouter、GitHub Models、HuggingFace、Cloudflare、Cohere compat）会透传请求；Gemini 请求会被转换为 Google 的 `functionDeclarations` / `functionResponse` 格式，响应再转换回来。

每个响应都携带 `X-Routed-Via: <platform>/<model>` 头，让你可以看到实际是哪个供应商服务了该请求。如果请求在供应商之间发生了故障转移，你还会看到 `X-Fallback-Attempts: N`。

### 向量嵌入

`/v1/embeddings` 兼容 OpenAI 格式，但与聊天路由有一个关键区别：**故障转移从不跨模型。** 不同模型生成的向量存在于不兼容的空间中 — 静默切换模型会破坏基于代理构建的任何向量存储。因此嵌入按**族**（一个模型标识 + 维度）路由，故障转移仅在提供同族的供应商之间进行。

```python
resp = client.embeddings.create(
    model="auto",          # 默认族；或指定族名如 "bge-m3"
    input=["the quick brown fox", "pack my box with five dozen liquor jugs"],
)
print(len(resp.data), "vectors of", len(resp.data[0].embedding), "dims")
```

```bash
curl http://localhost:3001/v1/embeddings \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "input": "hello world"}'
```

`model` 接受 `auto`（配置的默认族）、族名或供应商特定的模型 ID（会解析为其所属族）。可用族：

| 族（`model`） | 维度 | 供应商（故障转移顺序） |
| --- | --- | --- |
| `gemini-embedding-001` *（默认）* | 3072 | Google |
| `text-embedding-3-large` | 3072 | GitHub Models |
| `text-embedding-3-small` | 1536 | GitHub Models |
| `embed-v4.0` | 1536 | Cohere |
| `bge-m3` | 1024 | Cloudflare → Hugging Face |
| `qwen3-embedding-0.6b` | 1024 | Cloudflare |
| `nv-embedqa-e5-v5` | 1024 | NVIDIA |
| `llama-nemotron-embed-1b-v2` | 2048 | NVIDIA |
| `llama-nemotron-embed-vl-1b-v2` | 2048 | NVIDIA → OpenRouter |
| `embeddinggemma-300m` | 768 | Cloudflare |

默认族、按供应商的开关和优先级设置在仪表盘的 **Models → Embeddings** 页面。选择一个族并在该向量存储中坚持使用 — 这就是族模型的核心意义。

## 截图

### Keys

管理供应商凭证并获取你的应用连接用的统一 API 密钥。每个密钥显示一个状态点和上次健康检查时间。

![Keys page](repo-assets/keys.png)

### Playground

通过路由器发送聊天补全请求，查看哪个供应商处理了它，以及模型 ID 和延迟信息直接显示在消息上。

![Playground page](repo-assets/playground.png)

### Analytics

请求量、成功率、输入输出 token 数、平均延迟，以及按 24 小时 / 7 天 / 30 天窗口的各供应商统计明细。

![Analytics page](repo-assets/analytics.png)

## 工作原理

```
┌──────────────────┐   Bearer freellmapi-…   ┌─────────────────────────┐
│  OpenAI SDK /    │ ──────────────────────▶ │  Express proxy (:3001)  │
│  curl / any      │ ◀────────────────────── │  /v1/chat/completions   │
│  OpenAI client   │      streamed tokens    └────────────┬────────────┘
└──────────────────┘                                      │
                                                          ▼
                             ┌────────────────────────────────────────────────┐
                             │  Router                                        │
                             │   1. Pick highest-priority model that          │
                             │      (a) has a healthy key and                 │
                             │      (b) is under all its rate limits.         │
                             │   2. Decrypt key, call provider SDK.           │
                             │   3. On 429/5xx → cooldown + retry next model. │
                             └────────────────────────────────────────────────┘
                                          │
   ┌──────────────┬────────────┬──────────┴─────────┬─────────────┬──────────┐
   ▼              ▼            ▼                    ▼             ▼          ▼
 Google         Groq        Cerebras           OpenRouter        HF       …10 more
```

- **路由器**（`server/src/services/router.ts`）— 为每个请求选择模型。
- **限流账本**（`server/src/services/ratelimit.ts`）— 基于 SQLite 支持的内存 RPM/RPD/TPM/TPD 计数器，带有 429 冷却机制。
- **供应商适配器**（`server/src/providers/*.ts`）— 每个供应商一个文件，实现 `Provider` 基类：`chatCompletion()` 和 `streamChatCompletion()`。
- **健康检查服务**（`server/src/services/health.ts`）— 定期探测保持密钥状态最新。
- **仪表盘**（`client/`）— React + Vite + shadcn/ui 管理界面。
- **存储** — SQLite（`better-sqlite3`）配合 AES-256-GCM 信封加密密钥。

## 局限性

叠加免费额度确实有实际的取舍。请对此保持清醒认识：

- **没有前沿模型。** 免费额度目录的顶配大约是 Llama 3.3 70B、GLM-4.5、Qwen 3 Coder 和 Gemini 2.5 Pro。你不会通过这个获得 GPT-5 或 Claude Opus 级别的推理能力。遇到难题，请付费使用真正的 API。
- **智能水平随时间推移而下降。** 你排名靠前的模型（通常是 Gemini 2.5 Pro、通过 GitHub Models 的 GPT-4o）每日配额最低。一旦达到限制，路由器会沿优先链向下回退到更小/更弱的模型。预期 endpoint 的有效智能水平会在每天晚些时候下降 — 然后在 UTC 午夜重置。
- **延迟变化很大。** Cerebras 和 Groq 非常快；其他的则不一定。你只能用当前可用的那个。
- **免费额度可能随时变更。** 供应商经常收紧、放宽或取消免费额度。发生这种情况时你会看到 429 或认证错误，直到更新目录。重新填充脚本在 `server/src/scripts/` 中。
- **没有 SLA，这是显而易见的。** 如果你需要可靠性，请使用有合同的付费供应商。
- **本地优先。** 没有多租户认证。为自己运行它；不要暴露到互联网上。

## 贡献

非常欢迎贡献者！适合首次贡献的 PR：

- **添加供应商** — 复制 `server/src/providers/openai-compat.ts` 作为模板，接入 `server/src/providers/index.ts`，在 `server/src/db/index.ts` 中填充模型，在 `server/src/__tests__/providers/` 中添加测试。
- **添加 endpoint** — 图像、内容审核、音频。Provider 基类可以扩展新方法；适配器声明它们支持哪些。
- **改进路由器** — 成本感知路由（最便宜-健康-最快的权衡）、更好的延迟加权优先级、区域固定。
- **仪表盘打磨** — Analytics 页面的图表、密钥轮换 UX、从 `.env` 批量导入密钥。
- **文档** — 更多示例、Go/Rust 等语言的客户端代码片段、Docker 或 Fly 的部署方案。

**开发流程：**

```bash
npm install
npm run dev      # 服务器在 :3001，仪表盘在 :5173，均支持 HMR
npm test         # 服务器 vitest；如果工作区添加了客户端测试也会运行
npm run build    # 编译服务器和仪表盘
```

PR 应包含测试，保持现有测试套件通过，并符合仓库中已有的 `.editorconfig` / tsconfig 默认设置。Issues 和讨论区开放。

### 贡献者

<a href="https://github.com/moaaz12-web"><img src="https://images.weserv.nl/?url=github.com/moaaz12-web.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@moaaz12-web" /></a>
<a href="https://github.com/lukasulc"><img src="https://images.weserv.nl/?url=github.com/lukasulc.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@lukasulc" /></a>
<a href="https://github.com/VinhPhamAI"><img src="https://images.weserv.nl/?url=github.com/VinhPhamAI.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@VinhPhamAI" /></a>
<a href="https://github.com/deadc"><img src="https://images.weserv.nl/?url=github.com/deadc.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@deadc" /></a>
<a href="https://github.com/zhangyu1324"><img src="https://images.weserv.nl/?url=github.com/zhangyu1324.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@zhangyu1324" /></a>
<a href="https://github.com/Tazrif-Raim"><img src="https://images.weserv.nl/?url=github.com/Tazrif-Raim.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tazrif-Raim" /></a>
<a href="https://github.com/hodlmybeer69-bit"><img src="https://images.weserv.nl/?url=github.com/hodlmybeer69-bit.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@hodlmybeer69-bit" /></a>
<a href="https://github.com/phoenixikkifullstack"><img src="https://images.weserv.nl/?url=github.com/phoenixikkifullstack.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@phoenixikkifullstack" /></a>
<a href="https://github.com/jtbrennan-git"><img src="https://images.weserv.nl/?url=github.com/jtbrennan-git.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@jtbrennan-git" /></a>
<a href="https://github.com/praveenkumarpranjal"><img src="https://images.weserv.nl/?url=github.com/praveenkumarpranjal.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@praveenkumarpranjal" /></a>
<a href="https://github.com/nordbyte"><img src="https://images.weserv.nl/?url=github.com/nordbyte.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@nordbyte" /></a>
<a href="https://github.com/mybropro"><img src="https://images.weserv.nl/?url=github.com/mybropro.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@mybropro" /></a>
<a href="https://github.com/danscMax"><img src="https://images.weserv.nl/?url=github.com/danscMax.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@danscMax" /></a>
<a href="https://github.com/jhash"><img src="https://images.weserv.nl/?url=github.com/jhash.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@jhash" /></a>
<a href="https://github.com/JammyJames1234"><img src="https://images.weserv.nl/?url=github.com/JammyJames1234.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@JammyJames1234" /></a>
<a href="https://github.com/Sumit4codes"><img src="https://images.weserv.nl/?url=github.com/Sumit4codes.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Sumit4codes" /></a>
<a href="https://github.com/meliani"><img src="https://images.weserv.nl/?url=github.com/meliani.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@meliani" /></a>
<a href="https://github.com/thedavidweng"><img src="https://images.weserv.nl/?url=github.com/thedavidweng.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@thedavidweng" /></a>
<a href="https://github.com/bharvey42"><img src="https://images.weserv.nl/?url=github.com/bharvey42.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@bharvey42" /></a>
<a href="https://github.com/yuvrxj-afk"><img src="https://images.weserv.nl/?url=github.com/yuvrxj-afk.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@yuvrxj-afk" /></a>
<a href="https://github.com/Tushar49"><img src="https://images.weserv.nl/?url=github.com/Tushar49.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tushar49" /></a>
<a href="https://github.com/nicyoong"><img src="https://images.weserv.nl/?url=github.com/nicyoong.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@nicyoong" /></a>
<a href="https://github.com/Aldo-f"><img src="https://images.weserv.nl/?url=github.com/Aldo-f.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Aldo-f" /></a>
<a href="https://github.com/Tazrif-Raim"><img src="https://images.weserv.nl/?url=github.com/Tazrif-Raim.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tazrif-Raim" /></a>
<a href="https://github.com/m1nuzz"><img src="https://images.weserv.nl/?url=github.com/m1nuzz.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@m1nuzz" /></a>
<a href="https://github.com/LoneRifle"><img src="https://images.weserv.nl/?url=github.com/LoneRifle.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@LoneRifle" /></a>
<a href="https://github.com/ita333"><img src="https://images.weserv.nl/?url=github.com/ita333.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@ita333" /></a>

## 服务条款审查

针对每个供应商的 ToS 对自托管、单用户、个人使用的设置进行了重新审查（2026 年 5 月）。摘要：

| 供应商 | 结论 | 备注 |
|---|---|---|
| Google Gemini | ⚠️ 需谨慎 | 2026 年 3 月 ToS 将范围缩窄为*"专业或商业用途，不用于消费用途"* — 自托管的开发者代理仍然可以说得通，但该条款是新的。 |
| Groq | ✅ 大致可以 | GroqCloud 服务协议允许客户应用集成。 |
| Cerebras | ✅ 大致可以 | 允许；明确禁止出售/转让 API 密钥。 |
| Mistral | ✅ 大致可以 | API 允许个人/内部商业使用。 |
| OpenRouter | ✅ 大致可以 | 2026 年 4 月 ToS 加强了禁止转售 / 禁止竞争服务的条款；私人的单用户代理仍然没问题。 |
| SambaNova | ⚠️ 存在歧义 | EULA §1.5(c) 禁止转售和"服务局"使用；单用户且无第三方访问是可以的。 |
| Cloudflare Workers AI | ⚠️ 存在歧义 | 没有反代理条款；受通用自助订阅协议约束。 |
| NVIDIA NIM | ⚠️ 需谨慎 | 试用 ToS §1.2 / §1.4：*"仅限评估，非生产用途。"* 默认目录中已禁用。 |
| GitHub Models | ⚠️ 需谨慎 | 免费额度明确限定为*"实验"* 和*"原型设计"。* |
| Cohere | ❌ 不建议 | 条款 §14 仍然禁止*"个人、家庭或家庭用途。"* |
| Zhipu（open.bigmodel.cn） | ✅ 大致可以 | 平台文档中仍有个人/非商业研究豁免条款。 |
| Z.ai（api.z.ai） | ⚠️ 需谨慎 | 新增 — 新加坡实体（与智谱 CN 不同）。§III.3(l) 反流量重定向条款可能被解读为针对代理；没有明确的个人使用豁免。 |
| Ollama Cloud | ✅ 大致可以 | 新增 — 免费计划允许云模型访问（1 个并发，5 小时会话上限）。未发现反代理/反转售条款。*（集成跟踪在 #14。）* |

让大多数供应商满意的经验法则：**每个供应商一个账户**、**不转售**、**不与他人共享你的 endpoint**、**不要把免费额度当作付费生产后端来猛刷**。这是信息参考，不是法律建议 — 请阅读每个供应商的 ToS 并自行判断。

自 2026 年 4 月审查以来的移除：Hugging Face、Moonshot 和 MiniMax 的直接集成已从目录中移除（HF — 工具调用格式问题；Moonshot — 已转为付费；MiniMax — 被 OpenRouter 的 `minimax/minimax-m2.5:free` 路由取代）。

## 免责声明

**本项目用于个人实验和学习，不适用于生产环境。** 免费额度的存在是为了让开发者能够进行原型开发；它们不是稳定的、受支持的推理基础设施，不应被视为如此。如果你在 FreeLLMAPI 之上构建了真正的产品，请在发布前切换到付费 API。你与每个上游供应商的关系受你在创建账户时接受的服务条款约束 — 这些条款在流量通过本项目代理时仍然适用，你有责任遵守它们。

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=tashfeenahmed/freellmapi&type=date&legend=top-left)](https://www.star-history.com/?repos=tashfeenahmed%2Ffreellmapi&type=date&legend=top-left)

## 许可证

[MIT](./LICENSE)
