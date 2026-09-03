[English](../../../../api/01-rest-api.md) · **简体中文**

# API 参考

[← 返回 README](../README.md) · [文档索引](../README.md)

任何兼容 OpenAI 的客户端都能用（Anthropic / Claude 客户端也可以，见 [Anthropic 与 Claude 客户端](#anthropic-与-claude-客户端)）。Base URL 为 `http://localhost:3001/v1`，统一密钥在仪表盘的密钥页获取。`GET /v1/docs` 提供一个覆盖所有代理端点的交互式 OpenAPI 浏览器；规范文件本身在 `GET /v1/openapi.json`。

- [聊天补全](#聊天补全)
- [路由策略 `auto:*`](#路由策略-auto)
- [流式输出](#流式输出)
- [工具调用](#工具调用)
- [Gemini 的 Google 搜索接地](#gemini-的-google-搜索接地)
- [原生 Gemini API](#原生-gemini-api)
- [Ollama 模拟](#ollama-模拟)
- [可撤销的 URL 令牌](#可撤销的-url-令牌)
- [视觉与图像输入](#视觉与图像输入)
- [图像生成与文本转语音](#图像生成与文本转语音)
- [Fusion 多模型合成](#fusion-多模型合成)
- [响应头](#响应头)
- [嵌入](#嵌入)
- [Anthropic 与 Claude 客户端](#anthropic-与-claude-客户端)

## 聊天补全

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # 交给路由器挑选；也可以指定具体模型，例如 "gemini-2.5-flash"
    messages=[{"role": "user", "content": "用一句话概括罗马的衰亡。"}],
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

## 路由策略 `auto:*`

单写 `auto` 会走你当前生效的回退链。加个后缀可以只影响这一次请求，不用改仪表盘：

- `auto:smart` —— 偏向智能评分最高的模型
- `auto:fast` —— 偏向实测速度（吞吐和首字节时间）
- `auto:cheap` —— 偏向省钱；目前和 `balanced` 是同一套权重（池子里的东西本来就都是免费的）
- `auto:reliable` —— 偏向近期成功率
- `auto:balanced` —— 默认权重（稳定性优先，速度和智能分摊剩下的部分）

这些策略会对 **所有已启用的模型** 重新排序，忽略你的链路顺序。常见的同义写法也能识别（`auto:fastest`、`auto:speed`、`auto:smartest`、`auto:cheapest`、`auto:budget` 等等），整个模型字符串不区分大小写。

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto:fast",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

`auto:<配置档名>` 会走某个具名配置档的链路，而不是当前生效的那条，这样不同工具可以通过同一把密钥使用不同的链路：

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto:coding",
    "messages": [{"role": "user", "content": "Write a binary search in Rust."}]
  }'
```

配置档名写错会返回一个明确的 `400`，而不是悄悄退回默认行为。配置档就是具名的回退链（见 [功能](../README.md#功能)），在仪表盘里创建和切换；当前生效的那条就是单写 `auto` 会用的。

## 流式输出

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream me a haiku about SQLite."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

## 工具调用

传入 OpenAI 风格的 `tools` 和 `tool_choice`，助手的响应会原样经代理往返，和直连 OpenAI API 一模一样。多步流程（助手发出 `tool_calls` → 以 `tool` 角色回填结果 → 最终答案）在路由器能触达的每一家提供方上都能跑通。

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

# 1. 模型请求调用工具
first = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What's the weather in Karachi?"}],
    tools=tools,
    tool_choice="required",
)
call = first.choices[0].message.tool_calls[0]

# 2. 你执行工具，把结果回填进去
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

配合 `stream=True` 也可以，你会先收到一串 `delta.tool_calls` 分块，然后是一个 `finish_reason: "tool_calls"` 收尾。底层实现上，兼容 OpenAI 的提供方（Groq、Cerebras、Mistral、OpenRouter、GitHub Models、HuggingFace、Cloudflare、Cohere 兼容模式）会直接透传请求；发往 Gemini 的请求会被翻译成 Google 的 `functionDeclarations` / `functionResponse` 结构，响应再翻译回来。

## Gemini 的 Google 搜索接地

Google 的模型可以把答案锚定在实时的 Google 搜索结果上。由于 OpenAI 的协议格式没法表达这件事，你可以请求一个名为 `google_search` 的工具，Google 提供方会把它翻译成 Gemini 原生的接地工具。它可以单独发送，也可以和你正常的函数工具一起发送。

```python
resp = client.chat.completions.create(
    model="gemini-2.5-flash",  # 固定到某个 Google 模型，让请求路由到那里
    messages=[{"role": "user", "content": "Who won the F1 race this weekend?"}],
    tools=[{"type": "function", "function": {"name": "google_search", "parameters": {}}}],
)
print(resp.choices[0].message.content)
```

## 原生 Gemini API

Gemini 系列 SDK 和 Gemini CLI 可以使用原生的 `/v1beta` 接口：

- `GET /v1beta/models`
- `GET /v1beta/models/{model}`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent`（Gemini CLI 需要加 `?alt=sse`）
- `POST /v1beta/models/{model}:countTokens`

```bash
curl "http://localhost:3001/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
```

像 `gemini-2.5-flash` 这样的 Gemini 模型名，是通过 Gemini 系列映射（密钥 → Gemini 模型映射）解析的，而不是直接查目录，所以它们会路由到 Auto，或者路由到你为每个系列固定的那个目录模型。直接写目录里的 id 也一样能用。

`contents` 里的文本、内联数据、函数调用与响应、系统指令、函数声明、结构化 JSON 输出、生成控制参数和思考额度，都会翻译进同一套内部的聊天与回退流程。Bearer 认证同样可用。Gemini 的 `?key=` 查询参数只在 `/v1beta` 下被接受；建议优先用请求头，因为写在 URL 里的凭据会泄漏到历史记录和日志中。

## Ollama 模拟

这个需要主动开启的 Ollama 接口，在 `/api/*` 下实现了 tags、chat、generate、show、version、embed 以及旧版 embeddings。流式输出是 Ollama 兼容的 NDJSON。它默认为 `off`，可以在 **密钥 → 智能体** 里选择 `open-loopback` 或 `key-required`。open-loopback 模式会检查直连的套接字对端，所以桌面端的局域网访问不会在你不知情的情况下把它变成一个无身份验证的局域网端点。

`/api/embeddings` 这个路径同时也归仪表盘所有。带着有效仪表盘会话的请求会交给仪表盘处理；其他所有打到这个确切路径的请求都被当作 Ollama 的旧版 embeddings，按上面的模拟策略处理。

## 可撤销的 URL 令牌

无法发送请求头的客户端，可以在 `/v1/t/{token}/…` 下访问模型列表、聊天补全、Responses，以及 Ollama 风格的 chat 和 tags。这些令牌是随机生成的，只以哈希形式存储，可以单独撤销，并且不是那把统一密钥。在 **密钥 → 智能体** 里创建和撤销它们。

即便如此也请把它们当作敏感信息：URL 常常会被 shell 历史、反向代理、浏览器历史和遥测数据留存下来。撤销是立即生效的。

## 视觉与图像输入

用标准的 OpenAI `image_url` 内容块发送图片（base64 的 `data:` URL 或者 `http(s)` URL 都行）。当请求里含有图片时，路由器会把自己限制在 **具备视觉能力的模型** 上，忽略纯文本模型。视觉模型在回退链页面上带有 **Vision** 标记；当前这批包括 Gemini（2.5 / 3.x）、Llama 4 Scout/Maverick（Groq、NVIDIA）、GLM-4.6V Flash（Z.ai）、Nemotron Nano 12B VL（OpenRouter），以及 GitHub 的 GPT-4o / GPT-4.1。

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

如果你的回退链里没有启用任何具备视觉能力的模型，带图片的请求会返回一个明确的 `422`（`code: "no_vision_model"`），而不是悄悄把图片丢掉。（`/v1/responses` 上的图像输入目前还不支持，请改用 `/v1/chat/completions`。）

## 图像生成与文本转语音

`POST /v1/images/generations` 和 `POST /v1/audio/speech` 会在提供媒体模型的提供方之间路由，也包括自定义的 OpenAI 兼容媒体端点。可以在仪表盘的 **模型 → 图像 / 音频** 标签页里浏览和开关它们。

## Fusion 多模型合成

请求虚拟模型 `fusion`，路由器会把你的提示词并行分发给一组风格各异的免费模型，再由一个评审模型从这些草稿中合成出一个答案。参与的模型组、评审模型和策略都可以在仪表盘的 **Fusion** 页配置，也可以按请求通过 `fusion` 字段指定；每一次子调用都会正常走路由、额度和分析统计。

## 响应头

每个响应都带一个 `X-Routed-Via: <平台>/<模型>` 头，你可以据此看出每次调用实际是哪家提供方处理的。如果请求在提供方之间转移过，还会看到 `X-Fallback-Attempts: N`。

HTTP 头只能携带可打印的 ASCII 字符，所以模型 id 里超出这个范围的字符（比如中转目录里的中文名称）在响应头中会被百分号编码。把这个值丢给 `decodeURIComponent`（或 `urllib.parse.unquote`）就能还原。

可选开启的响应缓存能按请求用 `X-FreeLLM-Cache: on|off` 开关。它是一个针对完全相同的非流式请求做精确匹配的内存 LRU（以整个请求的规范化 SHA-256 为键，带 TTL 和温度门槛，节省量统计显示在仪表盘上）。默认关闭；缓存命中不消耗任何提供方额度。

启用[提示词压缩](../compression/01-compression-pipeline.md)后，`X-FreeLLM-Compress: off|on|lossless|standard|aggressive` 可以对单次请求关闭或调低已配置的模式，但不能高于运维方配置的模式。响应会报告实际生效的模式和预估节省量，例如 `X-FreeLLM-Compress: standard; saved~=1840`。

## 嵌入

`/v1/embeddings` 兼容 OpenAI，但和聊天路由有一处刻意的区别：**故障转移绝不跨模型。** 不同模型产出的向量位于互不兼容的空间里，悄悄换个模型会污染建立在这个代理之上的任何向量库。所以嵌入是按 **系列**（一个模型身份加一个维度）路由的，故障转移只在服务于同一系列的提供方之间进行。

```python
resp = client.embeddings.create(
    model="auto",          # 默认系列；也可以写系列名，比如 "bge-m3"
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

`model` 接受 `auto`（配置好的默认系列）、某个系列名，或者某家提供方专属的模型 id（会解析到它所属的系列）。可用的系列：

| 系列（`model`） | 维度 | 提供方（故障转移顺序） |
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

默认系列、各提供方的开关和优先级都在仪表盘的 **模型 → 嵌入** 页。为某个向量库选定一个系列之后就别再换了，这正是「系列」这个设计存在的意义。

## Anthropic 与 Claude 客户端

FreeLLMAPI 同样会讲 Anthropic 的 Messages API，所以任何为 Claude 写的东西，包括 **Claude Code** 和官方 Anthropic SDK，都能跑在你的免费池上。把客户端指向你服务器的 **根地址**（Anthropic 客户端会自己拼上 `/v1/messages`），用统一密钥认证即可。`x-api-key` 和 `Authorization: Bearer` 两种方式都接受。

```bash
curl http://localhost:3001/v1/messages \
  -H "x-api-key: freellmapi-your-unified-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

Claude 的模型名在 **密钥 → Anthropic** 标签页里映射到你的免费池：每个系列（`default`、`opus`、`sonnet`、`haiku`）可以路由到 `auto`（由路由器挑一个免费模型），也可以固定到你指定的模型。`POST /v1/messages/count_tokens` 和一个按内容协商的 `GET /v1/models`（发送了 `anthropic-version` 时返回 Anthropic 的结构）也都实现了。流式、系统提示词、工具使用和图像输入，都经由和 OpenAI 端点相同的那套路由翻译。

**Claude Code** —— 把它指向你的服务器再启动：

*在 macOS / Linux 上（Bash）：*
```bash
export ANTHROPIC_BASE_URL=http://localhost:3001
export ANTHROPIC_AUTH_TOKEN=freellmapi-your-unified-key   # 不是 ANTHROPIC_API_KEY
claude
```

*在 Windows 上（PowerShell）：*
```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:3001"
$env:ANTHROPIC_AUTH_TOKEN="freellmapi-your-unified-key"
claude
```

> 请用 `ANTHROPIC_AUTH_TOKEN`（作为 Bearer 令牌发送），**不要**用 `ANTHROPIC_API_KEY`。Claude Code 会把已设置的 `ANTHROPIC_API_KEY` 当成互相冲突的第一方凭据，从而拒绝启动。
