## 1. 需求摘要

当前 freellmapi 只暴露 OpenAI 兼容的 `/v1/chat/completions` 端点，无法直接服务使用 Anthropic Messages API 的客户端（如 Claude Code、`@anthropic-ai/sdk`）。虽然认证层已支持 `x-api-key` header，但没有 `/v1/messages` 端点，客户端无法接入。

**机会**：Anthropic 生态的开发者工具（尤其是 Claude Code）是增长最快的 AI 编程助手之一。支持 Anthropic 协议不需要新增后端 provider — 只需要在协议层做适配，复用现有的 12 个 provider 和完整的路由、fallback、rate limiting 基础设施。

**为什么现在做**：项目认证层已有 Anthropic 风格的 header 支持（proxy.ts 注释中的 "CC Switch" 用例），说明实际需求已验证。实现协议端点是最直接的下一步。

## 2. 当前工程范围与边界

**纳入范围：**
- 新增 `POST /v1/messages` 端点，完全兼容 Anthropic Messages API
- 独立、可维护的 Anthropic ↔ OpenAI 协议转换层
- BaseProvider 双协议接口扩展
- 流式适配器：OpenAI SSE chunks → Anthropic SSE events
- 所有现有路由、fallback、rate limiting、sticky session 对 Anthropic 请求生效
- 所有现有 provider 通过适配器自动支持 Anthropic 请求
- `@anthropic-ai/sdk` 作为类型和 SSE 解析依赖

**不纳入范围：**
- 添加 Anthropic API 作为后端 provider
- Anthropic Agents API、Sessions API、Batches API 支持
- OpenAI → Anthropic 方向转换（OpenAI 端点继续只输出 OpenAI 格式）
- 已有 `ChatMessage` 类型的修改或破坏性变更

## 3. 业务语义拆解

**核心业务对象：**

| 对象 | OpenAI 语义 | Anthropic 语义 |
|------|------------|---------------|
| 对话请求 | `/chat/completions`，`messages` 数组 + `model` | `/messages`，`messages` + `model` + `max_tokens`（必填） |
| 系统提示 | `messages[0]`（role="system"） | 顶层 `system` 字段（与 messages 分离） |
| 用户消息 | `{role:"user", content: string\|ContentBlock[]}` | `{role:"user", content: ContentBlock[]}` |
| 助手文本 | `message.content: string` | `content: [{type:"text", text:"..."}]` |
| 工具调用 | `message.tool_calls: [...]`（独立字段） | `content: [{type:"tool_use", id, name, input}]`（content block） |
| 工具结果 | `{role:"tool", tool_call_id, content}` | `{role:"user", content: [{type:"tool_result", tool_use_id, content}]}` |
| 流式事件 | `delta.content`、`delta.tool_calls` | `content_block_start/delta/stop`、`message_start/delta/stop` |
| 停止原因 | `finish_reason: "stop"\|"tool_calls"\|"length"` | `stop_reason: "end_turn"\|"tool_use"\|"max_tokens"` |

**关键业务规则：**
1. Anthropic `max_tokens` 必须 > 0 且必填；端点需要默认值策略
2. Anthropic `system` 可以接受 string 或 ContentBlock[]（多段），需正确处理两种形式
3. Anthropic 工具结果是 user 角色的 content block（而非独立的 tool 角色消息），转换时需配对
4. Anthropic 流式事件的生命周期模型（start → delta* → stop）要求适配器维护每个 content block 的状态
5. 认证：两种协议共用同一 unified API key，Anthropic 客户端通过 `x-api-key` header 认证

**关键场景：**
- Claude Code 首次连接：`POST /v1/messages` → 路由到合适模型 → 返回 Anthropic 格式响应
- Claude Code 工具循环：tool_use → tool_result → 多轮保持 sticky session
- Claude Code 流式交互：实时展示文本 + 工具调用进度
- 现有 OpenAI 客户端：不受影响，继续使用 `/v1/chat/completions`

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块或入口 | 备注 |
|---|---|---|---|
| Anthropic 请求 | `AnthropicMessageRequest` 类型 | `shared/anthropic-types.ts` NEW | 基于 `@anthropic-ai/sdk` 的 `MessageCreateParams` |
| Anthropic 响应 | `AnthropicMessage` 类型 | `shared/anthropic-types.ts` NEW | 基于 `@anthropic-ai/sdk` 的 `Message` |
| Anthropic 流式事件 | `AnthropicStreamEvent` 联合类型 | `shared/anthropic-types.ts` NEW | 基于 `@anthropic-ai/sdk` 的 `RawMessageStreamEvent` |
| 协议转换（请求） | `anthropicToOpenAI()` | `server/src/lib/anthropic-adapter.ts` NEW | 消息格式转换 + system 字段提升 |
| 协议转换（响应） | `openAIToAnthropicResponse()` | `server/src/lib/anthropic-adapter.ts` NEW | 响应格式 + tool_calls → content blocks |
| 协议转换（流式） | `openAIChunksToAnthropicEvents()` | `server/src/lib/anthropic-stream.ts` NEW | 状态机驱动的 SSE 事件生成 |
| Provider 双协议接口 | `BaseProvider.messages()` / `.streamMessages()` | `server/src/providers/base.ts` MODIFY | 默认适配器调用现有 `chatCompletion`/`streamChatCompletion` |
| /v1/messages 端点 | `router.post('/messages', ...)` | `server/src/routes/anthropic.ts` NEW | Zod 验证 + 路由 + provider 调用 |
| 路由注册 | `app.use('/v1', anthropicRouter)` | `server/src/app.ts` MODIFY | 在现有 OpenAI 路由旁注册 |
| Anthropic 版本头 | `anthropic-version` header 处理 | `server/src/routes/anthropic.ts` NEW | `2023-06-01` 格式验证 |

## 5. 变更清单

1. **新增** `@anthropic-ai/sdk` 依赖（仅使用 types + SSE 解析）
2. **新增** `shared/anthropic-types.ts` — Anthropic 原生类型定义
3. **新增** `server/src/lib/anthropic-adapter.ts` — 协议转换器（非流式）
4. **新增** `server/src/lib/anthropic-stream.ts` — 流式适配器
5. **修改** `server/src/providers/base.ts` — BaseProvider 添加 `messages()` / `streamMessages()` 方法
6. **新增** `server/src/routes/anthropic.ts` — `/v1/messages` 端点
7. **修改** `server/src/app.ts` — 注册 Anthropic 路由
8. **修改** `server/src/routes/proxy.ts` — 提取共享的 auth 和 token 估算工具函数

## 6. 追踪关系

| 业务目标 | 变更点 | Capability | 影响对象 | 验收口径 |
|---|---|---|---|---|
| Claude Code 连接代理 | `/v1/messages` 端点 | `anthropic-endpoint` | 新路由文件 | Claude Code 配置后可发起对话 |
| 多轮对话正常 | 协议转换器 | `message-translation` | 适配器 + 基础 provider | 对话历史正确透传，system prompt 保留 |
| 工具调用正常 | tool_use ↔ tool_calls 转换 | `message-translation` | 适配器 | Claude Code tool loop 正确执行 |
| 流式输出正常 | Anthropic SSE 事件生成 | `anthropic-streaming` | 流式适配器 | 流式响应逐字展示，tool_use 正确处理 |
| 复用现有路由 | BaseProvider 扩展 | `provider-dual-protocol` | BaseProvider + 所有 provider | Anthropic 请求走完完整路由链 |
| 现有功能不受影响 | 独立类型系统 | `backward-compat` | shared/types.ts | 所有现有测试通过 |

## 7. Capabilities

### 新增 Capabilities
- `anthropic-endpoint`: `POST /v1/messages` 端点。接受 Anthropic Messages API 格式的请求，验证 `anthropic-version` header，解析消息、工具和参数，返回 Anthropic 格式响应。复用现有认证和路由基础设施。
- `message-translation`: Anthropic 消息格式 ↔ OpenAI 消息格式的双向转换。覆盖所有消息角色、content block 类型、工具调用和结果、system prompt 双模式、流式事件格式。处理边界情况（空内容、缺失 ID、多 tool 并行调用）。
- `anthropic-streaming`: OpenAI SSE delta chunks → Anthropic 结构化 SSE events 的流式生成器。维护 content block 生命周期状态机，缓冲和合并 tool_use 的 input_json_delta，在流结束时正确发出 message_delta 和 message_stop。
- `provider-dual-protocol`: BaseProvider 接口扩展。默认适配器实现使所有现有 provider 自动支持 Anthropic 协议（通过复用现有 `chatCompletion`/`streamChatCompletion`）。未来 Anthropic-native provider 可覆盖默认实现。

## 8. 复杂度判定

**复杂度结论：** 复杂需求

**判定依据：**
- [x] 涉及两个及以上模块、服务或分层（shared 类型层、lib 适配器层、routes 端点层、providers 接口层）
- [x] 涉及接口协议、数据结构、存储模型变化（新增协议接口，修改 BaseProvider 抽象类）
- [ ] 涉及迁移、灰度、回滚、兼容处理
- [ ] 涉及安全、性能、并发、缓存、幂等等专项权衡
- [x] 仅依靠 proposal + specs 无法稳定拆出 tasks（流式适配器状态机、协议转换边界情况需要 design）

**Design 是否必需：** 必需

**说明：** 涉及多文件跨层改动、新增抽象接口、协议转换的边界情况和错误处理需要详细设计。特别是流式适配器的状态机、BaseProvider 接口扩展方案、以及适配器与现有容错逻辑的集成方式。

## 9. Knowledge 使用与影响

**本次使用的 Knowledge：**
- `@anthropic-ai/sdk@0.111.0`：类型定义和 SSE 解析逻辑

**Knowledge 证据：**
- Source: `@anthropic-ai/sdk` type declarations (`resources/messages/messages.d.ts`)
- Evidence: `ContentBlock`, `ContentBlockParam`, `RawMessageStreamEvent`, `Message`, `MessageParam`, `StopReason` 等完整类型体系
- 可信度: high
- 未证实推断: SDK 类型是否覆盖 Claude Code 实际发送的所有字段

**本次受影响的 Knowledge：**
- 无（不涉及已有知识文档的修改）

**是否需要新增 Knowledge 文档：** 否

## 10. 影响评估

**新增文件：**
- `shared/anthropic-types.ts`
- `server/src/lib/anthropic-adapter.ts`
- `server/src/lib/anthropic-stream.ts`
- `server/src/routes/anthropic.ts`

**修改文件：**
- `server/package.json` — 添加 `@anthropic-ai/sdk`
- `server/src/app.ts` — 注册 Anthropic 路由（1 行）
- `server/src/providers/base.ts` — 添加 2 个抽象方法 + 默认实现
- `server/src/routes/proxy.ts` — 提取 `extractApiToken` 和 token 估算为共享函数

**不影响：**
- 所有现有 `ChatMessage` 类型、`chatCompletion()` 调用方、Provider 实现、路由逻辑、数据库

**测试影响：**
- 需要新增 `server/src/__tests__/routes/anthropic.test.ts`、`server/src/__tests__/lib/anthropic-adapter.test.ts`、`server/src/__tests__/lib/anthropic-stream.test.ts`
- 现有测试全量回归

## 11. 非目标与后续议题

- **非目标**：添加 Anthropic API 作为后端 provider（无免费 tier，不符合项目定位）
- **非目标**：Anthropic Agents API、Sessions API、Batches API
- **非目标**：OpenAI 端点输出 Anthropic 格式
- **后续议题**：Anthropic-native provider（直接对话 Anthropic API 而非适配器）
- **后续议题**：`cache_control` prompt caching 支持
- **后续议题**：extended thinking 功能完整支持
- **后续议题**：Anthropic 格式的 `/v1/models` 端点

## 12. 阶段自检

- [x] 已说明为什么要做以及本工程负责哪一部分
- [x] 已明确纳入范围 / 不纳入范围
- [x] 每个 capability 都有清晰边界，且不是简单模块名
- [x] 每个 capability 都能追溯到业务目标和变更点
- [x] 已判断 design 是否必需（必需）
- [x] 未写入具体实现代码或过细任务
- [x] 已列出仍需确认的问题，且不阻塞 specs 的事项已标明
