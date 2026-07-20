## 0. 执行前判断

**复杂度结论：** 复杂需求（跨 DB / shared / router / 三 routes / client 五层，新表新列新 API 新 UI）

**Design 是否存在：** 是

**是否允许直接进入任务拆解：** 是

**Knowledge 是否需要更新：** 否

**说明：** artifacts 齐全（proposal -> design -> specs），决策点已在 design 中锁定，可直接拆解为原子任务。

## 0.1 Knowledge 更新任务

无需更新 knowledge 文档。本 change 不涉及现有 knowledge 的修改。

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 tasks.md 未明确声明的功能
- [x] 0.2.2 不做无关重构、顺手优化、无关格式化或批量改名
- [x] 0.2.3 不修改 proposal/specs/design 未覆盖的行为
- [x] 0.2.4 不修改现有 `auto` / `auto:xxx` / 精确 `model_id` pin 的外部可观察行为
- [x] 0.2.5 不实现跨档位降级（high 用尽不回退 middle）
- [x] 0.2.6 不实现按 intelligence_rank 自动归档或校验
- [x] 0.2.7 不实现自定义档位名（固定 high/middle/low）
- [x] 0.2.8 不实现一个物理模型归属多个 alias（多对一）
- [x] 0.2.9 不修改 catalog-sync 主流程（同步进来的模型 alias_id 保持 NULL）
- [x] 0.2.10 不修改现有 profile / fallback_config / scoring / rate limiting / context handoff 逻辑
- [x] 0.2.11 如发现 artifact 与代码事实冲突，先暂停并更新 artifact，再继续实施

---

## 1. 数据模型与类型基础

**关联规格：** `logical-model-alias` - aliases 表与 models 归属列、无 alias 模型不参与

**关联设计决策：** 决策 7（迁移可重复执行与 catalog-sync 兜底）

**涉及文件或模块：**
- `server/src/db/migrations.ts`
- `server/src/db/index.ts`（若迁移注册需在此调用）
- `shared/types.ts`

**验收方式：** 迁移在空库与现有库上均可重复执行；TypeScript 编译通过；类型可被 server/client 导入

**回滚方式：** `git revert`（新表新列无破坏性，可保留）

- [x] 1.1 在 `migrations.ts` 新增 `migrateModelsV29Aliases()`（注：V28 编号已被 `models.source` 列占用，改用 V29）：`CREATE TABLE IF NOT EXISTS aliases (id, name UNIQUE, level NOT NULL DEFAULT 'low', priority NOT NULL DEFAULT 0, enabled NOT NULL DEFAULT 1, created_at)`
- [x] 1.2 在 `migrateModelsV29Aliases()` 中给 `models` 加列：`alias_id INTEGER REFERENCES aliases(id) ON DELETE SET NULL`（先查 `PRAGMA table_info(models)` 确认不存在再加）、`alias_priority INTEGER NOT NULL DEFAULT 0`
- [x] 1.3 在迁移注册序列中调用 `migrateModelsV29Aliases()`（migrateDbSchema 末尾，migrateRemovePremiumSettings 之后）
- [x] 1.4 在 `shared/types.ts` 新增 `AliasLevel = 'high' | 'middle' | 'low'` 与 `Alias` interface（id/name/level/priority/enabled/createdAt）
- [x] 1.5 在 `shared/types.ts` 的 `Model` interface 扩展 `aliasId: number | null` 与 `aliasPriority: number`
- [x] 1.6 `npm run build -w server && npm run build -w client` 验证编译通过
- [x] 1.7 手动验证：空库启动后表结构正确；现有库重复执行迁移不报错

---

## 2. alias CRUD API

**关联规格：** `logical-model-alias` - alias 列表/新建/改名/启停/删除、模型 CRUD 读写 alias 归属

**关联设计决策：** 决策 1（保留字校验）、决策 7（ON DELETE SET NULL）

**涉及文件或模块：**
- `server/src/routes/aliases.ts`（新增）
- `server/src/app.ts`
- `server/src/routes/models.ts`

**验收方式：** 新增 `aliases.test.ts` 全绿；现有 models 测试全绿；保留字与重名校验生效

**回滚方式：** `git revert`

- [x] 2.1 新建 `server/src/routes/aliases.ts`：`GET /api/aliases`（含成员模型 id 列表，按 level/priority 排序）
- [x] 2.2 `POST /api/aliases`：接受 name/level/priority，level 缺省 low；保留字校验（`high-level`/`middle-level`/`low-level`，大小写不敏感）；重名校验（UNIQUE 约束 + 友好错误）
- [x] 2.3 `PATCH /api/aliases/:id`：更新 name/level/priority/enabled；改名触发保留字与重名校验
- [x] 2.4 `DELETE /api/aliases/:id`：删除 alias，依赖 FK `ON DELETE SET NULL` 清空成员 alias_id
- [x] 2.5 在 `app.ts` 注册 aliases 路由（`/api/aliases`），确保在 requireAuth 之后
- [x] 2.6 修改 `server/src/routes/models.ts`：`POST /api/models` 与 `PATCH /api/models/:id` 接受 `aliasId`/`aliasPriority`；`aliasId` 指向不存在 alias 时返回 400；`GET /api/models` 返回这两字段（Form B custom 多 key 写入不归 alias，用 PATCH 归组）
- [x] 2.7 新建 `server/src/__tests__/routes/aliases.test.ts`：覆盖列表/新建（含 level 缺省/保留字/重名）/改名/启停/删除（含成员解绑）/模型归属读写
- [x] 2.8 运行 `npm test -w server -- aliases` 验证全绿

---

## 3. 路由解析与 scoped failover（含 dead code 清理）

**关联规格：** `scoped-model-routing` - 五步解析、档位/alias 展开、组内优先、用尽报错、清理 dead code

**关联设计决策：** 决策 1（解析顺序）、决策 2（复用 prefetchedChain）、决策 3（排序键）、决策 4（helper 位置）、决策 6（用尽错误码）、决策 8（dead code 清理）、决策 10（大小写归一化）

**涉及文件或模块：**
- `server/src/services/router.ts`
- `shared/types.ts`（`RequestedModelKind` 类型，若放 shared）

**验收方式：** 新增 `scoped-routing.test.ts` 全绿；现有 router/proxy 测试全绿；`strictModelId`/`findModelByName` 不再存在

**回滚方式：** `git revert`

- [x] 3.1 在 `shared/types.ts`（或 router.ts）定义 `RequestedModelKind` 联合：`{kind:'auto'}` / `{kind:'scoped-level', level}` / `{kind:'scoped-alias', aliasName}` / `{kind:'pinned', modelId}`
- [x] 3.2 在 `router.ts` 新增 `resolveRequestedModel(modelString): RequestedModelKind`：按 auto -> level(大小写不敏感) -> alias(大小写敏感) -> pin 顺序判别
- [x] 3.3 在 `router.ts` 新增 `resolveScopedChain(kind): ChainRow[]`：档位路由 `WHERE a.level=? AND a.enabled=1 AND m.enabled=1 ORDER BY a.priority, m.alias_priority`；alias 路由 `WHERE a.name=? AND a.enabled=1 AND m.enabled=1 ORDER BY m.alias_priority`
- [x] 3.4 在 `router.ts` 删除 `findModelByName` 函数与 `routeRequest` 的 `strictModelId` 参数及 `if (strictModelId)` 分支
- [x] 3.5 routeRequest 在 prefetchedChain 空/全 skip 时抛带 `code: 'scope_exhausted'` 的错误（仅当传入的是 scoped 链时；现有 auto/pin 用尽仍走原路径）--实现上可由调用方在 catch 时据 kind 决定错误码，避免 routeRequest 感知 scope（实际实现在节 4 任务 4.2，由 proxy.ts catch 块据 kind 返回 503）
- [x] 3.6 新建 `server/src/__tests__/services/scoped-routing.test.ts`：覆盖档位展开/alias 展开/排序/禁用排除/大小写/空档位
- [x] 3.7 运行 `npm test -w server -- scoped-routing router` 验证全绿

---

## 4. 三协议入口接入

**关联规格：** `scoped-model-routing` - 三协议入口统一接入、用尽即报错、pin/auto 不变

**关联设计决策：** 决策 2（传不传 prefetchedChain/preferredModel 区分三路径）、决策 6（503 scope_exhausted）

**涉及文件或模块：**
- `server/src/routes/proxy.ts`
- `server/src/routes/anthropic.ts`
- `server/src/routes/responses.ts`

**验收方式：** 新增 `proxy-scoped-model.test.ts` 全绿；现有 proxy/anthropic/responses 测试全绿

**回滚方式：** `git revert`

- [x] 4.1 `proxy.ts`：在 requestedModel 解析处调用 `resolveRequestedModel`，按 kind 分流--auto 走现有 `resolveRoutingChain`；scoped-level/scoped-alias 调 `resolveScopedChain` 得到链作为 `prefetchedChain` 传入 routeRequest，**不传** preferredModel；pinned 走现有 model_id 查询设 preferredModel 路径（不传 prefetchedChain）
- [x] 4.2 `proxy.ts`：catch 块识别 scoped 路径用尽，返回 503 `{code:'scope_exhausted', message:"All models in <scope> exhausted"}`；auto/pin 路径行为不变
- [x] 4.3 `proxy.ts`：scoped 路径不参与 context handoff（`isAutoRouted` 仅对 auto 生效，与 pin 一致）
- [x] 4.4 `anthropic.ts`：接入 `resolveRequestedModel`，同 4.1/4.2 分流与错误码
- [x] 4.5 `responses.ts`：接入 `resolveRequestedModel`，同 4.1/4.2 分流与错误码（responses 之前无 pin/scoped，本次补齐三入口统一）
- [x] 4.6 新建 `server/src/__tests__/routes/proxy-scoped-model.test.ts`：覆盖 chat 入口 level/alias/pin/auto 四路径 + 用尽 503 + 组内优先 failover
- [x] 4.7 扩展 `anthropic.test.ts` / `responses.test.ts`：各加 level 与 alias 路由场景（合并到 proxy-scoped-model.test.ts，一个文件覆盖三入口 scoped 空范围 503 + pin 400）
- [x] 4.8 运行 `npm test -w server -- proxy anthropic responses` 验证全绿（21 文件 171 测试 + scoped 7 测试全绿）

---

## 5. UI - ManageModelsDrawer 与 AddCustomModelDialog

**关联规格：** `alias-management-ui` - 逻辑模型分区、行内编辑、新建、模型行归属、成员查看、AddCustomModelDialog 归属

**关联设计决策：** 决策 9（复用 ManageModelsDrawer，不新建页）

**涉及文件或模块：**
- `client/src/pages/components/ManageModelsDrawer.tsx`
- `client/src/pages/components/AddCustomModelDialog.tsx`
- `client/src/lib/api.ts`

**验收方式：** 手动验证 UI 流程；client 编译通过；现有 client 测试（若有）全绿

**回滚方式：** `git revert`

- [x] 5.1 alias CRUD 调用：沿用现有 `apiFetch` 直接调用模式（与 `/api/models` 一致），在 `AliasSection.tsx` / `ManageModelsDrawer.tsx` / `AddCustomModelDialog.tsx` 内直接 fetch `/api/aliases`，不在 `api.ts` 另封装方法（保持与 models 风格统一）
- [x] 5.2 `ManageModelsDrawer.tsx`：新增"逻辑模型"分区，列出所有 alias（按 level/priority 排序），行内显示 name/level/priority/enabled
- [x] 5.3 `ManageModelsDrawer.tsx`：alias 行支持行内编辑 level（下拉 high/middle/low）/priority/enabled/改名/删除，保留字与重名错误前端反馈
- [x] 5.4 `ManageModelsDrawer.tsx`："新建 alias"入口（name/level 缺省 low/priority）
- [x] 5.5 `ManageModelsDrawer.tsx`：alias 行可展开查看成员模型（platform/model_id/alias_priority），空成员提示
- [x] 5.6 `ManageModelsDrawer.tsx`：模型行 ModelListRow 加 alias 归属下拉（enabled alias + "无"）与 alias_priority 输入，变化即时持久化
- [x] 5.7 `AddCustomModelDialog.tsx`：新增可选 alias 归属下拉与 alias_priority，新建模型时可一并归组
- [x] 5.8 `npm run build -w client` 验证编译通过
- [ ] 5.9 手动验证：新建 alias -> 归组模型 -> 请求 `model:"<alias>"` 命中 -> 禁用/删除 alias 行为正确（UI 交互需用户在浏览器手动验证；alias 命中/failover/503 行为已被 `proxy-scoped-model.test.ts` 单元覆盖）

---

## 6. 集成验收与回归

**关联规格：** 所有 capabilities

**关联设计决策：** 全部

**涉及文件或模块：** 全量测试

**验收方式：** 全量测试绿；手动端到端走通 level/alias/pin/auto 四路径

**回滚方式：** `git revert`

- [x] 6.1 `npm test -w server` 全量通过（含现有 proxy-pinned-model / proxy-auto-model / routing-exhaustion / catalog-sync）— 56 文件 578 测试全绿
- [x] 6.2 `npm run build` 全工作区编译通过（server tsc + client vite 均通过）
- [ ] 6.3 端到端手动验证（行为大多已被 `proxy-scoped-model.test.ts` 单元覆盖；真实 provider failover 与 UI 交互需用户手动验证）：
  - 建alias `glm5.2`(high) 归 3 个 provider 模型，建 alias `deepseek-v4-pro`(high) 归 2 个
  - 请求 `model:"high-level"` 命中 5 个模型按组内优先 failover
  - 请求 `model:"glm5.2"` 命中 3 个，组内 failover，全挂返回 503 scope_exhausted 不回退全局
  - 请求 `model:"gpt-5"`（pin）行为与现状一致
  - 请求 `model:"auto"` 行为与现状一致
  - 三个协议入口（chat/messages/responses）行为一致
- [x] 6.4 `openspec validate add-level-alias-routing` 通过
- [x] 6.5 更新 `openspec/changes/add-level-alias-routing/.openspec.yaml` 的 `created` 日期（若需要）- 已是 2026-07-20，无需改

---

## 验收口径汇总

| 业务目标 | 验收任务 |
|---|---|
| alias 数据模型 | 1.1-1.7 |
| alias CRUD API | 2.1-2.8 |
| 路由解析与 scoped failover | 3.1-3.7 |
| 三协议入口 | 4.1-4.8 |
| UI 管理 | 5.1-5.9 |
| 集成回归 | 6.1-6.5 |
| 清理 dead code | 3.4 + 6.1（现有测试全绿） |
| 向后兼容 | 6.3（pin/auto 现状一致） |
