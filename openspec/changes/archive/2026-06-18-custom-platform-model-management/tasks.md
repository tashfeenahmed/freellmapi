# Tasks — Custom Platform Model Management

## 0. 执行前判断

**复杂度结论：** 中等需求（DB migration 1 条 + backend route 2 处修改 + frontend KeysPage 重排 + Drawer 联合 props 重构 + 新对话框组件；不引入新业务规则，沿用既有 source 三分体系与 scopedModelId 命名约定）。

**Design 是否存在：** 是（`design.md` 已完成，决策表 §六 锁定 8 个选项）。

**是否允许直接进入任务拆解：** 是。

**Knowledge 是否需要更新：** 否。沿用 `custom-key-management` 与 `user-managed-models` 既有 spec，本次只增量。

## 0.1 Knowledge 更新任务

- [x] 0.1.1 确认本次 change 受影响的 knowledge 文档（结论：无新增 knowledge source；本次规则沉淀进 spec deltas）
- [x] 0.1.2 在 `proposal.md §6` 已声明受影响 capability 列表，无遗漏

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 tasks.md 未明确声明的功能（特别：不做 per-key model allowlist 精细化；不做模型自动发现；不做 endpoint 元数据；不动 router/catalog/fallback/scoring）
- [x] 0.2.2 不做无关重构、顺手优化、无关格式化或批量改名
- [x] 0.2.3 不修改 proposal/specs/design 未覆盖的行为（`POST /api/keys/custom` 创建 key 的 upsert 语义不变；DELETE custom key 的级联逻辑不变）
- [x] 0.2.4 如发现 artifact 与代码事实冲突，先暂停并更新 artifact，再继续实施

---

## 1. 后端：Custom 模型一律 source='user'

**关联规格：**
- `custom-key-management / Requirement: Custom 模型创建路径标记 source='user'`

**关联设计决策：**
- design §3.2 Migration
- design §六 决策 6, 7

- [x] 1.1 在 `server/src/db/migrations.ts` 新增 `migrateCustomModelsSourceUser(db)` 函数：`UPDATE models SET source='user' WHERE platform='custom' AND source!='user'`，幂等
- [x] 1.2 在 `runMigrations(db)` 中紧跟现有 source 列引入 migration 之后调用 1.1
- [x] 1.3 修改 `server/src/routes/keys.ts` `POST /custom` 内部 INSERT/UPDATE models 语句，附带 `source='user'`
- [x] 1.4 添加 unit test：新建一个 custom key + 1 个 model → 该 model 行 `source='user'`
- [x] 1.5 添加 migration test：预置一行 `(platform='custom', source='migration')`，运行 migration → 该行 `source='user'`

## 2. 后端：POST /api/models 接受 keyIds[] 形态

**关联规格：**
- `user-managed-models / Requirement: 维护者通过 POST /api/models 添加任意 provider 的模型`（MODIFIED）
- `custom-key-management / Requirement: POST /api/models 多 key 写入 custom 模型`（ADDED）

**关联设计决策：**
- design §二 场景 B
- design §4.1 跨端点写入校验
- design §4.2 UPDATE-on-conflict 范围
- design §五 校验与错误码

- [x] 2.1 解除 `server/src/routes/models.ts` `POST /` 的 `platform === 'custom'` 拒绝分支
- [x] 2.2 扩展 body schema：`{ platform, modelId, ... }`（旧）OR `{ keyIds: number[], modelId, displayName? }`（新）。两者互斥；keyIds 非空数组 → 走 custom 分支
- [x] 2.3 实现 custom 分支校验链：
  - keyIds 非空（否则 400）
  - 所有 keyIds 在 `api_keys` 表中存在且 `platform='custom'`（否则 400 + offending ids）
  - 所有 keyIds 共享同一 `base_url`（否则 400 + offending base_urls）
- [x] 2.4 实现 custom 分支单事务循环：对每个 keyId 执行 `INSERT INTO models ... ON CONFLICT(platform, model_id) DO UPDATE SET display_name=excluded.display_name`，并按 `changes`/`SELECT id` 判断是 INSERT 还是 UPDATE，分别推入 `created`/`updated` 数组；新插入行同步 `INSERT INTO fallback_config (model_db_id, priority=MAX+1, enabled=1)`
- [x] 2.5 返回 `{ created: number[], updated: number[] }`（HTTP 200）
- [x] 2.6 添加 integration test：
  - 单事务正常写入 2 keys → `{ created: 2, updated: 0 }`
  - 重复提交相同请求 → `{ created: 0, updated: 2 }`，displayName 已被覆盖
  - 部分已存在场景 → `{ created: 1, updated: 1 }`
  - keyIds 跨 base_url → 400
  - keyIds 含非 custom platform 的 id → 400

## 3. 前端：KeysPage 按 base_url 聚合 custom

**关联规格：**
- `custom-key-management / Requirement: KeysPage 按 base_url 聚合 custom keys`（ADDED）

**关联设计决策：**
- design §4.4 KeysPage 渲染顺序

- [x] 3.1 在 `client/src/pages/KeysPage.tsx` 565 起的 `grouped` 构造处，把单一 `CUSTOM_GROUP` 拆为：
  - `customEndpointGroups`：`Object.entries(groupBy(customKeys, k => k.base_url))` 形态的数组，每项形如 `{ kind: 'customEndpoint', baseUrl, label: 'Custom · ' + baseUrl, keys }`
  - 把 `customEndpointGroups` 拼到 `[...PLATFORMS, ...customEndpointGroups]`
- [x] 3.2 删除 line 712 / 788 上的 `group.value !== 'custom'` 阻挡，让管理模型按钮在 custom group 上也显示
- [x] 3.3 把现有 `CustomProviderSection`（创建表单）从 group 循环内提到外面，独立渲染在所有 group 之后（永久显示，即使没有任何 custom key）
- [x] 3.4 调整 group header 渲染：custom endpoint group 显示 `Custom · ${base_url}` 而非平台 label；保留与其他 platform 一致的「管理模型」按钮位置
- [ ] 3.5 视觉走查：3+ 不同 base_url 各挂 1–2 个 key，确认渲染分组正确、不混淆

## 4. 前端：ManageModelsDrawer 联合 props 与 customEndpoint 模式

**关联规格：**
- `custom-key-management / Requirement: ManageModelsDrawer 支持 customEndpoint 模式`（ADDED）

**关联设计决策：**
- design §4.3 添加模型对话框
- design §4.5 ManageModelsDrawer props 重构

- [x] 4.1 在 `client/src/pages/components/ManageModelsDrawer.tsx` 重构 props 为联合类型（参见 design §4.5）
- [x] 4.2 内部根据 `kind` 分支：
  - `kind='platform'`：保持现有行为（按 platform 拉模型列表）
  - `kind='customEndpoint'`：拉取 `platform='custom'` 且 `key_id IN keys.map(k=>k.id)` 的模型，按 `key_id` 分组渲染
- [x] 4.3 custom 模式渲染按 key 分小段：每段 header 显示 key 的 label 与 masked key 末位，下方列出该 key 的 models（每行：modelId / displayName / enabled toggle / 删除按钮 / source 徽章）
- [x] 4.4 适配 KeysPage 调用侧：把 `drawerPlatform` 状态改为 `drawerState`（联合类型），三个入口（普通 platform / custom endpoint header / custom KeyCard）写入对应分支

## 5. 前端：AddCustomModelDialog 添加模型对话框

**关联规格：**
- `custom-key-management / Requirement: ManageModelsDrawer 添加模型双入口`（ADDED）

**关联设计决策：**
- design §二 场景 B
- design §4.3 单组件多入口
- design §六 决策 4

- [x] 5.1 新建组件 `AddCustomModelDialog`（位置：`client/src/pages/components/AddCustomModelDialog.tsx`）。Props：`{ open, onClose, baseUrl, keys: ApiKey[], defaultSelectedKeyIds: number[] }`
- [x] 5.2 表单字段：modelId（必填）、displayName（可选）、keys 多选 checklist（含「全选 / 全不选」）
- [x] 5.3 提交：调 `POST /api/models`，body `{ keyIds, modelId, displayName }`
- [x] 5.4 提交结果 toast：`+${created.length} 个新增，${updated.length} 个已存在已更新 displayName`
- [x] 5.5 在 `ManageModelsDrawer` custom 模式下挂两个入口：
  - Drawer 顶部「添加模型」按钮，点击打开对话框，`defaultSelectedKeyIds = keys.map(k => k.id)`（默认全选）
  - 每个 key section header 旁「添加模型」按钮，`defaultSelectedKeyIds = [thatKey.id]`（默认仅自己）
- [x] 5.6 提交成功后 invalidate `['models']` 与 `['keys']` query；Drawer 列表自动刷新

## 6. 端到端验证

**关联规格：** 全部本次新增/修改的 Requirement

- [ ] 6.1 手工流程：建 2 个 key（同一 base_url）→ KeysPage 看到 1 个 custom group 含 2 个 KeyCard
- [ ] 6.2 手工流程：在 Drawer 顶部添加 modelId（默认全选 2 keys）→ 两 keys 各出现一行新模型
- [ ] 6.3 手工流程：再次提交相同 modelId 改了 displayName → toast 显示「2 个已更新」，列表 displayName 已变
- [ ] 6.4 手工流程：在某个 key section 删除一行模型 → 仅该行消失，兄弟 key 上的同名模型保留
- [ ] 6.5 手工流程：在某个 key section 禁用一行模型 → 路由跳过该 key 的该模型；启用其他 key 的同模型仍可路由
- [ ] 6.6 手工流程：删除一个 custom key → 该 key 的所有 models 级联清除，同 base_url 兄弟 key 保留
- [ ] 6.7 升级路径：从带历史 custom 模型（source ≠ 'user'）的库启动 → migration 自动回填 → 立即可在 Drawer 中看到「删除」按钮（user 行为）
- [ ] 6.8 旧路径回归：`POST /api/models` 用旧 body `{ platform:'groq', modelId:'X' }` 仍工作；`POST /api/models` 用 `{ platform:'custom', modelId:'X' }`（无 keyIds）仍 400

## 7. 文档与 spec 收敛

- [x] 7.1 在本目录下运行 `openspec verify` 通过 spec 自检
- [ ] 7.2 archive 时合入 `custom-key-management` 与 `user-managed-models` 主 spec
- [x] 7.3 README / docs 不强制更新（本变更对外行为是「自定义平台多了模型管理 UI」，无 breaking change，无 API 协议外露变更）
