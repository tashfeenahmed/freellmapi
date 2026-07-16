## ADDED Requirements

### Requirement: Anthropic 请求消息转 OpenAI 格式
Trace: proposal.md#message-translation / 多轮对话正常

系统 SHALL 将 Anthropic Messages API 的请求消息转换为内部 OpenAI 兼容格式，供现有 provider 消费。

#### Scenario: 简单文本对话
- **WHEN** 输入 `{role:"user", content:[{type:"text", text:"Hi"}]}` + system `"Be helpful"`
- **THEN** 生成 OpenAI 消息 `[{role:"system", content:"Be helpful"}, {role:"user", content:"Hi"}]`

#### Scenario: 包含助手 tool_use 的历史
- **WHEN** 输入 assistant 消息包含 `content: [{type:"tool_use", id:"toolu_01", name:"get_weather", input:{city:"NYC"}}]`
- **THEN** 生成 `{role:"assistant", content:null, tool_calls:[{id:"toolu_01", type:"function", function:{name:"get_weather", arguments:'{"city":"NYC"}'}}]}`

#### Scenario: 包含 tool_result 的历史
- **WHEN** 输入 user 消息包含 `content: [{type:"tool_result", tool_use_id:"toolu_01", content:"Sunny"}]`
- **THEN** 生成 `{role:"tool", tool_call_id:"toolu_01", content:"Sunny"}`

#### Scenario: 空 content 处理
- **WHEN** 输入消息 content 为空数组 `[]` 或空字符串
- **THEN** 不抛出异常，生成 content 为 `""` 或 `null` 的 OpenAI 消息

### Requirement: OpenAI 响应转 Anthropic 格式
Trace: proposal.md#message-translation / 对话响应格式正确

系统 SHALL 将 OpenAI 格式的响应转换为 Anthropic Messages API 响应格式。

#### Scenario: 纯文本响应
- **WHEN** OpenAI 响应 `choices[0].message.content: "Hello!"`、`finish_reason: "stop"`、`usage: {prompt_tokens:10, completion_tokens:2, total_tokens:12}`
- **THEN** 生成 `{type:"message", role:"assistant", content:[{type:"text", text:"Hello!"}], stop_reason:"end_turn", usage:{input_tokens:10, output_tokens:2}}`

#### Scenario: 带 tool_use 的响应
- **WHEN** OpenAI 响应 `choices[0].message.tool_calls: [{id:"call_1", function:{name:"get_weather", arguments:'{"city":"NYC"}'}}]`、`finish_reason: "tool_calls"`
- **THEN** 生成 `{content:[{type:"tool_use", id:"call_1", name:"get_weather", input:{city:"NYC"}}], stop_reason:"tool_use"}`

#### Scenario: 多 tool calls 并列
- **WHEN** OpenAI 响应包含 2 个 tool_calls（id 分别为 "call_1"、"call_2"）
- **THEN** 生成 2 个 `tool_use` content block，顺序与输入一致

#### Scenario: finish_reason 映射
- **WHEN** OpenAI `finish_reason` 为 `"length"` 或 `"max_tokens"`
- **THEN** Anthropic `stop_reason` 为 `"max_tokens"`

#### Scenario: 空响应容错
- **WHEN** OpenAI 响应 content 为 null 或空字符串且无 tool_calls
- **THEN** 生成至少包含一个空 `text` block 的响应，不返回空 content 数组

### Requirement: 工具定义转换
Trace: proposal.md#message-translation / 工具调用正常

系统 SHALL 将 Anthropic 工具定义转换为 OpenAI 工具定义格式。

#### Scenario: 标准工具定义
- **WHEN** Anthropic 请求包含 `tools: [{name:"get_weather", description:"...", input_schema:{type:"object", properties:{...}}}]`
- **THEN** 生成 `tools:[{type:"function", function:{name:"get_weather", description:"...", parameters:{type:"object", properties:{...}}}}]`

#### Scenario: tool_choice 映射
- **WHEN** Anthropic 请求 `tool_choice: {type:"tool", name:"get_weather"}`
- **THEN** 生成 `tool_choice: {type:"function", function:{name:"get_weather"}}`

#### Scenario: tool_choice auto
- **WHEN** Anthropic 请求 `tool_choice: {type:"auto"}`
- **THEN** 生成 `tool_choice: "auto"`

#### Scenario: tool_choice any
- **WHEN** Anthropic 请求 `tool_choice: {type:"any"}`
- **THEN** 生成 `tool_choice: "required"`（OpenAI 等效语义）

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 已完整复制旧 requirement block 后再修改（N/A）
- [x] 未把纯实现重构写成对外行为变化
