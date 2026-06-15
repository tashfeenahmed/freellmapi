<!-- 注意：以下英文区块标题与标记为 OpenSpec 解析器硬依赖，不能改成中文。正文内容请全部使用中文。 -->

## ADDED Requirements

### Requirement: agnes-2.0-flash 模型注册
<!-- Trace: proposal.md#model-agnes-2.0-flash / agnes-2.0-flash 可路由 -->
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
<!-- Trace: proposal.md#model-agnes-2.0-flash / 模型参数正确 -->
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

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] 未把纯实现重构写成对外行为变化
