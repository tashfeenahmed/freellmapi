## ADDED Requirements

### Requirement: ManageModelsDrawer 逻辑模型分区
**Trace**: proposal.md#alias-management-ui / 维护者配置映射

ManageModelsDrawer SHALL 新增"逻辑模型"分区，集中列出所有 alias 及其 level/priority/enabled 状态。该分区 SHALL 与现有模型列表分区共存于同一抽屉，不新建独立页面。

#### Scenario: 打开抽屉看到逻辑模型分区
- **WHEN** 维护者打开 ManageModelsDrawer
- **THEN** 抽屉内可见"逻辑模型"分区，列出所有 alias 行，每行显示 name/level/priority/enabled

#### Scenario: 分区按 level 与 priority 排序
- **WHEN** 存在多个 alias
- **THEN** 分区列表按 level（high -> middle -> low）、同 level 内按 priority 升序排列

### Requirement: alias 行内编辑
**Trace**: proposal.md#alias-management-ui / 维护者配置映射

alias 行 SHALL 支持行内编辑 name/level/priority/enabled，以及删除。level 通过下拉选择 high/middle/low。改名时 SHALL 触发保留字与重名校验，违反时前端显示错误。

#### Scenario: 行内修改 level
- **WHEN** 维护者在 alias `glm5.2` 行把 level 从 high 改为 middle 并保存
- **THEN** 该行 level 显示为 middle，后端持久化

#### Scenario: 行内修改 priority
- **WHEN** 维护者在 alias 行把 priority 改为 2 并保存
- **THEN** 该行 priority 显示为 2，列表重新按 priority 排序

#### Scenario: 改名为保留字被拒
- **WHEN** 维护者把 alias 名改为 `high-level` 并保存
- **THEN** 前端显示错误"该名称为保留档位名"，不发请求或后端返回 400 后前端回滚

#### Scenario: 行内启停 alias
- **WHEN** 维护者切换 alias 行的 enabled 开关为关闭
- **THEN** 该行标记为禁用，后续该 alias 不参与路由（见 scoped-model-routing spec）

#### Scenario: 删除 alias
- **WHEN** 维护者点击 alias 行的删除并确认
- **THEN** 该 alias 从列表消失，其成员模型的 alias 归属被清除（模型行保留，alias 下拉回到"无"）

### Requirement: 新建 alias 入口
**Trace**: proposal.md#alias-management-ui / 维护者配置映射

逻辑模型分区 SHALL 提供"新建 alias"入口，接受 name/level（默认 low）/priority。新建时 SHALL 触发保留字与重名校验。

#### Scenario: 新建 alias
- **WHEN** 维护者点击"新建 alias"，填 name `deepseek-v4-pro`、level high，提交
- **THEN** 列表新增一行 `deepseek-v4-pro` / high / priority 0 / enabled

#### Scenario: 新建时 level 缺省为 low
- **WHEN** 维护者新建 alias 只填 name，不选 level
- **THEN** 新行 level 为 low

### Requirement: 模型行 alias 归属下拉与 priority
**Trace**: proposal.md#alias-management-ui / 维护者配置映射

模型列表的每个模型行 SHALL 增加 alias 归属下拉（选项为所有 enabled alias + "无"）与 alias_priority 输入。归属变化 SHALL 即时持久化。选择"无"时该模型退出档位/alias 路由。

#### Scenario: 给模型归属 alias
- **WHEN** 维护者在模型行 `provider2/bailian/glm5-2` 的 alias 下拉选择 `glm5.2`，alias_priority 填 1，保存
- **THEN** 该模型归属 `glm5.2`，后续 `model:"glm5.2"` 命中它

#### Scenario: 解除模型 alias 归属
- **WHEN** 维护者在已归属 alias 的模型行把下拉改为"无"，保存
- **THEN** 该模型 `alias_id` 置空，退出档位/alias 路由，仍可走 auto 或精确 pin

#### Scenario: alias_priority 影响组内顺序
- **WHEN** alias `glm5.2` 有 3 个成员，其 alias_priority 分别为 2/0/1
- **THEN** 路由时按 0 -> 1 -> 2 顺序尝试（见 scoped-model-routing spec）

### Requirement: alias 成员查看
**Trace**: proposal.md#alias-management-ui / 维护者配置映射

逻辑模型分区的 alias 行 SHALL 可展开查看其成员模型列表（平台/model_id/alias_priority），便于核对归属。

#### Scenario: 展开 alias 看成员
- **WHEN** 维护者点击 alias `glm5.2` 行展开
- **THEN** 显示其所有成员模型，每项含 platform/model_id/alias_priority

#### Scenario: 空成员 alias 提示
- **WHEN** 维护者展开一个无成员的 alias
- **THEN** 显示"暂无成员模型"提示，引导去模型列表归组

### Requirement: AddCustomModelDialog alias 归属
**Trace**: proposal.md#alias-management-ui / 维护者配置映射

AddCustomModelDialog（添加自定义模型对话框）SHALL 增加可选的 alias 归属下拉，新建模型时可一并归组。

#### Scenario: 新建自定义模型时归组
- **WHEN** 维护者通过 AddCustomModelDialog 新建模型，alias 下拉选 `glm5.2`，alias_priority 填 0
- **THEN** 新建模型直接归属 `glm5.2`，无需事后编辑

#### Scenario: 新建自定义模型时不归组
- **WHEN** 维护者新建模型时 alias 下拉保持"无"
- **THEN** 新建模型 `alias_id` 为 NULL，不参与档位/alias 路由

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 已完整复制旧 requirement block 后再修改（N/A - 无修改项）
- [x] 未把纯实现重构写成对外行为变化
