## 1. 需求摘要

**问题：**

1. **Custom (OpenAI-compatible) 平台缺少创建后管理模型能力** — 其他 platform（groq、cerebras、google、…）通过 `POST/PATCH/DELETE /api/models` + `ManageModelsDrawer` 完整支持创建后增/删/禁用模型；custom 平台的模型只能在 `POST /api/keys/custom` 创建 key 时一次性写入，事后要改只能删 key 重建。`user-managed-models` capability 当前**显式拒绝** `platform='custom'`（`server/src/routes/models.ts:75`），把 custom 圈在体系外。

2. **KeysPage 把所有 custom key 揉在一个 group 里** — 当前 UI 用单一 `CUSTOM_GROUP` 容纳所有 custom key（`client/src/pages/KeysPage.tsx:64`）。当用户为多个不同的 OpenAI-compatible endpoint（local Ollama、SiliconFlow、自建 vLLM、…）各自配 key 时，全部混杂在一起，无法按"端点"维度审视。同 `base_url` 多 key 的兄弟关系（已由 `custom-key-management` 支持）也没有被视觉表达出来。

**机会：**
- 后端 `POST /api/models` 路径已经成熟（user-managed-models 提供），把它扩展到 custom 只需放开 platform 校验、body 增加 `keyIds[]` 维度、走既有 `scopedModelId` 写入约定。
- `models.source` 三分体系已经存在，custom 模型只需在创建路径打 `source='user'` 即可天然接入 PATCH/DELETE 语义。
- 前端 `ManageModelsDrawer` 已经具备列表/启用切换/删除 UI，custom 模式只是新增一种入参分支（按 base_url 而非 platform 过滤）。
- KeysPage 按 `base_url` 聚合是纯渲染层改动，`api_keys.base_url` 列已经存在（`ensureApiKeysBaseUrlColumn`）。

**为什么现在做：** custom 是用户接入自建/小众 provider 的主要通道；管理能力的缺口随 custom key 数量增长被持续放大。本次改动接触面集中在 5 个文件，不动 router / catalog-sync / fallback，是一次性收敛的好时机。

## 2. 当前工程范围与边界

**纳入范围：**
- 后端 `POST /api/keys/custom` 写 `models` 行时打 `source='user'`；
- 后端 migration 把现有 `platform='custom'` 行的 `source` 回填为 `'user'`；
- 后端 `POST /api/models` 解除 `platform='custom'` 拒绝分支；接受新的请求体形态 `{ keyIds: number[], modelId, displayName? }`；按 `scopedModelId` 写入；同 `(platform, modelId)` 已存在时执行 **UPDATE**（覆盖 `display_name`），不报 409；
- 前端 `KeysPage` 把 `customKeys` 按 `base_url` 二次 group-by，每个 base_url 渲染独立 group（带 header + 管理模型按钮）；
- 前端放开 KeysPage 中 `group.value !== 'custom'` 对管理模型按钮的阻挡（line 712 / 788）；
- 前端 `ManageModelsDrawer` 入参扩展为联合类型，custom 模式按 `key_id` 分小段渲染该 base_url 下所有 key 的 models；
- 前端 Drawer 在 custom 模式下提供两处"添加模型"入口：Drawer 顶部一个（默认全选 keys）+ 每个 key section 一个（默认只勾该 key）。

**不纳入范围：**
- 把 custom 在后端建模成独立 platform（router / catalog / fallback / scoring 概念层不动）；
- catalog-sync 接管 custom 模型（`platform='custom'` 不在远程 catalog 范畴内）；
- per-baseURL 的 fallback 优先级独立配置（仍走 `fallback_config` 现有 platform-level 语义）；
- desktop 客户端 UI 入口；
- custom key 的批量导入或 endpoint 模板预设；
- 自动探测 base_url 下可用模型的"模型发现"功能。

## 3. 业务语义拆解

**业务对象：**
- **Custom Endpoint** — 由唯一 `base_url` 标识的 OpenAI-compatible 服务地址，承载若干 key 与若干 model，**仅在 UI 层是聚合单位**，不进入后端建模。
- **Custom Model** — 绑定到具体 `key_id` 的模型行，`platform='custom'`，`model_id` 形如 `${keyId}-${rawId}`。

**业务规则：**

1. **Custom 模型一律 `source='user'`** — 既反映"维护者手加"的事实，又让 PATCH/DELETE 既有语义无差别覆盖；catalog-sync 不会涉及 `platform='custom'` 行，因此 source 升级路径不会触发。
2. **POST /api/models 多 key 写入语义（方案 c）** — body 提供 `keyIds: number[]` 数组，服务端在单事务内对每个 keyId 执行 INSERT；`(platform='custom', model_id=${keyId}-${modelId})` 已存在时执行 UPDATE，仅覆盖 `display_name`（其他字段不变）。响应区分 `created` 与 `updated`，让前端可向用户透明披露"3 个新增、2 个已存在已覆盖"。
3. **KeysPage 视觉重排不改后端** — 前端在 `[...PLATFORMS, ...customGroupsByBaseUrl]` 形态下渲染；非 custom platform 的 group 形态完全不变。
4. **管理模型入口对等** — 每个 base_url group 的 header 与该 group 下每张 KeyCard 都有"管理模型"按钮，三类入口打开同一个 Drawer，作用域均为该 base_url 下所有 key。Drawer 顶部"添加模型"默认全选 keys；每个 key section 内的"添加模型"默认只勾该 key —— 用户语义清晰、不会误操作。
5. **Drawer 列表渲染按 key 分小段** — 与"模型行 `key_id` 绑定"的数据事实直接对应；同一 modelId 在多个 key 上注册时各自在自己 section 出现，不做去重合并。

**关键场景：**
- (S1) 同 base_url 下 2 个 key，用户 Drawer 顶部加 `qwen3:8b` 默认全选 → `models` 增 2 行（`${kid1}-qwen3:8b`、`${kid2}-qwen3:8b`），各自 fallback_config 各 1 行，`source='user'`；
- (S2) 同 base_url 下 2 个 key，其中 key#11 已有 `qwen3:8b`，用户 Drawer 顶部再加 `qwen3:8b` 全选 → key#11 行 UPDATE（覆盖 displayName），key#12 行 INSERT；响应 `{ created:[12], updated:[11] }`；
- (S3) 用户在 Drawer 删除 key#11 上的 `qwen3:8b`（DELETE /api/models/:id）→ 仅该行被删，key#12 上的 `qwen3:8b` 不受影响；
- (S4) 用户禁用 key#11 上的 `qwen3:8b`（PATCH /api/models/:id `enabled=false`）→ 仅该行 enabled=0，路由对该模型在该 key 上跳过；
- (S5) 用户在 KeysPage 看到三个 custom group（local-ollama / siliconflow / 自建-vllm），每组下挂自己的 key 列表，clear 不混淆。

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块或入口 | 备注 |
|---|---|---|---|
| custom 模型一律 source=user | 创建路径写 `source='user'` | `server/src/routes/keys.ts` `POST /custom` 内的 INSERT 语句 | 一行参数变更 |
| 历史 custom 行回填 source | 新 migration `migrateCustomModelsSourceUser` | `server/src/db/migrations.ts` | `UPDATE models SET source='user' WHERE platform='custom'`，幂等 |
| custom 接入 POST /api/models | 解除 `platform === 'custom'` 拒绝；接受 `keyIds[]` | `server/src/routes/models.ts` `POST /` | 内部分支：keyIds 非空 → 走 custom 多写入路径 |
| 多 key 写入 + UPDATE-on-conflict | 单事务循环 keyIds，`INSERT ... ON CONFLICT DO UPDATE SET display_name=excluded.display_name` | 同上 | 复用 `keys.ts` 既有 scopedModelId 命名约定 |
| 响应区分 created / updated | handler 返回 `{ created: number[], updated: number[] }` | 同上 | 前端据此提示用户 |
| KeysPage 按 base_url 聚合 | 渲染前 `groupBy(customKeys, k => k.base_url)` 形成 N 个 custom group | `client/src/pages/KeysPage.tsx` 565 起的 `grouped` 构造 | 单一 `CUSTOM_GROUP` 改为 `customEndpointGroups` 数组拼到 `[...PLATFORMS, ...customEndpointGroups]` |
| 放开管理模型按钮阻挡 | 删 `group.value !== 'custom'` 条件 | 同文件 line 712 / 788 | custom group 走 customEndpoint 分支 |
| Drawer 入参联合类型 | `props: { kind:'platform', platform } \| { kind:'customEndpoint', baseUrl, keys[] }` | `client/src/pages/components/ManageModelsDrawer.tsx` | 内部根据 kind 选择列表查询与渲染 |
| Drawer custom 模式列表 | 用 `keys` 数组遍历，按 key_id 拉取该 key 的 models 渲染 | 同上 | GET /api/models 现已含 source 字段，能区分 user 行 |
| Drawer 顶部"添加模型"入口 | Drawer 顶部按钮，对话框 keys 列表默认全选 | 同上 | 提交后调 POST /api/models 带 keyIds |
| Drawer key section "添加模型"入口 | 每个 key section 内按钮，对话框默认仅勾该 key | 同上 | 提交后调 POST /api/models 带 `keyIds=[currentKeyId]` |
| 添加模型对话框组件 | 新组件 `AddCustomModelDialog`（或内嵌在 Drawer） | 同上 | 字段：modelId、displayName、keys 多选；提交后展示 created/updated 摘要 |

## 5. 变更清单

**新增：**
- `models.source = 'user'` 在 `POST /api/keys/custom` 创建路径上的设置；
- migration `migrateCustomModelsSourceUser`（回填历史 custom 行）；
- `POST /api/models` 的 `{ keyIds[], modelId, displayName? }` 请求体形态；
- `POST /api/models` 响应的 `created` / `updated` 字段；
- `KeysPage` 的 customEndpointGroups 渲染分支（按 base_url 一组）；
- `ManageModelsDrawer` 的 `kind:'customEndpoint'` 入参形态与按 key 分段渲染；
- Drawer 顶部 + key section 两处"添加模型"入口与对话框；
- 修改 `custom-key-management` 与 `user-managed-models` 两份 spec。

**修改：**
- `POST /api/keys/custom` handler 写 models 时附带 `source='user'` 字段；
- `POST /api/models` handler 解除 `platform='custom'` 拒绝；扩展 body schema 与写入分支；
- `KeysPage` 中 `[...PLATFORMS, CUSTOM_GROUP]` 改为按 base_url 展开 custom；
- `KeysPage` 中两处 `group.value !== 'custom'` 条件移除（让管理模型按钮在 custom 上也显示）。

**删除：**
- 无（`CUSTOM_GROUP` 常量保留为兜底，例如还没有任何 custom key 时仍可让 `CustomProviderSection` 表单分组挂在某处，或彻底删除——视实现时是否需要而定，由 design 锁定）。

## 6. 受影响的 capability spec

| Capability | 增减 |
|---|---|
| `custom-key-management` | ADDED 三条 Requirement（KeysPage base_url 聚合、Drawer 入口对等、Drawer 添加模型双入口） |
| `user-managed-models` | MODIFIED `POST /api/models` 相关 Requirement（解除 custom 拒绝、引入 keyIds 多写入、UPDATE-on-conflict）|
