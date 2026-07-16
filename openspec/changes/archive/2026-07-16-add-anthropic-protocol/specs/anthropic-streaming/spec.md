## ADDED Requirements

### Requirement: 流式 SSE 事件生成
Trace: proposal.md#anthropic-streaming / 流式输出正常

系统 SHALL 将 OpenAI SSE chunks 转换为 Anthropic Messages API 的 SSE 事件流。

#### Scenario: 纯文本流式响应的完整事件序列
- **WHEN** OpenAI chunk 序列：role delta → text delta "Hello" → text delta " world" → finish_reason "stop"
- **THEN** 生成 Anthropic 事件序列：
  1. `message_start` — 包含 message id、model、usage（input_tokens）
  2. `content_block_start` — index 0, type "text"
  3. `content_block_delta` — index 0, delta `{type:"text_delta", text:"Hello"}`
  4. `content_block_delta` — index 0, delta `{type:"text_delta", text:" world"}`
  5. `content_block_stop` — index 0
  6. `message_delta` — delta 包含 `stop_reason: "end_turn"` 和 usage output_tokens
  7. `message_stop`

#### Scenario: 工具调用的流式响应
- **WHEN** OpenAI 产生 tool_call delta 序列（id → name → arguments 分块）
- **THEN** 在文本 content_block_stop 后生成：
  1. `content_block_start` — type "tool_use", id "call_1", name "get_weather"
  2. `content_block_delta` — delta `{type:"input_json_delta", partial_json:"{..."}`
  3. `content_block_stop`
  4. `message_delta` — stop_reason "tool_use"

#### Scenario: 流开始时发出 message_start
- **WHEN** 流式适配器收到第一个有内容的 OpenAI chunk
- **THEN** 首先发出 `message_start` 事件，包含 id、model 和空的 usage 对象

#### Scenario: 没有 content block 的流
- **WHEN** 流结束但没有产生任何文本或 tool_use 内容（空完成）
- **THEN** 抛出可重试错误 `"empty completion"` 供 fallback 处理

### Requirement: Content block 生命周期管理
Trace: proposal.md#anthropic-streaming / 流式事件正确性

适配器 SHALL 维护 content block 的状态机，确保每个 block 正确经历 start → delta* → stop 生命周期。

#### Scenario: 文本 block 后跟 tool_use block
- **WHEN** OpenAI 先输出文本 delta，再输出 tool_call delta
- **THEN** 文本 block 的 `content_block_stop` 在 tool_use 的 `content_block_start` 之前发出

#### Scenario: 多个 tool_use blocks
- **WHEN** OpenAI 输出 3 个 tool_call（index 0, 1, 2）
- **THEN** 每个 tool_call 对应一个独立的 `content_block_start` → `content_block_delta`* → `content_block_stop` 序列，按 index 排序

#### Scenario: OpenAI role delta 处理
- **WHEN** 收到只含 role delta（无 content）的 OpenAI chunk
- **THEN** 该 chunk 被缓冲，不立即生成 Anthropic 事件。第一个 text content 出现时，先发 `message_start`，再发 `content_block_start`

### Requirement: 流错误处理
Trace: proposal.md#anthropic-streaming / 容错与 fallback

适配器 SHALL 正确处理流式传输中的错误。

#### Scenario: headers 未发送前的错误
- **WHEN** 流在首个有效 payload 产生前失败（如 upstream HTTP 错误）
- **THEN** 抛出重试错误，不产生任何 SSE 事件

#### Scenario: headers 已发送后的错误
- **WHEN** 流在发出至少一个 text block 后中断
- **THEN** 发出 `{type:"error", error:{type:"stream_error", message:"stream interrupted"}}` 事件，结束流

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 已完整复制旧 requirement block 后再修改（N/A）
- [x] 未把纯实现重构写成对外行为变化
