# model-agnes-2.0-flash

**Purpose:** AGNES AI 旗舰文本模型，256K context window，支持 vision 和 tool calling，RPM 20，当前免费。

## Requirements

### Requirement: agnes-2.0-flash 模型注册
系统 SHALL 将 `agnes-2.0-flash` 注册为 AGNES 平台下的可用模型。该模型 SHALL 具备以下属性：256K context window、支持 vision 图片输入、支持 tool calling、RPM 限制为 20、RPD 限制为 200。

#### Scenario: 模型出现在路由链中
- **WHEN** 用户已配置有效的 AGNES API key 且系统中存在 `agnes-2.0-flash` 模型记录
- **THEN** `agnes-2.0-flash` 出现在活跃路由链中，可被选中用于 chat completion 请求

#### Scenario: Vision 请求正确路由到 agnes-2.0-flash
- **WHEN** 用户发起包含图片附件的 chat completion 请求
- **THEN** 系统将 `agnes-2.0-flash` 纳入候选模型（因其 `supports_vision = 1`），在路由链中可被选中

#### Scenario: Tool calling 请求正确路由到 agnes-2.0-flash
- **WHEN** 用户发起包含 tool definitions 的 chat completion 请求
- **THEN** 系统将 `agnes-2.0-flash` 纳入候选模型（因其 `supports_tools = 1`），在路由链中可被选中

#### Scenario: 超 context window 请求跳过 agnes-2.0-flash
- **WHEN** 用户发起一个预估 token 数超过 262144 的请求
- **THEN** 路由逻辑跳过 `agnes-2.0-flash`（因其 `context_window = 262144` 不足以容纳请求）

### Requirement: agnes-2.0-flash 模型属性
`agnes-2.0-flash` 模型的数据库记录 SHALL 包含以下属性值：

| 属性 | 值 |
|------|-----|
| platform | `agnes` |
| model_id | `agnes-2.0-flash` |
| display_name | `Agnes 2.0 Flash` |
| intelligence_rank | 4 |
| speed_rank | 2 |
| size_label | `Frontier` |
| rpm_limit | 20 |
| rpd_limit | 200 |
| context_window | 262144 |
| supports_vision | 1 |
| supports_tools | 1 |
| monthly_token_budget | `free (promo)` |

#### Scenario: 模型属性验证
- **WHEN** 系统初始化或迁移完成后
- **THEN** `models` 表中存在 `platform='agnes' AND model_id='agnes-2.0-flash'` 的记录，所有属性值与上表一致
