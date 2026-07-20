## ADDED Requirements

### Requirement: aliases 表与 models 归属列
**Trace**: proposal.md#logical-model-alias / alias 数据模型

系统 SHALL 新增 `aliases` 表存储逻辑模型别名头信息，包含 `id`、`name`（UNIQUE）、`level`（`high`/`middle`/`low`，默认 `low`）、`priority`（整数，默认 0）、`enabled`（默认 1）、`created_at`。系统 SHALL 在 `models` 表新增 `alias_id`（外键引用 `aliases(id)`，`ON DELETE SET NULL`，可空）与 `alias_priority`（整数，默认 0）两列。迁移 SHALL 可重复执行。

#### Scenario: 新建 alias 行
- **WHEN** 执行迁移后插入一条 alias `{name:"glm5.2", level:"high", priority:0}`
- **THEN** `aliases` 表存在该行，`enabled=1`，`created_at` 非空

#### Scenario: 未设 level 的 alias 默认 low
- **WHEN** 插入 alias 时未指定 `level`
- **THEN** 该行 `level = 'low'`

#### Scenario: 模型行设置 alias 归属
- **WHEN** 把一个 models 行的 `alias_id` 设为某 alias 的 id，`alias_priority` 设为 2
- **THEN** 该模型通过该 alias_id 关联到对应 alias，`alias_priority=2`

#### Scenario: 删除 alias 时模型归属置空
- **WHEN** 删除一个 alias，且存在 `alias_id` 指向它的 models 行
- **THEN** 这些 models 行的 `alias_id` 变为 NULL，模型行本身保留

#### Scenario: 迁移可重复执行
- **WHEN** 在已迁移的数据库上再次执行迁移
- **THEN** 不报错，`aliases` 表与 `models` 两列状态不变

### Requirement: alias 列表 API
**Trace**: proposal.md#logical-model-alias / alias 管理 API

系统 SHALL 提供 `GET /api/aliases` 返回所有 alias 及其成员模型概览，按 `level`、`priority` 排序。

#### Scenario: 列出所有 alias
- **WHEN** 已认证客户端请求 `GET /api/aliases`
- **THEN** 返回 200，body 为 alias 数组，每项含 `id`/`name`/`level`/`priority`/`enabled`/`created_at` 及成员模型 id 列表

### Requirement: alias 新建与保留字校验
**Trace**: proposal.md#logical-model-alias / alias 管理 API

系统 SHALL 提供 `POST /api/aliases` 新建 alias，接受 `name`/`level`/`priority`。`level` 缺省时默认 `low`。系统 SHALL 拒绝 `name` 等于保留字 `high-level`/`middle-level`/`low-level`（大小写不敏感）。系统 SHALL 拒绝重复 `name`。

#### Scenario: 新建 alias 成功
- **WHEN** `POST /api/aliases` body 为 `{name:"glm5.2", level:"high"}`
- **THEN** 返回 201，body 含新建 alias 的 id，`level="high"`，`priority=0`，`enabled=true`

#### Scenario: 新建时 level 缺省
- **WHEN** `POST /api/aliases` body 为 `{name:"deepseek-v4-flash"}`
- **THEN** 返回 201，`level="low"`

#### Scenario: 保留字名被拒
- **WHEN** `POST /api/aliases` body 为 `{name:"high-level"}` 或 `{name:"High-Level"}`
- **THEN** 返回 400，error 指明该名是保留档位名

#### Scenario: 重名被拒
- **WHEN** 已存在 alias `glm5.2`，再 `POST /api/aliases` `{name:"glm5.2"}`
- **THEN** 返回 400，error 指明 name 已存在

### Requirement: alias 改名与 level/priority 更新
**Trace**: proposal.md#logical-model-alias / alias 管理 API

系统 SHALL 提供 `PATCH /api/aliases/:id` 更新 `name`/`level`/`priority`/`enabled`。改名时 SHALL 同样执行保留字与重名校验。

#### Scenario: 更新 level
- **WHEN** `PATCH /api/aliases/:id` body 为 `{level:"middle"}`
- **THEN** 返回 200，该 alias `level="middle"`，其他字段不变

#### Scenario: 改名触发保留字校验
- **WHEN** `PATCH /api/aliases/:id` body 为 `{name:"low-level"}`
- **THEN** 返回 400，error 指明该名是保留档位名

#### Scenario: 改名触发重名校验
- **WHEN** 已有 alias `a` 和 `b`，`PATCH /api/aliases/{a.id}` body 为 `{name:"b"}`
- **THEN** 返回 400，error 指明 name 已存在

### Requirement: alias 启停
**Trace**: proposal.md#logical-model-alias / alias 管理 API

系统 SHALL 允许通过 `PATCH /api/aliases/:id` 设置 `enabled=false`。禁用的 alias 及其成员 SHALL 不参与档位/alias 路由。

#### Scenario: 禁用 alias
- **WHEN** `PATCH /api/aliases/:id` body 为 `{enabled:false}`
- **THEN** 返回 200，该 alias `enabled=false`
- **AND** 后续 `model:"<该alias名>"` 请求不命中该 alias（见 scoped-model-routing spec）

### Requirement: alias 删除
**Trace**: proposal.md#logical-model-alias / alias 管理 API

系统 SHALL 提供 `DELETE /api/aliases/:id` 删除 alias。删除 SHALL 触发 `ON DELETE SET NULL`，成员模型的 `alias_id` 置空，模型行保留。

#### Scenario: 删除 alias 后成员解绑
- **WHEN** alias `glm5.2` 有 3 个成员模型，执行 `DELETE /api/aliases/{glm5.2.id}`
- **THEN** 返回 204，`aliases` 表该行消失，3 个成员模型的 `alias_id` 变为 NULL

### Requirement: 模型 CRUD 读写 alias 归属
**Trace**: proposal.md#logical-model-alias / 模型归属 alias

系统 SHALL 在模型 CRUD（`POST /api/models`、`PATCH /api/models/:id`）中接受 `aliasId`（可空）与 `aliasPriority` 字段，并在 `GET /api/models` 返回这两个字段。`aliasId` 指向不存在的 alias 时 SHALL 返回 400。

#### Scenario: 创建模型时指定 alias
- **WHEN** `POST /api/models` body 含 `aliasId: 5, aliasPriority: 1`
- **THEN** 返回的新模型行 `aliasId=5`，`aliasPriority=1`

#### Scenario: 更新模型 alias 归属
- **WHEN** `PATCH /api/models/:id` body 为 `{aliasId: null}`
- **THEN** 该模型 `alias_id` 变为 NULL，退出档位/alias 路由

#### Scenario: 指向不存在的 alias 被拒
- **WHEN** `POST /api/models` body 含 `aliasId: 9999`（不存在）
- **THEN** 返回 400，error 指明 alias 不存在

### Requirement: 无 alias 的模型不参与档位/alias 路由
**Trace**: proposal.md#logical-model-alias / 无 alias 的模型不参与

`alias_id` 为 NULL 的模型 SHALL 不出现在任何档位或 alias 展开链中，只能通过 `auto` 或精确 `model_id` pin 访问。

#### Scenario: catalog-sync 同步进来的模型不归档
- **WHEN** catalog-sync 写入新模型行，未设 `alias_id`
- **THEN** 该模型 `alias_id = NULL`，`model:"<其所属档位>"` 或 `model:"<其 alias 名>"` 均不命中它
- **AND** 该模型仍可通过 `model:"<其 model_id>"` 精确 pin 或 `model:"auto"` 访问

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 已完整复制旧 requirement block 后再修改（N/A - 无修改项）
- [x] 未把纯实现重构写成对外行为变化
