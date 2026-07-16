# 一、背景知识

## 业务背景

freellmapi 是一个免费 LLM API 代理，将多个免费 LLM provider 聚合到统一的 OpenAI 兼容端点后。Claude Code 和 `@anthropic-ai/sdk` 客户端使用 Anthropic Messages API 格式，但 freellmapi 目前只有 OpenAI 格式的端点。需要新增 `/v1/messages` 端点以服务 Anthropic 生态的客户端。

## 技术背景

- **现有端点**：`POST /v1/chat/completions`、`GET /v1/models`、`POST /v1/embeddings`
- **Provider 架构**：`BaseProvider` 抽象类定义 `chatCompletion()` 和 `streamChatCompletion()` 方法，12 个 provider 全部实现 OpenAI 兼容格式（Google 和 Cohere 有自己的翻译层）
- **路由**：`routeRequest()` (services/router.ts) 是协议无关的 — 基于 token 估算和模型元数据选择模型
- **流式处理**：proxy.ts 中有复杂的 OpenAI SSE chunks 处理逻辑（turn-integrity 校验、dialect rescue）
- **认证**：已支持 `x-api-key` header（proxy.ts:51-57），Anthropic 客户端直接可用
- **共享类型**：`shared/types.ts` 定义以 OpenAI Chat Completions API 为蓝本的类型

## 现有知识沉淀

- `server/src/routes/proxy.ts` (1118 行) — 完整 OpenAI 代理实现
- `server/src/providers/base.ts` — BaseProvider 抽象类
- `shared/types.ts` — OpenAI 兼容类型定义
- `@anthropic-ai/sdk@0.111.0` — 官方 SDK，提供 Messages API 类型和 SSE 解析

# 二、名词解释

| 业务语言 | 技术自然语言 | 技术代码语言 |
|---|---|---|
| Anthropic 消息 | Messages API 的请求消息，role 只有 user/assistant，content 总是数组 | `AnthropicMessageParam` (来自 SDK) |
| Content Block | Anthropic 消息中的内容单元 | `ContentBlock` — TextBlock / ToolUseBlock / ImageBlock 等 |
| tool_use | Anthropic 工具调用，作为 content block 出现 | `ToolUseBlock: {type:"tool_use", id, name, input}` |
| tool_result | Anthropic 工具结果，在 user 消息的 content 中 | `{type:"tool_result", tool_use_id, content}` |
| SSE 生命周期 | Anthropic 流式事件的 start→delta*→stop 模型 | `message_start` → `content_block_start` → `content_block_delta`* → `content_block_stop` → `message_delta` → `message_stop` |
| 协议适配器 | Anthropic ↔ OpenAI 的双向转换层 | `server/src/lib/anthropic-adapter.ts` |
| 流式适配器 | OpenAI SSE chunks → Anthropic SSE events 的状态机 | `server/src/lib/anthropic-stream.ts` |
| 双协议 | 内部同时支持 Anthropic 和 OpenAI 两种请求/响应格式 | BaseProvider 新增 `messages()` / `streamMessages()` |

# 三、业务流程设计（纵向）

## 系统相关现状

现有 `/v1/chat/completions` 请求流程：

```
Client → POST /v1/chat/completions
  → extractApiToken() 认证
  → Zod 验证 (chatCompletionSchema)
  → 消息规范化 (tool calls 修复、空内容处理)
  → routeRequest() 模型选择
  → provider.chatCompletion() 或 provider.streamChatCompletion()
  → 响应处理（流式 turn-integrity、dialect rescue）
  → 返回 OpenAI 格式
```

### 领域划分

- **路由领域** (services/router.ts)：模型选择、rate limiting、cooldown — **协议无关，无需修改**
- **认证领域** (proxy.ts extractApiToken)：已支持 `x-api-key` — **提取为共享函数即可**
- **端点领域** (routes/proxy.ts)：OpenAI 格式请求处理 — **保持原样**
- **Provider 领域** (providers/)：与远端通信 — **扩展 BaseProvider 接口**
- **适配器领域** (新增)：协议转换 — **全新模块**

### 数据结构设计

**新增 Anthropic 类型层**（`shared/anthropic-types.ts`）：

```
AnthropicMessageRequest {
  model: string
  messages: AnthropicMessageParam[]
  system?: string | ContentBlock[]
  max_tokens: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: { user_id?: string }
  stream?: boolean
}

AnthropicMessage {
  id: string
  type: "message"
  role: "assistant"
  content: ContentBlock[]
  model: string
  stop_reason: StopReason | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number }
}

// 流式事件 (7 种类型)
AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
```

**BaseProvider 接口扩展**（修改 `providers/base.ts`）：

```typescript
// 新增的参数类型
interface MessagesOptions {
  model: string
  messages: AnthropicMessageParam[]
  system?: string | ContentBlock[]
  max_tokens: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: { user_id?: string }
}

// 新增方法
abstract messages(apiKey: string, options: MessagesOptions): Promise<AnthropicMessage>
abstract streamMessages(apiKey: string, options: MessagesOptions): AsyncGenerator<AnthropicStreamEvent>
```

## 本次新增改动

### 领域划分变更

- **新增**“协议适配”领域：`lib/anthropic-adapter.ts` + `lib/anthropic-stream.ts`，负责 Anthropic ↔ OpenAI 转换
- **新增**“Anthropic 端点”领域：`routes/anthropic.ts`
- **修改** Provider 领域：BaseProvider 添加双协议方法

### 数据结构变更

- **新增** `shared/anthropic-types.ts` — 无 DB 表变更
- **新增** `MessagesOptions` 参数类型（provider base.ts 中定义）
- **修改** `BaseProvider` 抽象类 — 添加 2 个方法签名

### 对外接口定义

#### `POST /v1/messages`

**正常流程：**
```
Client → POST /v1/messages
  ├── 1. extractApiToken() — 认证 (x-api-key + Bearer token)
  ├── 2. Zod 验证 — 验证请求结构
  │     ├── model: string (optional, 默认 "auto")
  │     ├── messages: AnthropicMessageParam[] (min 1)
  │     ├── max_tokens: number (must > 0)
  │     ├── system?: string | ContentBlock[]
  │     ├── temperature?: number (0-2)
  │     ├── top_p?: number (0-1)
  │     ├── top_k?: number
  │     ├── stop_sequences?: string[]
  │     ├── tools?: AnthropicTool[]
  │     ├── tool_choice?: AnthropicToolChoice
  │     ├── metadata?: object
  │     └── stream?: boolean
  ├── 3. 图像检测 — 检查消息是否包含 image content block
  ├── 4. 工具检测 — 检查是否有 tools 参数
  ├── 5. Token 估算 — 遍历消息估算 input tokens
  ├── 6. routeRequest() — 共享路由选择模型
  ├── 7. provider.messages() — 调用 provider
  │     └── 默认适配器:
  │         ├── anthropicToOpenAI() — 请求转换
  │         ├── chatCompletion() — 现有 OpenAI 调用
  │         └── openAIToAnthropicResponse() — 响应转换
  └── 8. 返回 AnthropicMessage
```

**流式流程：**
```
  ...
  └── 7. provider.streamMessages()
        └── 默认适配器:
            ├── anthropicToOpenAI()
            ├── streamChatCompletion() — 现有 OpenAI 流式调用
            └── OpenAIChunksToAnthropicEvents — 状态机驱动的事件生成器
                ├── 缓冲 role delta + 首个 text
                ├── 发出 message_start
                ├── 发出 content_block_start (text/tool_use)
                ├── 发出 content_block_delta (text_delta/input_json_delta)
                ├── 发出 content_block_stop
                ├── 合并 tool_call 参数（从 delta 拼接）
                ├── 发出 message_delta (stop_reason + usage)
                └── 发出 message_stop
```

**异常处理：**
| 错误场景 | HTTP Status | 错误类型 | 行为 |
|---|---|---|---|
| 缺少 `x-api-key` | 401 | `authentication_error` | 立即返回 |
| 缺少 `max_tokens` | 400 | `invalid_request_error` | 立即返回 |
| messages 为空 | 400 | `invalid_request_error` | 立即返回 |
| 图片消息但无 vision 模型 | 422 | `invalid_request_error` | 立即返回，code=`no_vision_model` |
| 工具请求但无 tools 模型 | 422 | `invalid_request_error` | 立即返回，code=`no_tools_model` |
| 所有模型 rate-limited | 429 | `rate_limit_error` | 遍历所有 fallback 后返回 |
| Provider 错误 (非重试) | 502 | `provider_error` | 立即返回 |
| 流式中断 (header 未发) | 内部重试 | — | fallback 到下一个模型 |
| 流式中断 (header 已发) | — | — | 发送 error 事件结束流 |
| 空完成 | 内部重试 | — | retryable error, fallback |

# 四、技术实现设计（横向）

## 共享层 (shared/)

### `shared/anthropic-types.ts`

从 `@anthropic-ai/sdk` 的 type declarations 中导出和重新组织需要的类型：

- `AnthropicMessageParam` — 请求消息类型
- `AnthropicContentBlock` — 响应中的 content block
- `AnthropicContentBlockParam` — 请求中的 content block
- `AnthropicTool` — 工具定义
- `AnthropicToolChoice` — 工具选择策略
- `AnthropicMessage` — 完整响应
- `AnthropicStopReason` — `'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'`
- `AnthropicStreamEvent` 及其子类型 — 流式事件

直接 re-export SDK 类型，避免重复定义和版本不同步。只在需扩展的字段（如自定义元数据）上添加 wrapper。

## 适配器层 (server/src/lib/)

### `anthropic-adapter.ts` — 非流式转换

```typescript
// 核心函数签名
anthropicToOpenAI(params: MessagesOptions): { messages: ChatMessage[]; options: CompletionOptions }
openAIToAnthropicResponse(result: ChatCompletionResponse, model: string): AnthropicMessage
```

**`anthropicToOpenAI` 转换逻辑：**
1. system 字段 → 插入 `ChatMessage {role:"system", content}` 到 messages 头部
2. `AnthropicMessageParam[]` → `ChatMessage[]`:
   - user + text content → `{role:"user", content: string}`
   - user + image content → `{role:"user", content: ChatContentBlock[]}`
   - user + tool_result → `{role:"tool", content, tool_call_id}`
   - assistant + text → `{role:"assistant", content: string}`
   - assistant + tool_use → `{role:"assistant", content: null, tool_calls: [...]}`
3. tools → 添加 `type:"function"` wrapper
4. tool_choice: `{type:"auto"}` → `"auto"`, `{type:"any"}` → `"required"`, `{type:"tool", name}` → `{type:"function", function:{name}}`

**`openAIToAnthropicResponse` 转换逻辑：**
1. `choices[0].message.content` → `content: [{type:"text", text}]` (null → 空 text block)
2. `choices[0].message.tool_calls` → `content: [{type:"tool_use", id, name, input}]`
3. `finish_reason` 映射：`"stop"` → `"end_turn"`, `"tool_calls"` → `"tool_use"`, `"length"` → `"max_tokens"`
4. `usage` 映射：`prompt_tokens` → `input_tokens`, `completion_tokens` → `output_tokens`

### `anthropic-stream.ts` — 流式适配器

```typescript
async function* openAIChunksToAnthropicEvents(
  chunks: AsyncGenerator<ChatCompletionChunk>,
  model: string,
  estimatedInputTokens: number,
): AsyncGenerator<AnthropicStreamEvent>
```

**状态机设计：**

```
        ┌──────────┐
        │  INIT    │
        └────┬─────┘
             │ first meaningful chunk
             ▼
        ┌──────────────┐
        │ MESSAGE_START │ ─── emit message_start event
        └──────┬───────┘
               │
          ┌────▼────┐
          │ BLOCK   │ ← for each content block
          │ START   │ ─── emit content_block_start
          └────┬────┘
               │
          ┌────▼────┐
          │ DELTA   │ ─── emit content_block_delta (可能多次)
          └────┬────┘
               │ terminal condition met
          ┌────▼────┐
          │ BLOCK   │ ─── emit content_block_stop
          │ STOP    │
          └────┬────┘
               │ more blocks?
               │  yes → back to BLOCK START
               │  no  → ▼
          ┌──────────────┐
          │ MESSAGE_DELTA │ ─── emit message_delta
          └──────┬───────┘
                 │
          ┌──────▼───────┐
          │ MESSAGE_STOP  │ ─── emit message_stop
          └──────────────┘
```

**关键实现逻辑：**

1. **Role delta 缓冲**：OpenAI 的第一个 chunk 通常只有 `delta.role`。缓冲这些 preamble chunks，在第一个 text content 出现时先发 `message_start` → `content_block_start` → 然后处理第一个 content。

2. **Text block 生命周期**：每当 `delta.content` 有内容时，如果这是 block 的第一个 delta，先发 `content_block_start` (type: "text")。后续 text delta 发 `content_block_delta` (type: "text_delta")。当下一个 chunk 包含 tool_calls 或 finish_reason 时，发当前 block 的 `content_block_stop`。

3. **Tool use block 生命周期**：OpenAI 的 tool_calls delta 分散在多个 chunk 中（index → id → function.name → function.arguments）。使用 `Map<number, ToolCallAccumulator>` 缓冲。当 tool_call 的参数完整时（检测到下一个 tool_call index 或 finish_reason），发完整的 tool_use block：
   - `content_block_start` (type: "tool_use", id, name)
   - 一个或多个 `content_block_delta` (type: "input_json_delta")
   - `content_block_stop`

4. **空完成检测**：如果流结束但没有任何 text 和 tool_use，抛出 `"empty completion"` 错误（在 headers 发送前触发 fallback）。

5. **错误处理**：
   - 在 `message_start` 发出之前：抛出错误，由端点层的 retry loop 处理
   - 在 `message_start` 之后：发出 `{type:"error", error:{...}}` 事件，结束流

## 端点层 (server/src/routes/)

### `anthropic.ts` — `/v1/messages` 端点

文件结构与 proxy.ts 中 `/chat/completions` 的逻辑镜像：

```typescript
export const anthropicRouter = Router();

anthropicRouter.post('/messages', async (req, res) => {
  // 1. 认证
  const token = extractApiToken(req);  // 从 proxy.ts 导入的共享函数
  // 2. 验证 anthropic-version header (日志警告，不阻塞)
  // 3. Zod 验证请求体
  // 4. 图像/工具检测
  // 5. Token 估算
  // 6. routeRequest() — 共享路由
  // 7. 重试循环
  //   ├── stream: provider.streamMessages() → SSE 转发
  //   └── non-stream: provider.messages() → JSON 响应
  // 8. 错误处理
});
```

**与 proxy.ts 的代码共享：**
- `extractApiToken()` — 从 proxy.ts 导出，在 anthropic.ts 中导入
- `timingSafeStringEqual()` — 同上
- token 估算逻辑 — 提取为 `lib/content.ts` 中的 `estimateTokens()`
- sticky session 逻辑 — 直接 import
- context handoff — 暂时跳过 Anthropic 端点（system 字段差异需要单独设计）

## Provider 层 (server/src/providers/)

### `base.ts` — BaseProvider 扩展

```typescript
// 新增方法
async messages(apiKey: string, options: MessagesOptions): Promise<AnthropicMessage> {
  const { messages, options: completionOpts } = anthropicToOpenAI(options);
  const result = await this.chatCompletion(apiKey, messages, options.model, completionOpts);
  return openAIToAnthropicResponse(result, options.model);
}

async *streamMessages(apiKey: string, options: MessagesOptions): AsyncGenerator<AnthropicStreamEvent> {
  const { messages, options: completionOpts } = anthropicToOpenAI(options);
  const chunks = this.streamChatCompletion(apiKey, messages, options.model, completionOpts);
  yield* openAIChunksToAnthropicEvents(chunks, options.model, estimatedInputTokens);
}
```

默认实现使用 `async` 方法体（非 abstract）以允许子类不需修改即获得 Anthropic 支持。方法可以被覆盖以实现真正的 Anthropic-native 通信。

## 路由注册 (server/src/app.ts)

```
app.use('/v1', createProxyRateLimiter());  // 现有
app.use('/v1', proxyRouter);               // existing — /chat/completions, /models, /embeddings
app.use('/v1', responsesRouter);           // existing — Responses API
app.use('/v1', anthropicRouter);           // NEW — /messages
```

# 五、风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 流式适配器状态机 bug（事件顺序错误） | Claude Code 端 UI 异常或崩溃 | 使用 Anthropic SDK 参考实现作为基准；先测纯文本、再测 tool use、最后多 tool_use |
| 不同 provider 的 OpenAI SSE 实现差异 | 部分 provider 的 tool_calls delta 格式不标准 | 复用 proxy.ts 已有的容错逻辑（tool_call 参数修复、ID 合成）；适配器接受 `tool_calls: undefined` 的情况 |
| `max_tokens` 默认值不当 | Claude Code 明确设置 `max_tokens`，但其他客户端可能不传 | 默认值设为 4096，在端点层要求必须 >0 |
| Context handoff 与 Anthropic system 字段冲突 | handoff 当前通过 system message 注入 | Phase 1 跳过 Anthropic 端点的 handoff，标记为后续议题 |
| 性能开销 | 协议转换增加每个请求的延迟 | 转换是纯内存操作，开销可忽略（<1ms）；流式适配器的 buffering 可能增加首字节延迟 |

# 六、技术决策记录

| 决策 | 选择 | 备选方案 | 取舍依据 | 关联 Requirement |
|---|---|---|---|---|
| 内部 Anthropic 类型来源 | 从 `@anthropic-ai/sdk` re-export | 自行定义所有类型 | SDK 类型与 API 同步更新，避免维护成本。SDK 已是项目依赖。 | 所有 |
| BaseProvider 扩展方式 | 在基类添加带默认实现的 `messages()`/`streamMessages()` | 单独 `AnthropicCompatibleProvider` 接口 | 默认实现使所有现有 provider 零修改兼容。未来 Anthropic-native provider 覆盖即可。 | provider-dual-protocol |
| 流式适配器实现 | 自定义状态机（AsyncGenerator） | 使用 `@anthropic-ai/sdk` 的 Stream 类 | SDK Stream 类与 HTTP client 紧耦合，无法注入已有 OpenAI chunks。自定义状态机更灵活。 | anthropic-streaming |
| Protocol 转换位置 | 在 BaseProvider 默认实现中 | 在端点层 (routes/anthropic.ts) | Provider 层转换使未来 Anthropic-native provider 可以绕过适配器。端点层保持纯粹。 | message-translation |
| Context handoff for Anthropic | Phase 1 跳过 | 直接实现 | system 字段差异需要额外设计，不应阻塞核心端点功能 | anthropic-endpoint |
| 错误格式 | Anthropic API error format (`{type:"error", error:{type, message}}`) | 复用 OpenAI error format | Claude Code 解析 Anthropic 格式的错误，返回 OpenAI 格式会导致不可预期的行为 | anthropic-endpoint |

# 七、迁移 / 灰度 / 回滚方案

**迁移**：纯新增功能，不涉及数据迁移。`npm install` 后自动生效。

**灰度**：无需灰度。新端点不影响现有 OpenAI 端点。

**回滚**：如果 Anthropic 端点有问题：
1. 在 `app.ts` 中注释掉 `app.use('/v1', anthropicRouter)` 一行
2. 或在 `anthropicRouter` 中添加 feature flag 检查
3. 所有现有 OpenAI 端点不受影响

# 八、测试与验证方案

**单元测试：**
- `server/src/__tests__/lib/anthropic-adapter.test.ts`：覆盖所有消息类型转换场景（文本、工具调用、工具结果、图片、system prompt、边界情况）
- `server/src/__tests__/lib/anthropic-stream.test.ts`：覆盖流式状态机的所有路径（纯文本、带 tool_use、多 tool_use、空完成、流中断、混合内容）
- `server/src/__tests__/routes/anthropic.test.ts`：端点级别测试（认证、请求验证、路由、错误响应）
- `server/src/__tests__/providers/anthropic-default-impl.test.ts`：验证 BaseProvider 默认实现正确工作

**集成测试：**
- 在 `server/src/__tests__/routes/anthropic.test.ts` 中 mock provider 做端到端测试
- 验证 `/v1/messages` 返回的响应能被 `@anthropic-ai/sdk` 的 client 正确解析

**回归测试：**
- 运行所有现有测试 (`npm test`)，确认零失败
- 确认 `/v1/chat/completions` 行为不变

**验收验证：**
- 使用 Claude Code 配置 `apiKey` 指向 freellmapi，进行完整的代码编辑任务
- 验证多轮对话、工具调用、流式输出均正常

# 九、Knowledge 回写计划

无可新增或更新的 knowledge 文档。

# 十、开放问题

- **Q1**: Claude Code 发送的 `anthropic-beta` header 中通常包含哪些 feature flag？是否需要根据这些 flag 调整行为？
  - 初始实现：忽略 beta header，只记录日志
- **Q2**: `cache_control` 的 ephemeral caching — 是否需要保证下游 provider 也支持？不支持时如何处理？
  - 初始实现：忽略 `cache_control` 标记，不报错
- **Q3**: 是否需要 `/v1/messages/count_tokens` 端点？
  - 初始实现：不需要，Claude Code 不使用 token counting

# 十一、阶段自检

- [x] 设计没有引入 proposal/specs 未声明的新需求
- [x] 每个关键设计决策都有依据和备选方案说明
- [x] 涉及接口、数据结构、依赖、迁移和回滚的内容已写清
- [x] 测试与验证方案能覆盖 specs 中的关键 Scenario
- [x] 设计足以拆分为原子任务
- [x] 未写入具体实现代码
