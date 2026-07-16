## ADDED Requirements

### Requirement: 接受 Anthropic Messages API 格式请求
Trace: proposal.md#anthropic-endpoint / Claude Code 连接代理

系统 SHALL 在 `POST /v1/messages` 接受 Anthropic Messages API 格式的请求体，包括所有标准参数和可选参数。

#### Scenario: 接受最简请求
- **WHEN** 发送 `POST /v1/messages`，body 包含 `model`、`max_tokens`、`messages: [{role:"user", content:"Hello"}]`、且 `x-api-key` header 匹配统一 API key
- **THEN** 返回 200，响应格式符合 Anthropic Messages API，`type: "message"`，`role: "assistant"`

#### Scenario: 缺少必填 field 时返回 400
- **WHEN** 发送 `POST /v1/messages` 且 body 缺少 `max_tokens` 或 `messages`
- **THEN** 返回 400，error body 包含 `type: "invalid_request_error"` 和描述缺少哪个字段的 message

#### Scenario: 认证失败返回 401
- **WHEN** 发送 `POST /v1/messages` 且 `x-api-key` 不匹配或 Authorization header 中的 Bearer token 不匹配
- **THEN** 返回 401，error body 符合 Anthropic API 错误格式：`{type: "error", error: {type: "authentication_error", message: "..."}}`

### Requirement: Anthropic content block 请求解析
Trace: proposal.md#anthropic-endpoint / 多轮对话正常

系统 SHALL 正确解析所有 Anthropic content block 类型：`text`、`image`（base64 source）、`tool_use`、`tool_result`，并接受 `string` 形式的 content 简化写法。

#### Scenario: 文本消息
- **WHEN** 发送 `messages: [{role:"user", content: [{type:"text", text:"Hello"}]}]`
- **THEN** 正常处理，正确提取 "Hello" 作为用户输入

#### Scenario: 图片消息
- **WHEN** 发送 `messages: [{role:"user", content: [{type:"image", source:{type:"base64", media_type:"image/png", data:"..."}}]}]`
- **THEN** 请求被识别为需要 vision 模型，路由到 vision-capable 模型

#### Scenario: tool_use 在助手消息中被回放
- **WHEN** 发送 `messages` 包含 `{role:"assistant", content: [{type:"tool_use", id:"toolu_01", name:"get_weather", input:{city:"NYC"}}]}`
- **THEN** 正确提取 tool_use 信息并转换为内部表示

#### Scenario: tool_result 在用户消息中被回放
- **WHEN** 发送 `messages` 包含 `{role:"user", content: [{type:"tool_result", tool_use_id:"toolu_01", content:"Sunny"}]}`
- **THEN** 正确配对到对应的 tool_use

### Requirement: anthropic-version header 处理
Trace: proposal.md#anthropic-endpoint / Claude Code 兼容

系统 SHALL 验证 `anthropic-version` header 的存在性和格式。SHALL 接受 `2023-06-01` 格式的日期版本号。缺少此 header 时不阻塞请求，但 SHALL 在日志中记录警告。

#### Scenario: 缺少 anthropic-version header
- **WHEN** 发送请求且不包含 `anthropic-version` header
- **THEN** 日志输出警告，请求正常处理

#### Scenario: 有效的 anthropic-version
- **WHEN** 发送 `anthropic-version: 2023-06-01`
- **THEN** 正常处理

### Requirement: top-level system 字段支持
Trace: proposal.md#anthropic-endpoint / System prompt 保留

系统 SHALL 支持顶层 `system` 字段，接受 `string` 形式和 `TextBlock[]` 数组形式。system 内容 SHALL 被保留并传递给下游模型。

#### Scenario: string system prompt
- **WHEN** 发送 `system: "You are a helpful assistant"`
- **THEN** system prompt 被正确传递

#### Scenario: 数组 system prompt
- **WHEN** 发送 `system: [{type:"text", text:"You are helpful"}, {type:"text", text:"Be concise"}]`
- **THEN** 所有 system 文本块被合并传递

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 已完整复制旧 requirement block 后再修改（N/A — 无修改项）
- [x] 未把纯实现重构写成对外行为变化
