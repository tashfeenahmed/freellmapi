## Purpose

User-managed models 让维护者通过前端 UI 直接为任意已注册的非 `'custom'` provider 增删改模型，无需走"写 migration → 发版 → 重启"的代码路径。本 capability 同时定义模型来源（source）三分体系（`migration` / `catalog` / `user`）以及三条写入路径之间的冲突协议——出厂 migrations、远程 catalog-sync、UI 手加这三条路径互不踩踏。

## Requirements

### Requirement: 模型来源（Source）三分体系

系统 MUST 在 `models` 表上维护一个 `source` 维度，取值集合限定为 `{'migration', 'catalog', 'user'}`，且每条 `models` 行 SHALL 在写入时被显式标记为以下其中之一：`migration` 表示由 `migrateModelsVN(db)` 系列函数在启动时写入的出厂内置模型；`catalog` 表示由 `applyCatalog(db, catalog)` 写入或更新的远程目录模型；`user` 表示由 `POST /api/models` 写入的维护者手加模型。`source` 字段 MUST 在 `GET /api/models` 响应中以 `source` 字段名暴露给前端。

#### Scenario: 出厂模型默认标记为 migration
- **WHEN** 服务首次启动且 `migrateModelsVN(db)` 函数将一条记录插入 `models` 表
- **THEN** 该行的 `source` 字段值 SHALL 等于字符串 `'migration'`

#### Scenario: catalog 同步写入显式标记为 catalog
- **WHEN** `applyCatalog` 对一条 `models` 行执行 INSERT 或 UPDATE
- **THEN** 该行的 `source` 字段值 SHALL 等于字符串 `'catalog'`

#### Scenario: UI 手加模型标记为 user
- **WHEN** 维护者通过 `POST /api/models` 创建一条新模型
- **THEN** 持久化的 `source` 字段值 SHALL 等于字符串 `'user'`

#### Scenario: GET /api/models 响应包含 source
- **WHEN** 客户端请求 `GET /api/models`
- **THEN** 响应数组中每个元素 SHALL 包含 `source` 字段，且取值在 `{'migration', 'catalog', 'user'}` 中

### Requirement: 用户手加模型不被 catalog-sync 删除

`applyCatalog` 在执行"清理 catalog 不再列出的模型"动作时，删除候选 SHALL 排除所有 `source = 'user'` 的行。换言之：维护者通过 UI 添加的模型 MUST 在 catalog-sync 整轮跑完后仍然存在于 `models` 表与 `fallback_config` 表中，无论 catalog 是否包含同 `(platform, modelId)` 的条目。

#### Scenario: catalog 中无该 user 模型时不被删除
- **WHEN** 维护者通过 UI 添加 `groq/qwen-3-coder-next-512b`（`source='user'`），随后 `applyCatalog` 处理一份不含该 modelId 的 catalog
- **THEN** 该行 SHALL 仍存在于 `models` 表中且其 `fallback_config` 行 SHALL 保留

#### Scenario: catalog 中存在 user 模型同名条目时不删除
- **WHEN** 维护者通过 UI 添加 `groq/X`，随后 `applyCatalog` 处理的 catalog 中也包含 `groq/X`
- **THEN** 该行 SHALL 仍存在于 `models` 表中（不会被"清理"分支误删）

### Requirement: catalog 接管 user 模型时升级 source 并保留 enabled

当 `applyCatalog` 处理一条 catalog 模型，且 `models` 表中已存在同 `(platform, modelId)` 的行且其 `source = 'user'` 时，系统 SHALL 执行"升级接管"：该行的 `source` 值 SHALL 被更新为 `'catalog'`；该行的 metadata 字段（`display_name`、`intelligence_rank`、`speed_rank`、`size_label`、各 `*_limit`、`monthly_token_budget`、`context_window`、`supports_vision`、`supports_tools`）SHALL 跟随 catalog 提供的值；该行的 `enabled` 字段 SHALL 沿用现有的 catalog enable 语义——catalog `enabled=false` 强制覆盖；catalog `enabled=true` MUST NOT 复活用户已禁用（`enabled=0`）的模型。

#### Scenario: user 模型被 catalog 命中后 source 升级
- **WHEN** 表中存在 `(groq, X, source='user', enabled=1)`，`applyCatalog` 处理含 `(groq, X, enabled=true)` 的 catalog
- **THEN** 该行 SHALL 变为 `(groq, X, source='catalog', enabled=1)`，且 metadata 跟 catalog

#### Scenario: 升级接管不复活用户禁用
- **WHEN** 表中存在 `(groq, X, source='user', enabled=0)`，`applyCatalog` 处理含 `(groq, X, enabled=true)` 的 catalog
- **THEN** 该行 SHALL 变为 `(groq, X, source='catalog', enabled=0)`

#### Scenario: 升级接管被 catalog 强制禁用覆盖
- **WHEN** 表中存在 `(groq, X, source='user', enabled=1)`，`applyCatalog` 处理含 `(groq, X, enabled=false)` 的 catalog
- **THEN** 该行 SHALL 变为 `(groq, X, source='catalog', enabled=0)`

### Requirement: 维护者通过 POST /api/models 添加任意 provider 的模型

系统 SHALL 提供 `POST /api/models` 接口，支持两种互斥的请求体形态：

**形态 A（通用 provider，原行为）**：body 必填 `platform`、`modelId`；可选字段为 `displayName`、`contextWindow`、`supportsVision`、`supportsTools`。系统 SHALL 拒绝未注册的 platform（即 `hasProvider(platform) === false`）→ 返回 4xx；在 `(platform, modelId)` 已存在时 SHALL 返回 409 且 MUST NOT 静默覆盖已有行的 `enabled` 状态；写入时 SHALL 设置 `source = 'user'`，且 SHALL 为该模型在 `fallback_config` 中插入一行（`priority = MAX(priority) + 1`，`enabled = 1`）；SHALL 给未提供的字段使用合理默认值（`displayName` 默认等于 `modelId`，`intelligence_rank = 50`，`speed_rank = 50`，`size_label = 'User'`，limits 与 `monthly_token_budget` 为 NULL/默认空值）。**注**：`platform = 'custom'` SHALL NOT 走形态 A；当 body 含 `platform = 'custom'` 但不含 `keyIds` 时，系统 SHALL 返回 400 引导使用形态 B。

**形态 B（custom 多 key 写入，新）**：body 必填 `keyIds: number[]`、`modelId`；可选 `displayName`。系统 SHALL 校验 keyIds 全部存在、属于 `platform='custom'`、共享同一 `base_url`（任一不满足返回 400）；SHALL 在单事务内对每个 keyId 执行 `INSERT INTO models ... ON CONFLICT(platform, model_id) DO UPDATE SET display_name=excluded.display_name`，使用 `model_id = '${keyId}-${modelId}'` 命名约定；写入时 `source = 'user'`、`enabled = 1`、`key_id = keyId`、其他元数据走默认值；新插入行 SHALL 同步获得 `fallback_config` 行；UPDATE 命中已有行时 MUST NOT 重复创建 `fallback_config` 行，且 MUST NOT 修改 `enabled` 字段。响应体 SHALL 等于 `{ created: number[], updated: number[] }`，HTTP 200。

#### Scenario: 形态 A — 成功添加 user 模型
- **WHEN** 维护者 POST `{platform: 'groq', modelId: 'qwen-3-coder-next-512b', displayName: 'Qwen3 Coder Next 512B'}`
- **THEN** 响应 SHALL 返回 201 与新建行的 id；表中 SHALL 存在 `(groq, qwen-3-coder-next-512b, source='user', enabled=1)` 行；`fallback_config` 中 SHALL 存在对应行

#### Scenario: 形态 A — 拒绝未注册 platform
- **WHEN** 维护者 POST `{platform: 'unknown-vendor', modelId: 'X'}`
- **THEN** 响应 SHALL 返回 4xx 错误

#### Scenario: 形态 A — 立即可路由
- **WHEN** 维护者添加 `(groq, X, source='user')` 后立即调用 `/v1/chat/completions` 指定 `model: 'X'`
- **THEN** 系统 SHALL 把该请求路由到 groq provider，无需重启

#### Scenario: 形态 A — 同 (platform, modelId) 冲突返回 409
- **WHEN** 维护者 POST `{platform:'groq', modelId:'X'}`，且该 `(platform, modelId)` 已存在
- **THEN** 响应 SHALL 返回 409，且已有行的 `enabled` 状态 MUST NOT 被覆盖

#### Scenario: 形态 B — 多 key 全新写入
- **WHEN** 同 base_url 下存在 keys [11, 12]，维护者 POST `{ keyIds: [11, 12], modelId: 'qwen3:8b' }`
- **THEN** `models` 表 SHALL 新增两行（`source='user'`），响应 SHALL 等于 `{ created: [<id1>, <id2>], updated: [] }`

#### Scenario: 形态 B — 重复提交触发 UPDATE
- **WHEN** 上一场景之后再次 POST 相同 keyIds 与 modelId 但不同 displayName
- **THEN** 两行的 `display_name` SHALL 被更新；响应 SHALL 等于 `{ created: [], updated: [<id1>, <id2>] }`；`enabled` MUST NOT 被改

#### Scenario: 形态 B — 跨 base_url 拒绝
- **WHEN** keys [11, 13] 跨不同 base_url，维护者 POST `{ keyIds: [11, 13], modelId: 'X' }`
- **THEN** 响应 SHALL 返回 400

#### Scenario: 形态 B — 非 custom 平台 keyIds 拒绝
- **WHEN** keys [99] 属于 `platform='groq'`，维护者 POST `{ keyIds: [99], modelId: 'X' }`
- **THEN** 响应 SHALL 返回 400

#### Scenario: 形态 A 上 platform='custom' 引导用户走形态 B
- **WHEN** 维护者 POST `{platform: 'custom', modelId: 'X'}`（无 keyIds）
- **THEN** 响应 SHALL 返回 400，错误消息 SHALL 引导使用 `keyIds[]` 形态

### Requirement: 维护者通过 PATCH /api/models/:id 编辑模型

系统 SHALL 提供 `PATCH /api/models/:id` 接口，允许维护者更新任意 source 的模型行。可编辑字段为 `displayName`、`enabled`、`contextWindow`、`supportsVision`、`supportsTools`。其余字段（`platform`、`modelId`、`source`、`intelligence_rank`、`speed_rank`、`size_label`、各 `*_limit`、`monthly_token_budget`）MUST NOT 通过该接口修改。

#### Scenario: 禁用 catalog 模型
- **WHEN** 维护者 PATCH 一个 `source='catalog'` 模型，body `{enabled: false}`
- **THEN** 该行的 `enabled` 字段 SHALL 变为 0；后续 catalog-sync 即使传 `enabled=true` 也 MUST NOT 复活该行

#### Scenario: 编辑 user 模型 displayName
- **WHEN** 维护者 PATCH 一个 `source='user'` 模型，body `{displayName: 'Custom Name'}`
- **THEN** 该行的 `display_name` 字段 SHALL 被更新；其他字段 SHALL 保持不变

#### Scenario: 拒绝修改 platform/modelId/source
- **WHEN** 维护者 PATCH 任意模型，body 包含 `platform`、`modelId` 或 `source`
- **THEN** 这些字段 SHALL 被忽略或请求 SHALL 返回 4xx；持久化结果 MUST NOT 包含对这些字段的修改

#### Scenario: 模型 id 不存在
- **WHEN** 维护者 PATCH 一个不存在的模型 id
- **THEN** 响应 SHALL 返回 404

### Requirement: 维护者通过 DELETE /api/models/:id 仅可硬删 user 模型

系统 SHALL 提供 `DELETE /api/models/:id` 接口。该接口 MUST 仅在目标行 `source = 'user'` 时执行硬删（`DELETE FROM models` 与级联 `DELETE FROM fallback_config WHERE model_db_id = ?`）；当目标行 `source ∈ {'catalog', 'migration'}` 时 SHALL 返回 4xx 错误，并在错误消息中明确指引使用 PATCH 设置 `enabled=false` 替代。

#### Scenario: 删除 user 模型成功
- **WHEN** 维护者 DELETE 一个 `source='user'` 模型
- **THEN** 该行 SHALL 从 `models` 表移除；对应 `fallback_config` 行 SHALL 同步移除；响应 SHALL 返回 2xx

#### Scenario: 拒绝硬删 catalog 模型
- **WHEN** 维护者 DELETE 一个 `source='catalog'` 模型
- **THEN** 响应 SHALL 返回 4xx 且包含引导 PATCH 禁用的提示；该行 SHALL 仍存在于 `models` 表中

#### Scenario: 拒绝硬删 migration 模型
- **WHEN** 维护者 DELETE 一个 `source='migration'` 模型
- **THEN** 响应 SHALL 返回 4xx；该行 SHALL 仍存在

#### Scenario: 模型 id 不存在
- **WHEN** 维护者 DELETE 一个不存在的模型 id
- **THEN** 响应 SHALL 返回 404

### Requirement: KeysPage 提供两处对等的"管理模型"入口

`KeysPage` SHALL 在 UI 上提供两处对等的"管理模型"入口：入口 ① 在每个 Provider section 的 header 上挂一个按钮（任意已注册的非 custom platform）；入口 ② 在该 Provider 下的每张 KeyCard 上挂同一个按钮。两处入口 MUST 打开同一个 `ManageModelsDrawer` 组件，且都 MUST 以 `platform`（不是 `key_id`）作为列表过滤维度。`Drawer` 的列表 SHALL 涵盖该 platform 下的全部 `models` 行，无论 `source`、无论 `enabled`。

#### Scenario: 两处入口打开同一 Drawer
- **WHEN** 维护者点击 Provider header 按钮，或点击该 Provider 下任一 KeyCard 上的按钮
- **THEN** 两次操作 SHALL 看到相同的模型列表（由 platform 过滤），可执行的操作集合相同

#### Scenario: Drawer 显示所有 source 与 enabled 状态
- **WHEN** Drawer 打开
- **THEN** 列表 SHALL 同时显示 `source ∈ {'migration', 'catalog', 'user'}` 的模型，`enabled = 0` 与 `enabled = 1` 的模型均显示

### Requirement: ManageModelsDrawer 按 source 区分删除按钮

`ManageModelsDrawer` 的每行模型 SHALL 提供与其 `source` 对应的销毁动作按钮：`source = 'user'` 显示"删除"按钮，点击后 SHALL 触发 `DELETE /api/models/:id`；`source ∈ {'catalog', 'migration'}` 显示"禁用"开关（toggle），切换后 SHALL 触发 `PATCH /api/models/:id` 修改 `enabled`，且 MUST NOT 显示硬删按钮。UI MUST 视觉化区分三种 source（例如徽章 `User` / `Catalog` / `Built-in` 或类似标识），让维护者一眼看出哪些可硬删、哪些只能禁用。

#### Scenario: user 模型显示"删除"按钮
- **WHEN** Drawer 渲染一行 `source='user'` 模型
- **THEN** 该行 SHALL 包含"删除"按钮，点击后 SHALL 调用 `DELETE /api/models/:id`

#### Scenario: catalog 模型不显示硬删按钮
- **WHEN** Drawer 渲染一行 `source='catalog'` 模型
- **THEN** 该行 SHALL NOT 包含硬删按钮；SHALL 包含"启用/禁用"开关

#### Scenario: source 标记可视化区分
- **WHEN** Drawer 渲染任意一行模型
- **THEN** UI SHALL 提供视觉提示（徽章、图标或文本标签）以区分 `source` 值
