# provider-agnes

**Purpose:** AGNES AI 作为 OpenAI 兼容供应商的完整支持，包括 API 调用、key 验证、流式传输、速率限制和前端配置入口。

## Requirements

### Requirement: AGNES AI 供应商注册
系统 SHALL 将 `agnes` 注册为有效的 API 供应商平台。AGNES AI 使用 OpenAI 兼容协议，API 端点 SHALL 为 `https://apihub.agnes-ai.com/v1`，认证方式为 `Authorization: Bearer <api_key>`。

#### Scenario: 使用 AGNES 平台发起 chat completion
- **WHEN** 用户配置了有效的 AGNES API key 并选择 agnes 平台模型发起 chat completion 请求
- **THEN** 系统将请求路由到 `https://apihub.agnes-ai.com/v1/chat/completions`，携带 `Authorization: Bearer <key>` header

#### Scenario: 使用 AGNES 平台发起流式 chat completion
- **WHEN** 用户配置了有效的 AGNES API key 并选择 agnes 平台模型发起流式 chat completion 请求
- **THEN** 系统将流式请求路由到 `https://apihub.agnes-ai.com/v1/chat/completions`（携带 `stream: true`），并正确解析 SSE 流响应

### Requirement: AGNES API Key 健康检查
系统 SHALL 支持验证 AGNES API key 的有效性。验证方式为向 `https://apihub.agnes-ai.com/v1/models` 发送 GET 请求，携带 `Authorization: Bearer <api_key>` header。

#### Scenario: 有效 key 验证
- **WHEN** 系统验证一个有效的 AGNES API key
- **THEN** 返回 `healthy` 状态

#### Scenario: 无效 key 验证
- **WHEN** 系统验证一个无效或被撤销的 AGNES API key
- **THEN** 返回 `bad_key` 状态，该 key 被自动禁用

### Requirement: AGNES AI 前端配置入口
系统前端 SHALL 在 Keys 页面的供应商下拉列表中提供 "Agnes AI" 选项，并附带指向 `https://platform.agnes-ai.com/settings/apiKeys` 的 "Get API key" 链接。

#### Scenario: 用户选择 AGNES AI 供应商
- **WHEN** 用户在 Keys 页面打开供应商下拉列表
- **THEN** 列表中包含 "Agnes AI" 选项，旁边显示指向 AGNES 平台 API key 管理页面的链接

#### Scenario: 用户配置 AGNES API key
- **WHEN** 用户选择 "Agnes AI" 并输入有效的 `sk-` 前缀 API key 后保存
- **THEN** 系统接受配置，key 状态显示为健康检查中或 healthy
