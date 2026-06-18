<!-- 注意：以下英文区块标题与标记为 OpenSpec 解析器硬依赖，不能改成中文。正文内容请全部使用中文。 -->

## ADDED Requirements

### Requirement: Custom 模型创建路径标记 source='user'

The system SHALL set `source = 'user'` when inserting or updating model rows via `POST /api/keys/custom`, and SHALL provide an idempotent backfill migration for existing `platform = 'custom'` rows.

`POST /api/keys/custom` 在向 `models` 表插入或更新模型行时，SHALL 显式设置 `source = 'user'`。系统 SHALL 提供一次性数据回填 migration，将历史已存在的所有 `platform = 'custom'` 行的 `source` 字段更新为 `'user'`，且该 migration MUST 是幂等的（重复运行不产生差异）。

#### Scenario: 新建 custom key 时模型行 source 为 user
- **WHEN** 用户通过 `POST /api/keys/custom` 提交 baseUrl 与 1 个 model
- **THEN** 该 model 在 `models` 表中的对应行 SHALL 满足 `source = 'user'`

#### Scenario: 历史 custom 模型升级回填
- **WHEN** 系统启动时存在 `(platform='custom', source='migration')` 行，新 migration 运行后
- **THEN** 该行 SHALL 变为 `(platform='custom', source='user')`，且 PATCH/DELETE 接口能按 user 行语义处理它

#### Scenario: 重复运行 migration 不产生差异
- **WHEN** 升级 migration 运行第二次
- **THEN** 没有任何行被修改（changes count = 0）

---

### Requirement: POST /api/models 多 key 写入 custom 模型

The system SHALL accept `{ keyIds: number[], modelId: string, displayName?: string }` on `POST /api/models` and SHALL write one model row per keyId in a single transaction, using UPDATE-on-conflict that only touches `display_name`.

`POST /api/models` SHALL 接受新形态的请求体 `{ keyIds: number[], modelId: string, displayName?: string }`，用于一次性向同一 base_url 下多个 custom key 注册同名 model。系统 SHALL 在单个数据库事务内对每个 keyId 执行 INSERT；当 `(platform='custom', model_id='${keyId}-${modelId}')` 已存在时 SHALL 执行 UPDATE 仅覆盖 `display_name` 字段（不改 `enabled`、`key_id`、`source` 等其他字段）。响应体 SHALL 区分 `created: number[]`（新插入行的 id）与 `updated: number[]`（被覆盖 display_name 的已有行 id）。

新插入的 model 行 SHALL 同步获得对应的 `fallback_config` 行（`priority = MAX(priority) + 1`，`enabled = 1`）；UPDATE 命中已有 model 行时 MUST NOT 重复创建 `fallback_config` 行。

系统 SHALL 校验所有 keyIds：
- keyIds 为空数组 → 400
- 任一 keyId 在 `api_keys` 表中不存在 → 400
- 任一 keyId 不属于 `platform='custom'` → 400
- keyIds 跨不同 `base_url` → 400

#### Scenario: 多 key 全新写入
- **WHEN** 同 base_url 下存在 keys [11, 12]，用户 POST `{ keyIds: [11, 12], modelId: 'qwen3:8b', displayName: 'Qwen3 8B' }`
- **THEN** `models` 表 SHALL 增加两行：`(platform='custom', model_id='11-qwen3:8b', source='user')` 与 `(platform='custom', model_id='12-qwen3:8b', source='user')`；响应 SHALL 等于 `{ created: [<id1>, <id2>], updated: [] }`

#### Scenario: 重复提交触发 UPDATE
- **WHEN** 上一场景之后，用户再次 POST 相同 keyIds 与 modelId 但 displayName 改为 `'Q3-8B Updated'`
- **THEN** 两个 model 行的 `display_name` SHALL 被更新为 `'Q3-8B Updated'`；响应 SHALL 等于 `{ created: [], updated: [<id1>, <id2>] }`；`enabled` 与 `fallback_config` SHALL 保持不变

#### Scenario: 部分已存在
- **WHEN** key #11 已注册 `qwen3:8b`，key #12 未注册，用户 POST `{ keyIds: [11, 12], modelId: 'qwen3:8b' }`
- **THEN** 响应 SHALL 等于 `{ created: [<id_for_12>], updated: [<id_for_11>] }`

#### Scenario: 不复活用户禁用
- **WHEN** key #11 上 `qwen3:8b` 已被 PATCH 设置为 `enabled=0`，用户再次 POST `{ keyIds: [11], modelId: 'qwen3:8b' }`
- **THEN** 该 model 行的 `enabled` SHALL 保持 0（UPDATE 不覆盖 enabled）

#### Scenario: 跨 base_url 拒绝
- **WHEN** keys [11, 13] 分别属于不同的 base_url，用户 POST `{ keyIds: [11, 13], modelId: 'X' }`
- **THEN** 响应 SHALL 返回 400，错误消息含 'span multiple base_urls'

#### Scenario: 非 custom 平台拒绝
- **WHEN** keys [99] 属于 `platform='groq'`，用户 POST `{ keyIds: [99], modelId: 'X' }`
- **THEN** 响应 SHALL 返回 400

---

### Requirement: KeysPage 按 base_url 聚合 custom keys

KeysPage SHALL group custom-platform keys by `base_url` into independent endpoint groups, each with header `Custom · ${base_url}`, and SHALL still render `CustomProviderSection` when no custom keys exist.

`KeysPage` SHALL 在渲染 custom platform 的 keys 时，按 `base_url` 字段二次分组：每个唯一 `base_url` 渲染为一个独立的 group，header 显示 `Custom · ${base_url}`，下挂该 base_url 下所有 key 对应的 `KeyCard`。所有 custom endpoint groups SHALL 排在所有非 custom platform groups 之后。当用户没有任何 custom key 时，KeysPage SHALL 仍然显示 `CustomProviderSection`（创建 custom key 的表单）。

#### Scenario: 多 base_url 渲染独立 group
- **WHEN** 用户存在 keys：2 个属于 `http://localhost:11434/v1`、1 个属于 `https://api.siliconflow.cn/v1`
- **THEN** KeysPage SHALL 渲染两个 custom endpoint groups，header 分别为 `Custom · http://localhost:11434/v1`（含 2 张 KeyCard）与 `Custom · https://api.siliconflow.cn/v1`（含 1 张 KeyCard）

#### Scenario: 同一 base_url 下多 key 同组
- **WHEN** 用户为 `http://localhost:11434/v1` 添加第 2 个 key
- **THEN** 该 key 的 KeyCard SHALL 与已有 key 的 KeyCard 出现在同一个 group 内，而不是新开一个 group

#### Scenario: 无 custom key 时仍显示创建表单
- **WHEN** 用户尚未创建任何 custom key
- **THEN** KeysPage SHALL 仍显示 `CustomProviderSection`（base URL + models textarea + apiKey 输入框 + 提交按钮）

---

### Requirement: ManageModelsDrawer 支持 customEndpoint 模式

ManageModelsDrawer props SHALL be a discriminated union type supporting both `kind: 'platform'` and `kind: 'customEndpoint'` modes. The customEndpoint mode SHALL render models grouped by `key_id`, showing only rows for the keys belonging to the given base_url.

`ManageModelsDrawer` 的 props SHALL 是判别联合类型，至少包含 `kind: 'platform'`（普通 provider 模式）与 `kind: 'customEndpoint'`（custom 模式）两种形态。custom 模式下，Drawer SHALL 接受 `baseUrl: string` 与 `keys: ApiKey[]` 两个字段；列表 SHALL 仅展示 `platform = 'custom'` 且 `key_id IN keys.map(k => k.id)` 的 model 行；列表渲染 SHALL 按 `key_id` 分小段，每段 header 显示该 key 的 label。`KeysPage` SHALL 在以下三处入口打开同一个 Drawer 的 customEndpoint 模式：custom endpoint group header 上的「管理模型」按钮、该 group 下任一 KeyCard 上的「管理模型」按钮 —— 三处入口的 Drawer 内容 SHALL 完全相同（按 base_url 维度过滤）。

#### Scenario: 三处入口打开同一 Drawer
- **WHEN** 用户分别点击 custom endpoint group header 按钮、该 group 下两张 KeyCard 上的按钮
- **THEN** 三次操作 SHALL 看到相同的 customEndpoint Drawer 内容（按 base_url 过滤），按 key_id 分段顺序与可执行操作集合相同

#### Scenario: Drawer 仅显示该 base_url 下的模型
- **WHEN** 用户打开 base_url=A 的 Drawer
- **THEN** 列表 SHALL NOT 包含 base_url=B 下的任何 model 行

#### Scenario: 按 key 分段渲染
- **WHEN** Drawer 渲染含 2 keys（key#11、key#12）的 customEndpoint
- **THEN** 列表 SHALL 出现两个 section，section header 分别显示 key#11 与 key#12 的 label；同一 modelId 在两个 key 上注册时 SHALL 在各自的 section 内各显示一行（不去重合并）

---

### Requirement: ManageModelsDrawer 添加模型双入口

The customEndpoint mode of ManageModelsDrawer SHALL provide two equivalent add-model entry points (drawer-top and per-key-section), both opening the same `AddCustomModelDialog` component, differentiated by `defaultSelectedKeyIds`.

`ManageModelsDrawer` 的 customEndpoint 模式 SHALL 提供两处对等的「添加模型」入口：① Drawer 顶部一个全局「添加模型」按钮；② 每个 key section 内一个「添加模型」按钮。两处入口 MUST 打开同一个 `AddCustomModelDialog` 对话框组件，且 SHALL 通过 `defaultSelectedKeyIds` prop 控制 keys 多选 checklist 的初始勾选状态：顶部入口默认勾选该 base_url 下**全部** keys，section 内入口默认仅勾选**该 section 对应的 key**。对话框 SHALL 包含「全选 / 全不选」便捷按钮。提交后调用 `POST /api/models` 并向用户披露 `created` 与 `updated` 行数（toast 或类似反馈）。

#### Scenario: 顶部入口默认全选
- **WHEN** customEndpoint 含 2 keys，用户点击 Drawer 顶部「添加模型」按钮
- **THEN** 对话框 keys 列表 SHALL 默认勾选这 2 个 key

#### Scenario: section 入口默认仅勾自己
- **WHEN** 用户点击 key#11 section 内「添加模型」按钮
- **THEN** 对话框 keys 列表 SHALL 默认仅勾选 key#11

#### Scenario: 提交结果披露
- **WHEN** 用户在对话框输入 modelId 并提交，服务端响应 `{ created: [<id_a>], updated: [<id_b>] }`
- **THEN** UI SHALL 向用户展示「1 个新增，1 个已更新」（或等价的本地化文案），且 Drawer 列表 SHALL 自动刷新（react-query invalidate）

#### Scenario: 全选 / 全不选 便捷按钮
- **WHEN** 用户点击对话框内的「全选」按钮
- **THEN** keys 列表所有项 SHALL 被勾选；点击「全不选」时 SHALL 全部取消勾选
