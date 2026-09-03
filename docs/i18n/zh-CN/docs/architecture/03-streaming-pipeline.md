[English](../../../../architecture/03-streaming-pipeline.md) · **简体中文**

# 流式管线 —— 深度剖析

> **源码：** `server/src/routes/proxy.ts`、`server/src/routes/responses.ts`、`server/src/routes/anthropic.ts`、`server/src/lib/fallback-loop.ts`

## 1. 设计原则

- **纯 SSE** —— 零 WebSocket。每个面（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、旧版 `/completions`）都经 Server-Sent Events 流式。
- **轮次完整性** —— 流作为**轮次**校验，不是传输。头部拿到首个真实载荷前保留；在此之前挂掉的隐式回退。
- **流中回退** —— 错误帧在头部刷出前到达则可重试；刷出后则诚实浮出（stream_error）。
- **统一回退循环** —— 所有面共享 `lib/fallback-loop.ts` 做重试预算、冷却、尝试轨迹、耗尽渲染。

---

## 2. OpenAI Chat Completions (`/v1/chat/completions`)

### 请求流

```
解析 + 校验 (zod)
  ├─ 压缩（可选，X-FreeLLM-Compress）
  ├─ 系统提示词注入（配置档强制）
  ├─ 图片降采样 (normalizeMessageImages)
  ├─ 词元估算（chars/4 启发式）
  ├─ 视觉/工具闸门（无能模型则 422）
  ├─ 词元预算护栏 (request_max_tokens_budget)
  ├─ 响应缓存检查（可选、精确匹配 LRU）
  ├─ 粘性会话 / 上下文交接
  ├─ 解析路由链（auto / 固定 / 组）
  └─ runFallbackLoop()
        ├─ route() → 选模型+密钥
        ├─ dispatch() → streamChatCompletion()
        ├─ 成功 → recordUpstreamSuccess()、记日志、缓存存入
        ├─ 可重试失败 → recordRetryableFailure()、冷却、skipKeys、下一个
        ├─ 致命 → onFatal() (502)
        └─ 耗尽 → exhaustedRetryError() → onExhausted() (429/502/413/404/503)
```

### 流式泵 (`proxy.ts` 行 ~1873–2150)

**每尝试状态机：**

```
mode = 'undecided' | 'passthrough' | 'dialect'
heldText = ''
preamble = []          // 角色/保活块，持有到模式定夺
toolCallAcc = Map<index, {id, name, args}>
ttfbMs = null          // 任意类型的首词元（内容或推理）
headerSent = false
```

**逐块：**

1. **元数据捕获**：`upstreamModel`（首个带 `model` 字段的帧）、`lastMeta`（id/created/model，供我们分帧用）。
2. **带内错误帧**（`{error:..., choices: undefined}`）：
   - 头部前：抛出 → 回退
   - 头部后：写错误帧 + `[DONE]` → `committed`
3. **用量帧**：落在哪捕哪（无 choice 或最后一个 choice 上），我们的结束块后重发一次。
4. **推理累积**（#764）：`streamReasoningText()` 提取 `reasoning_content` / `reasoning`；加入 `streamReasoning` 供会话记忆 + 词元核算。
5. **工具调用增量**：缓冲在 `toolCallAcc`，末尾对请求 schema 修参数。
6. **内容文本**：`streamChunkText()` 提取 `delta.content`。
7. **TTFB**（#764）：在**任意类型首词元**（内容**或**推理）上记录。
8. **模式裁决**：
   - `undecided` + `wantsTools` + `startsWithDialectMarker(heldText)` → `dialect`（全缓冲）
   - `undecided` + `!wantsTools` OR `!couldBecomeDialectMarker` OR `heldText > 256` → `passthrough`，刷头部、流式转发
   - `passthrough` → 即时转发（从 delta 剥 tool_calls，末尾补全重发）
   - `dialect` → 继续缓冲
9. **空块**（角色/保活/仅推理）：攒在 `preamble` 等刷新。

**流正常结束：**

1. 组装缓冲工具调用 → `repairToolArguments()` 对请求 schema。
2. `dialect` 模式：`rescueInlineToolCalls(heldText)` → 结构化 `tool_calls` 或回退。
3. 发完整工具调用（单块、`finish_reason: 'tool_calls'`）。
4. 发最终块（`finish_reason: 'stop' | 'length' | upstreamFinish`）。
5. 发捕获的用量帧。
6. `recordUpstreamSuccess()`、`logRequest()`、`observeServedModel()`、适用时存入缓存。

**流中错误：**

- 头部前：抛出 → 回退（下一模型）
- 头部后：写 `stream_error` 帧 + `[DONE]` → `committed`（循环停，不再回退）

### 词元核算（流式）

- **输出词元**：`ceil((text.length + reasoning.length) / 4)` 每块——推理词元是真实消耗（#764）。
- **TTFB**：到首个内容**或**推理词元的挂钟。
- **非流对账**：提供方的 `usage` 块覆盖估算。

---

## 3. Anthropic Messages (`/v1/messages`)

### 翻译层 (`routes/anthropic.ts`)

| Anthropic | OpenAI (内部) |
|-----------|-------------------|
| `messages[]`（无 system 角色） | `system` + `messages[]` |
| content 里的 `tool_use` 块 | `tool_calls` 数组 |
| `tool_result` 块 | `tool` 消息 |
| `stop_reason: 'tool_use'` | `finish_reason: 'tool_calls'` |
| `thinking` budget/type | `reasoning_effort` / `max_completion_tokens` |

**流式**：上游 OpenAI SSE → 逐块翻译成 Anthropic SSE 事件（`message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`）。tool-use 块渲染成结构化 `tool_use` 内容块，不是内联文本。

### 错误映射（耗尽）

| FreeLLM 类别 | Anthropic 类型 |
|--------------|----------------|
| `auth` | `api_error` |
| `bad_request` | `invalid_request_error` |
| `rate_limit` | `overloaded_error` (429) |
| `unavailable` | `overloaded_error` (503) |
| `context_too_large` | `request_too_large` |
| `model_not_found` | `not_found_error` |
| `upstream` | `api_error` |

---

## 4. Gemini (`/v1beta` 经由 `/v1/chat/completions`)

### 请求翻译 (`providers/gemini.ts`)

- **基于 part 的内容**：`content: [{text:...}, {inline_data:...}, {function_call:...}]`
- **系统提示词**：注入为首个 `user` 轮，`role: 'user'` + `parts: [{text: system}]`，再一个 `model` 确认（Gemini 要求角色交替）。
- **工具调用**：`function_call` parts → 转发时变 OpenAI `tool_calls`；`function_response` parts ← OpenAI `tool` 消息。
- **结构化输出**：`response_format: json_schema` → Gemini 原生 `responseSchema` + `responseMimeType: 'application/json'`。
- **Thinking**：`thinking_config: {thinking_budget: N}` 从 `reasoning_effort` / `max_completion_tokens` 来。

### 流式

- 原生 Gemini SSE → `base.ts` `streamChatCompletion()` 里归一化成 OpenAI 块形状。
- 内联工具调用方言（文本里的 `function_call`）被同一方言探测器救回。
- `thought_signature` 随工具调用保留（#13）。

---

## 5. Responses API 适配 (`/v1/responses`)

> **源码：** `server/src/routes/responses.ts`

### 目的

Codex CLI 和 Agents SDK 说 **Responses API**（有状态、`previous_response_id` 链式）。适配层双向翻译到/自 chat completions，这样同一套路由/额度/回退机制服务两者。

### 翻译

| Responses API | Chat Completions |
|---------------|------------------|
| `input`（字符串或数组） | `messages[]` |
| `previous_response_id` | 粘性会话（sessionId = response_id） |
| `tools`（function + `type: 'function'`） | `tools` + `tool_choice` |
| `text.format` (json_schema) | `response_format: json_schema` |
| `reasoning` (effort/summary) | `reasoning_effort` + `max_completion_tokens` |
| `stream: true` | 带工具调用的加法式 `_fusion` 帧的 SSE |

### 流式

- 即刻开 SSE。
- 工具调用作为加法式 `_fusion` 帧发（无 `choices`，标准客户端跳过） → 最终答案作为正常内容增量流出。
- 非流响应上有 `response.output_text` 便利字段。

### 回退

- 共享 `runFallbackLoop()` —— 同重试预算、冷却、尝试轨迹。
- 耗尽渲染映射到 Responses API 错误形状。

---

## 6. 旧版 Completions (`/v1/completions`)

共享回退循环上的薄适配器：

- `prompt` + `suffix` → chat 消息（system: "code autocomplete engine", user: prefix/suffix）。
- 响应：`text_completion` 形状（choices[0].text）。
- 流式：`legacyCompletionChunk()` 包装上游块。
- 同提交点逻辑：头部拿到首文本前保留；推理词元计数（#764）。

---

## 7. Fusion 虚拟模型 (`model: "fusion"`)

> **源码：** `server/src/services/fusion.ts`

- 把提示词**并行扇给多样模型面板**（视觉/工具按成员过滤）。
- **裁判模型**综合出一个答案。
- 每个子调用走**正常路径**（冷却、额度、分析）。
- 流式：面板/裁判事件的加法式 `_fusion` 帧，再裁判的综合作为正常内容增量。
- 非流：裁判输出上的结构化输出强制（#516）。
- 回退：面板成员在各自链内回退；裁判失败 → 回退到面板最佳。

---

## 8. 流中错误处理

| 场景 | 头部前 | 头部后 |
|----------|----------------|---------------|
| 带内 `{error}` 帧 | 抛出 → 回退 | 写错误帧 + `[DONE]` → `committed` |
| 客户端断开 | `clientGone` → 中止在途、不停用 | `clientGone` → 停拉取、`committed` |
| 对冲中止（预算过期） | `abortInFlight()` → `HedgeAbortError` → 循环停、`timedOut` 耗尽 | 同 |
| 空补全（无文本、无工具） | 抛出 `empty completion` → 回退 | N/A（早刷头部了） |
| 上游分类输出 ("safe"/"unsafe") | 抛出 → 回退 (a961d93) | N/A |
| 探测到工具方言 | 缓冲 → 末尾救回或回退 | N/A |

---

## 9. 每个响应都发的头部

| 头部 | 值 |
|--------|-------|
| `X-Request-ID` | UUID（或客户端 `x-request-id`） |
| `X-Routed-Via` | `platform/model` (safeHeaderValue) |
| `X-Fallback-Attempts` | 成功/耗尽前的失败跳数 |
| `X-Fallback-Trail` | `platform/model keyN=class; …`（最多 10，1KB） |
| `X-Fallback-Detail` | **可选**：`platform/model keyN=outcome t=start+dur msg=summary; …`（2KB） |
| `Retry-After` | 到最近冷却过期的秒数（429 耗尽） |
| `X-FreeLLM-Cache` | `HIT` / `MISS`（响应缓存） |
| `X-FreeLLM-Compress` | 压缩管线元数据 |

---

## 10. 关键函数 (proxy.ts)

| 函数 | 用途 |
|----------|---------|
| `runFallbackLoop(hooks)` | 共享尝试循环（见 04-degraded-mode） |
| `streamChunkText(chunk)` | 提取 `delta.content`（容忍无 choices 帧） |
| `streamReasoningText(chunk)` | 提取 `delta.reasoning_content` / `delta.reasoning` |
| `restoreSessionReasoning(messages, reasoning, platform)` | #797：回放客户端剥离的思考轨迹 |
| `rememberReasoning(sessionKey, modelKey, reasoning)` | 按会话存轨迹 |
| `rescueInlineToolCalls(text, tools)` | 内联方言 → 结构化 `tool_calls` |
| `repairToolArguments(args, schemas)` | 对请求 schema 修双重编码 JSON |
| `truncateMessagesForGithub(messages)` | 裁历史到 GitHub Models 输入天花板 |
| `normalizeOutboundContent(chunk)` | 提供方专属响应归一化 |
| `sanitizeResponse(chunk)` | 从流式帧脱敏机密 |

---

## 11. 并发与取消

- **客户端断开**：`res.on('close')` → `clientGone = true`、`clientAbort.abort()` → 在途取获取消、租约即刻释放。
- **对冲**（1d2226a）：`hedgeAbort` 控制器，挂钟预算中途过期时调 `abortInFlight()`。`HedgeAbortError` 是**非提供方健康** → 无冷却/惩罚、渲染 `timedOut` 耗尽。
- **租约释放**：`dispatch()` 的 `finally` 块里，幂等。在 `RouteResult` 上可选，这样 `finally` 里的 `TypeError` 不能替换上游错误。

---

## 12. 压缩管线（可选）

`X-FreeLLM-Compress` 头 → `compressRequest(messages, {header, tools, cacheControlPrefixLength})` → 返回压缩后消息 + 缓存键。引擎：`lite`、`jsoncompact`、`dedup`、`aging`、`relevance`、`hard-budget`、`filter-definitions`、`custom-filters`、`toolfilter`、`read-lifecycle`。缓存键含 `compression.cacheKey`，不同压缩等级永不碰撞。

---

## 13. 响应缓存（可选）

- **范围**：仅非流、可缓存温度（`temperature ≤ 1` 或未设）、`X-FreeLLM-Cache: on` 或 `RESPONSE_CACHE=1`。
- **键**：规范化请求（模型、消息、所有采样参数、工具、stop、response_format、n、seed、惩罚、logit_bias、logprobs、top_logprobs、reasoning_effort、压缩）的 SHA-256。
- **存储**：内存 LRU、TTL + 温度闸门。
- **命中**：返回缓存体、`X-Routed-Via: cache`、`X-FreeLLM-Cache: HIT`，**零提供方额度消耗**。