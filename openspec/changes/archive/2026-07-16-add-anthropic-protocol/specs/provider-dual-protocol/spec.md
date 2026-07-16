## ADDED Requirements

### Requirement: BaseProvider 双协议接口
Trace: proposal.md#provider-dual-protocol / 复用现有路由

BaseProvider SHALL 新增 `messages()` 和 `streamMessages()` 两个方法，接受 Anthropic 格式参数并返回 Anthropic 格式结果。

#### Scenario: 默认适配器行为 — 非流式
- **WHEN** 调用 `provider.messages(apiKey, anthropicParams)`
- **THEN** 默认实现将 Anthropic 参数转换为 OpenAI 格式，调用 `provider.chatCompletion()`，将 OpenAI 响应转回 Anthropic 格式并返回

#### Scenario: 默认适配器行为 — 流式
- **WHEN** 调用 `provider.streamMessages(apiKey, anthropicParams)`
- **THEN** 默认实现将 Anthropic 参数转换为 OpenAI 格式，调用 `provider.streamChatCompletion()`，将 OpenAI SSE chunks 转成 Anthropic SSE events 的 AsyncGenerator 并返回

#### Scenario: 现有 provider 零修改兼容
- **WHEN** 不覆盖默认实现
- **THEN** 12 个现有 provider 自动获得 Anthropic 协议支持

### Requirement: Anthropic 参数传递
Trace: proposal.md#provider-dual-protocol / 参数完整性

Provider 的 `messages()` 方法 SHALL 接受和传递所有 Anthropic Messages API 参数。

#### Scenario: 方法签名
- **WHEN** 调用 `messages(apiKey, params)`
- **THEN** `params` 包含：`model: string`、`messages: AnthropicMessageParam[]`、`system?: string \| ContentBlock[]`、`max_tokens: number`、`temperature?: number`、`top_p?: number`、`top_k?: number`、`stop_sequences?: string[]`、`tools?: AnthropicTool[]`、`tool_choice?: AnthropicToolChoice`、`stream?: boolean`、`metadata?: object`

### Requirement: 同步非流式返回方式
Trace: proposal.md#provider-dual-protocol / 接口一致性

`messages()` 方法的返回值 SHALL 为 `Promise<AnthropicMessage>`，与现有 `chatCompletion()` 返回 `Promise<ChatCompletionResponse>` 的接口风格一致。

#### Scenario: 非流式返回
- **WHEN** `params.stream` 为 false 或省略
- **THEN** 返回 `Promise<AnthropicMessage>`，包含 `id`、`type: "message"`、`role: "assistant"`、`content`、`model`、`stop_reason`、`usage`

### Requirement: Provider 覆写扩展点
Trace: proposal.md#provider-dual-protocol / 未来 Anthropic native provider

默认实现 SHALL 可以被子类覆盖。

#### Scenario: 子类覆写 messages()
- **WHEN** 一个 future Anthropic-native provider 覆盖 `messages()` 方法，直接发送 Anthropic 格式请求到上游
- **THEN** 该 provider 的 Anthropic 路径绕过 OpenAI 适配器，使用原生协议

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 已完整复制旧 requirement block 后再修改（N/A）
- [x] 未把纯实现重构写成对外行为变化
