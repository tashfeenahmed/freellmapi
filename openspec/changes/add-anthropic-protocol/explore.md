## 1. 输入需求与原始上下文

- **原始需求**：实现 Anthropic 协议支持。让代理服务器在现有 OpenAI 兼容协议（`/v1/chat/completions`）之外，同时原生支持 Anthropic Messages API 协议（`/v1/messages`）。
- **需求来源**：用户直接提出，目标客户端是 Claude Code。
- **目标用户**：使用 Claude Code、Claude 官方 SDK（`@anthropic-ai/sdk`）或任何基于 Anthropic Messages API 的 Agent 框架的开发者。这些用户通过配置自定义 API endpoint，将请求路由到 freellmapi，复用现有的免费模型 fallback 链。
- **工程背景**：
  - 项目当前只暴露 OpenAI 兼容端点（`/v1/chat/completions`、`/v1/models`、`/v1/embeddings`），所有 provider 都对接 OpenAI 格式。
  - 但认证层已经支持 Anthropic 风格的 `x-api-key` header（`server/src/routes/proxy.ts:47-58`），注释中提到了 "CC Switch" 路由场景。说明项目维护者已经意识到 Anthropic 客户端的接入需求。
  - `@anthropic-ai/sdk` 提供完整 Messages API 类型和 SSE 流式解析逻辑，可直接作为类型基础。

## 2. 业务目标与成功标准

**为什么做**：Claude Code 是开发者最活跃的 AI 编程助手之一，它使用 Anthropic Messages API 格式。目前 freellmapi 无法直接服务 Claude Code 客户端，因为：
- Claude Code 发送 `POST /v1/messages` 请求，而不是 `/v1/chat/completions`
- 消息格式完全不同（content block 模型 vs 字段模型）
- 流式事件类型完全不同（结构化生命周期 vs 简单 delta）

**成功标准**：
1. Claude Code 配置 freellmapi 为 custom provider 后，能正常进行多轮对话
2. 工具调用（tool_use + tool_result）在中转后正常工作
3. 流式响应格式符合 Anthropic SSE 规范
4. 现有所有 OpenAI 模型路由、fallback、rate limiting 逻辑复用生效
5. 现有 OpenAI 端点不受影响（回归测试全通过）

## 3. 当前工程职责边界

**纳入范围：**
- 新增 `POST /v1/messages` 端点，接受 Anthropic Messages API 格式请求
- Anthropic 请求/响应的类型定义
- Anthropic ↔ OpenAI 消息格式的双向转换逻辑
- OpenAI SSE chunks → Anthropic SSE events 的流式适配
- BaseProvider 接口扩展，添加 `messages()` / `streamMessages()` 方法
- 复用现有路由、fallback、rate limiting、sticky session 逻辑
- `@anthropic-ai/sdk` 作为类型和流式解析依赖

**不纳入范围：**
- 添加 Anthropic 作为后端 provider（Anthropic API 无免费 tier，本项目的核心定位是免费模型代理）
- Anthropic Console、Anthropic Agents API 或 Sessions API 支持
- 双向协议转换（OpenAI 请求不会转成 Anthropic 格式返回）
- Anthropic Batches API 支持

## 4. 现状调研与证据

### 4.1 现有模块与入口

| 模块 | 文件 | 角色 |
|------|------|------|
| 应用入口 | `server/src/app.ts` | 注册所有路由中间件，第 79 行注册 `/v1` 代理路由 |
| API 代理路由 | `server/src/routes/proxy.ts` | `/v1/chat/completions`（第 470 行）、`/v1/models`、`/v1/embeddings` |
| 共享类型 | `shared/types.ts` | 定义 `ChatMessage`、`ChatCompletionRequest`、`ChatCompletionResponse` 等 OpenAI 兼容类型 |
| Provider 基类 | `server/src/providers/base.ts` | `BaseProvider` 抽象类，定义 `chatCompletion()` 和 `streamChatCompletion()` |
| Provider 注册 | `server/src/providers/index.ts` | 注册 12 个 provider（Google、Groq、Cerebras 等） |
| 路由引擎 | `server/src/services/router.ts` | `routeRequest()` 选择模型、管理 fallback、cooldown |
| 流式处理 | `server/src/routes/proxy.ts` (第 762-982 行) | OpenAI SSE chunks 的缓冲、解析、错误处理 |
| 认证 | `server/src/routes/proxy.ts` (第 34-59 行) | `extractApiToken()` 已支持 `x-api-key` header |
| 内容工具 | `server/src/lib/content.ts` | `contentToString()`、`messageHasImage()` 等 |

### 4.2 上下游与依赖

- **上游**：Claude Code、`@anthropic-ai/sdk` 客户端 → 发送 Anthropic Messages API 格式请求
- **下游**：12 个 provider（全部为 OpenAI 兼容格式或自有格式如 Gemini/Cohere）
- **关键依赖**：`@anthropic-ai/sdk@0.111.0` 提供 Anthropic 类型定义，可复用 `ContentBlock`、`MessageParam`、`RawMessageStreamEvent` 等类型。SDK 的 `Stream.fromSSEResponse()` 和 `_iterSSEMessages()` 提供 SSE 解析。

### 4.3 现有行为与约束

- **认证**：已经支持 `Authorization: Bearer <key>` 和 `x-api-key` 两种认证头（proxy.ts:51-57），Anthropic 客户端立即可用。
- **路由**：`routeRequest()` 是基于 token 估算和模型元数据的协议无关函数，无需修改即可用于 Anthropic 请求。
- **Sticky session**：基于 `sessionKey`（首次用户消息 hash），协议无关，可直接复用。
- **Context handoff**：通过注入 system message 实现上下文字段交接，当前操作 OpenAI `ChatMessage` 数组，需适配 Anthropic 的 `system` 顶层字段。
- **Rate limiting**：完全独立于协议，可直接复用。
- **工具调用格式差异**：OpenAI 将 tool_calls 作为 message 的独立字段，Anthropic 将 tool_use 作为 content block。这是转换层的主要挑战。
- **System prompt 差异**：OpenAI 将 system 放在 `messages[0]`（role="system"），Anthropic 使用顶层 `system` 字段。支持 Anthropic 后内部需要有两种表示方式。

## 5. 改动点拆解

### 5.1 必做改动点

1. **添加依赖** — `server/package.json` 添加 `@anthropic-ai/sdk`
2. **Anthropic 类型定义** — `shared/anthropic-types.ts`：定义内部 Anthropic 原生类型（Message、ContentBlock、StreamEvent 等）
3. **协议转换器** — `server/src/lib/anthropic-adapter.ts`：
   - `anthropicToOpenAI()` — Anthropic 请求消息转 OpenAI 格式
   - `openAIToAnthropicResponse()` — OpenAI 响应转 Anthropic 格式
   - `openAIChunksToAnthropicEvents()` — OpenAI SSE chunks 生成 Anthropic SSE events
4. **BaseProvider 扩展** — `server/src/providers/base.ts`：添加 `messages()` 和 `streamMessages()` 抽象方法及默认适配器实现
5. **新端点** — `server/src/routes/anthropic.ts`：`POST /v1/messages` 端点，解析 Anthropic 格式、路由、调用 provider、返回 Anthropic 格式
6. **路由注册** — `server/src/app.ts`：在 `/v1` 路径下注册 Anthropic 路由
7. **共享提取** — `server/src/routes/proxy.ts`：提取认证和 token 估算逻辑为共享工具函数

### 5.2 可选 / 后续改动点

- Anthropic-native provider（直接在 provider 层发 Anthropic 格式，绕过适配器）
- `anthropic-beta` header 驱动的功能开关（如 extended thinking）
- `cache_control` prompt caching 支持
- 双向 adapt（OpenAI → Anthropic provider，当前不需要）
- Anthropic 格式的 `/v1/models` 端点多样性

## 6. 追踪关系草案

| 业务目标 | 改动点 | 候选 Capability | 证据 | 状态 |
|---|---|---|---|---|
| Claude Code 能连接代理 | `/v1/messages` 端点 | `anthropic-endpoint` | Claude Code 文档确认使用 `/v1/messages` | 已确认 |
| 多轮对话正常 | 协议转换器 | `message-translation` | proxy.ts 已有完整的 OpenAI 格式消息处理 | 已确认 |
| 工具调用正常 | tool_use ↔ tool_calls 转换 | `anthropic-tool-support` | proxy.ts:639-649 已有工具路由逻辑 | 已确认 |
| 流式输出正确 | Anthropic SSE 事件生成 | `anthropic-streaming` | Anthropic SDK streaming.ts 提供 SSE 解析参考 | 已确认 |
| 复用现有路由 | BaseProvider 扩展 | `provider-dual-protocol` | router.ts routeRequest() 协议无关 | 已确认 |
| 不影响现有功能 | 在 `ChatMessage` 外新增独立类型 | `backward-compat` | 现有代码不改 `ChatMessage` 定义 | 已确认 |

## 7. 风险、未知项与待确认问题

**已知风险：**

1. **流式适配器复杂度** — Anthropic SSE 的 content_block 生命周期模型（start → delta (xN) → stop）比 OpenAI 的增量模型复杂。从 OpenAI chunks 重建这个生命周期需要在适配器中维护状态机。如果上游 provider 输出行为异常（如缺少 tool_calls 的 finish_reason），适配器需要正确处理。

2. **Context handoff 与 Anthropic system 字段** — 当前 context handoff 通过向 messages 数组注入 system message 实现，但 Anthropic 的 system 是顶层字段。需要特殊处理以保持行为一致。

3. **工具调用 ID 一致性** — Anthropic 使用 `tool_use_id` 匹配 tool_use 和 tool_result，而 OpenAI 使用 `tool_call_id`。转换层必须正确保持 ID 的映射关系（尤其是多 tool_use 的场景）。

4. **OpenAI Compat Provider 行为差异** — 不同 provider 对 OpenAI 协议的实现完整度不同，特别是 tool_calls delta 格式、finish_reason 时机。适配器需要处理宽松模式（类似 proxy.ts 已有的容错逻辑）。

5. **`max_tokens` 必填** — Anthropic 协议要求 `max_tokens` 必须指定且 > 0。需要在端点层提供合理的默认值（如 4096），因为 Claude Code 总是显式传入此字段。

## 8. Knowledge 使用情况

**已参考的 Knowledge 文档：**
- 无外部 knowledge 文档配置

**Knowledge 证据记录：**
- Source: `@anthropic-ai/sdk@0.111.0` package — 类型定义文件 `resources/messages/messages.d.ts`
- Evidence: `ContentBlock`、`ContentBlockParam`、`TextBlock`、`ToolUseBlock`、`RawMessageStreamEvent`、`StopReason` 等类型
- 结论属性: 知识证据支持

- Source: `server/src/routes/proxy.ts` — 全量代码（1118 行）
- Evidence: 完整 OpenAI 格式处理流、流式 turn-integrity、认证逻辑、路由集成
- 结论属性: 代码推断

- Source: `server/src/providers/base.ts` — BaseProvider 抽象类
- Evidence: 当前只有 OpenAI 格式方法，需扩展
- 结论属性: 代码推断

**当前是否足够支撑后续阶段：** 是

**说明：** 所有关键模块已在探索中阅读和分析完毕。Anthropic SDK 的类型系统提供了充分的类型参考。现有代理路由的代码质量高，提供了清晰的扩展点。

## 9. Knowledge 缺口与回写预估

**疑似缺失或过期的 Knowledge：**
- Anthropic Messages API 最新规范（当前基于 SDK v0.111.0 推断，SDK 版本与 API 版本紧密绑定）

**本次预计需要新增或更新的 Knowledge：**
- `@anthropic-ai/sdk` 类型定义（已在探索中读取）

**Knowledge 写回建议：**
- 无需新增 knowledge 文档

## 10. Capability 候选草案

### 新增 Capabilities
- `anthropic-endpoint`: 新增 `POST /v1/messages` 端点，接受、验证和响应 Anthropic Messages API 请求
- `message-translation`: 双向协议转换 — Anthropic 消息 ↔ 内部表示 ↔ OpenAI 消息
- `anthropic-streaming`: OpenAI SSE chunks → Anthropic SSE events 的流式事件生成器
- `provider-dual-protocol`: BaseProvider 扩展支持双协议，默认适配器使用现有 `chatCompletion`/`streamChatCompletion`

### 修改 Capabilities
- 无现有 capability 需要修改（所有新增均为独立模块）

## 11. 阶段自检

- [x] 已明确本工程纳入范围和不纳入范围
- [x] 每个关键结论都有证据或标记为推断
- [x] 已列出进入 proposal 前必须确认的问题
- [x] 已给出业务目标到 capability 候选的追踪关系
- [x] 未写入具体实现方案或代码级任务
