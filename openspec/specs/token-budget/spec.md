## Purpose

Token budget management governs how monthly token quotas are calculated and used in routing decisions. Budgets scale with the number of enabled API keys to reflect real available capacity.

## Requirements

### Requirement: 月度令牌预算按启用 key 数量缩放

系统 SHALL 将模型的月度令牌预算计算为 `模型基础 budget × 该平台下启用 key 数量`。

#### Scenario: 多个 key 时 budget 成倍增加
- **WHEN** 平台 `google` 下有 3 个启用的 key，模型 `gemini-2.5-flash` 的基础 budget 为 `~3M`（parseBudget = 3,000,000）
- **THEN** 该模型在 headroom 计算中使用的 budget 为 9,000,000（3M × 3）

#### Scenario: 单个 key 时 budget 不变
- **WHEN** 平台 `google` 下有 1 个启用的 key，模型 `gemini-2.5-flash` 的基础 budget 为 `~3M`
- **THEN** 该模型在 headroom 计算中使用的 budget 为 3,000,000（3M × 1）

#### Scenario: 没有 key 时 budget 为 0
- **WHEN** 平台 `google` 下没有启用的 key
- **THEN** 该平台所有模型的 budget 为 0，headroomFactor 返回 1（无预算限制，正常通过）

#### Scenario: Custom 平台每个 model 单独计算
- **WHEN** custom 平台下有 2 个 key，各注册了 1 个 model（共 2 个 model 行）
- **THEN** 每个 custom model 的 budget 不乘以平台 key 数（custom model 只绑定一个 key）

### Requirement: key 数量变更后 budget 随之更新

系统 SHALL 在每次路由决策时实时查询启用 key 数量，确保启用/禁用 key 后预算立即生效。

#### Scenario: 禁用 key 后预算减小
- **WHEN** 平台有 3 个启用 key，用户禁用 1 个
- **THEN** 下一次路由时该平台所有模型的 budget 缩放系数从 3 变为 2

#### Scenario: 新增 key 后预算增大
- **WHEN** 平台有 1 个启用 key，用户新增 1 个
- **THEN** 下一次路由时该平台所有模型的 budget 缩放系数从 1 变为 2
