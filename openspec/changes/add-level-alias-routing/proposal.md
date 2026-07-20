## 1. 需求摘要

当前 freellmapi 的客户端模型路由只有两种形态：`auto`（全局活动链自动路由 + failover）和精确 `model_id` pin（指定模型提到活动链队首，失败后 failover 到**全局活动链**）。客户端无法表达"我要这个能力档位"或"我要这一组同义模型"这种介于"全自动"和"精确单个"之间的意图。

**机会**：引入两层显式命名空间，让客户端按任务复杂度寻址：
- **Level**（能力档位）：固定三档 `high-level` / `middle-level` / `low-level`，客户端指定档位即在该档位内路由。
- **逻辑模型 alias**：一个 alias 命名一组同义的多 provider 物理模型实例（如 `glm5.2` = provider1 的 `glm5.2` + provider2 的 `bailian/glm5-2` + provider3 的 `GLM5.2`），alias 继承一个 level。

客户端可写 `high-level`（档位路由）、`glm5.2`（逻辑模型路由）、`gpt-5`（现有精确 pin）、`auto`（现有全局）。档位/alias 路由采用**组内优先 failover、用尽即报错、不跨组不降级**语义；pin 与 auto 行为不变，向后兼容。

**为什么现在做**：commit 65a55ee 曾尝试加 `strictModelId` 严格模式但**从未接线**（三个调用方都没传该参数），是 dead code。本次在清理它的同时，落地真正可用的"客户端显式范围路由"能力，且复用现有 `prefetchedChain` + routeRequest 用尽抛错机制，改动聚焦在解析层。

## 2. 当前工程范围与边界

**纳入范围：**
- 新增 `aliases` 表（id / name / level / priority / enabled）与 `models` 表两列（`alias_id` / `alias_priority`）
- alias CRUD API（列表、新建、改名、设 level、设 priority、启停、删除）
- `requestedModel` 五步解析：`auto` → level → alias → model_id pin → 400
- 档位/alias 路由的组内优先 failover 与用尽报错语义
- 三个协议入口（`/v1/chat/completions`、`/v1/messages`、`/v1/responses`）统一接入新解析
- ManageModelsDrawer 内新增"逻辑模型"管理分区 + 模型行 alias 归属下拉
- 清理 65a55ee 的 `findModelByName` / `strictModelId` dead code

**不纳入范围：**
- 跨档位降级（high-level 用尽不自动回退 middle-level）
- 自动按 `intelligence_rank` 归档（level 完全由用户手动指定，不校验与 rank 是否吻合）
- 自定义档位名（固定三档 high/middle/low）
- 一个物理模型归属多个 alias（多对一，一个模型只能归一个 alias）
- 现有 `auto` / `auto:<globalAlias>` / `auto:<profileName>` / 精确 pin 行为的任何改变
- catalog-sync 自动给同步进来的模型归 alias（同步进来的模型 `alias_id = NULL`，不参与档位/alias 路由）

## 3. 业务语义拆解

**核心业务对象：**

| 对象 | 语义 | 客户端可寻址 |
|------|------|-------------|
| Level（档位） | 能力档位，固定三档 | ✅ `high-level` / `middle-level` / `low-level` |
| 逻辑模型 alias | 一组同义多 provider 物理模型实例的命名容器，继承一个 level | ✅ `glm5.2` |
| 物理模型实例 | models 表一行（platform + model_id），归属一个 alias（可空） | ✅ 精确 model_id pin（现有） |

**层次关系：**

```
Level (high-level)
 └─ alias (glm5.2)            [aliases.level = 'high', aliases.priority = 0]
     ├─ models 行 (provider1, model_id="glm5.2")        [alias_priority = 0]
     ├─ models 行 (provider2, model_id="bailian/glm5-2") [alias_priority = 1]
     └─ models 行 (provider3, model_id="GLM5.2")         [alias_priority = 2]
 └─ alias (deepseek-v4-pro)   [aliases.level = 'high', aliases.priority = 1]
     ├─ models 行 (provider1, model_id="deepseek/deepseek-v4-pro")
     └─ models 行 (provider2, model_id="huoshan/deepseek-v4-pro")
```

**关键业务规则：**
1. Level 固定三档 `high` / `middle` / `low`；新建 alias 时 `level` 默认 `low`。
2. alias.name 保留字校验：不能等于 `high-level` / `middle-level` / `low-level`（避免与档位入口碰撞）。
3. `models.alias_id` 可空；为空的模型**不参与**档位/alias 路由，只能走 `auto` 或精确 pin。
4. 档位/alias 路由的 failover 严格限定在展开链内，用尽即报错；**不跨档位降级，不跨 alias，不回退全局活动链**。
5. 档位内多个 alias 之间按 `aliases.priority` 升序排列；alias 内多个 provider 实例按 `models.alias_priority` 升序排列。组内优先 failover = 同一 alias 的实例连续排列，全挂才进入下一个 alias。
6. 精确 `model_id` pin 行为不变：preferredModel 提到全局活动链队首，failover 池仍是全局活动链。
7. `auto` / `auto:xxx` 行为不变：走现有 `resolveRoutingChain`。

**关键场景：**
- 客户端 `model: "high-level"` → 展开该档位下所有 alias 的所有实例为一条有序链，组内优先 failover，全挂报错。
- 客户端 `model: "glm5.2"` → 展开该 alias 下所有实例为一条链，组内 failover，全挂报错。
- 客户端 `model: "gpt-5"` → 现有 pin 行为（preferredModel + 全局 failover），不变。
- 客户端 `model: "auto"` → 现有全局活动链，不变。
- 维护者在 UI 新建 alias `glm5.2`、设 level=high、把三个 provider 的模型行归到该 alias 并设 alias_priority。

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块或入口 | 备注 |
|---|---|---|---|
| alias 头表 | `aliases` 表 | `server/src/db/migrations.ts` MODIFY | 新建表 |
| 模型归属 alias | `models.alias_id` / `models.alias_priority` 列 | `server/src/db/migrations.ts` MODIFY | 加两列，`alias_id` FK ON DELETE SET NULL |
| alias 类型 | `Alias` interface | `shared/types.ts` NEW | id/name/level/priority/enabled |
| Model 扩展 | `Model` 加 `aliasId` / `aliasPriority` | `shared/types.ts` MODIFY | 可空 |
| alias CRUD API | `router.get/post/put/delete('/aliases')` | `server/src/routes/aliases.ts` NEW | 列表/新建/改名/设 level/priority/启停/删除 |
| 模型 CRUD 带 alias | `POST /api/models` 接受 `aliasId` / `aliasPriority` | `server/src/routes/models.ts` MODIFY | 设置模型归属 |
| 档位/alias 链展开 | `resolveScopedChain(kind, key)` | `server/src/services/router.ts` NEW | 返回 ChainRow[]，供 routeRequest 作 prefetchedChain |
| requestedModel 五步解析 | `resolveRequestedModel(modelString)` | `server/src/routes/proxy.ts` NEW（或共享 helper） | auto → level → alias → pin → 400 |
| Anthropic 入口解析 | 同上 helper | `server/src/routes/anthropic.ts` MODIFY | 接入五步解析 |
| Responses 入口解析 | 同上 helper | `server/src/routes/responses.ts` MODIFY | 接入五步解析 |
| dead code 清理 | 删除 `findModelByName` / `strictModelId` 参数 | `server/src/services/router.ts` MODIFY | 65a55ee 未接线代码 |
| alias 管理 UI | "逻辑模型"分区 + 模型行 alias 下拉 | `client/src/pages/components/ManageModelsDrawer.tsx` MODIFY | 复用现有抽屉，不新建页 |

## 5. 变更清单

1. **修改** `server/src/db/migrations.ts` - 新增 `aliases` 表 + `models` 加 `alias_id`/`alias_priority` 两列（新 migration 版本）
2. **新增** `server/src/routes/aliases.ts` - alias CRUD API
3. **修改** `server/src/app.ts` - 注册 aliases 路由
4. **修改** `server/src/routes/models.ts` - 模型 CRUD 接受/返回 `aliasId`/`aliasPriority`
5. **新增** `server/src/services/router.ts` - `resolveScopedChain()` 展开 level/alias 为 ChainRow[]
6. **修改** `server/src/services/router.ts` - 删除 `findModelByName` 与 `routeRequest` 的 `strictModelId` 参数
7. **新增** `server/src/routes/proxy.ts`（或共享 helper）- `resolveRequestedModel()` 五步解析
8. **修改** `server/src/routes/proxy.ts` - level/alias 路径把展开链作为 `prefetchedChain` 传入 routeRequest，不传 preferredModel
9. **修改** `server/src/routes/anthropic.ts` - 接入 `resolveRequestedModel`
10. **修改** `server/src/routes/responses.ts` - 接入 `resolveRequestedModel`
11. **修改** `shared/types.ts` - `Alias` 类型 + `Model` 扩展两字段
12. **修改** `client/src/pages/components/ManageModelsDrawer.tsx` - "逻辑模型"分区 + 模型行 alias 下拉
13. **修改** `client/src/lib/api.ts` - alias CRUD 客户端方法

## 6. 追踪关系

| 业务目标 | 变更点 | Capability | 影响对象 | 验收口径 |
|---|---|---|---|---|
| 客户端按档位寻址 | level 链展开 + 五步解析 | `scoped-model-routing` | router.ts + 三入口 | `model:"high-level"` 命中该档位所有 alias 的实例，组内优先 failover |
| 客户端按逻辑模型寻址 | alias 链展开 | `scoped-model-routing` | router.ts + 三入口 | `model:"glm5.2"` 命中该 alias 所有实例，组内 failover |
| 用尽即报错不降级 | prefetchedChain 限定链 | `scoped-model-routing` | proxy.ts | 档位/alias 链全挂返回错误，不回退全局活动链 |
| alias 数据模型 | aliases 表 + models 两列 | `logical-model-alias` | migrations + types | 表结构与 FK 正确，迁移可重复执行 |
| alias 管理 API | CRUD 端点 | `logical-model-alias` | aliases.ts + app.ts | 列表/新建/改名/设 level/priority/启停/删除可用，保留字校验生效 |
| 模型归属 alias | models CRUD 带 aliasId | `logical-model-alias` | models.ts | 模型行可设置/清除 alias 归属与 alias_priority |
| 维护者配置映射 | ManageModelsDrawer 改造 | `alias-management-ui` | client | UI 能新建 alias、设 level/priority、把模型归到 alias |
| 向后兼容 | pin/auto 行为不变 | `scoped-model-routing` | proxy.ts | `model:"gpt-5"` 与 `model:"auto"` 行为与现状一致 |
| 清理 dead code | 删除 65a55ee 未接线代码 | `scoped-model-routing` | router.ts | `strictModelId` 参数与 `findModelByName` 移除，测试全绿 |

## 7. Capabilities

### 新增 Capabilities
- `logical-model-alias`: alias 头表与模型归属的数据模型和 CRUD API。`aliases` 表存储 name/level(high|middle|low, default low)/priority/enabled；`models` 表加 `alias_id`(FK SET NULL)/`alias_priority` 两列。提供 alias 的列表/新建/改名/设 level/设 priority/启停/删除端点，以及模型 CRUD 对 alias 归属的读写。alias.name 保留字校验（不可等于三档位名）。无 alias 的模型不参与档位/alias 路由。
- `scoped-model-routing`: 客户端用 level 名或 alias 名路由的能力。`requestedModel` 五步解析（auto → level → alias → model_id pin → 400）。档位/alias 路由把展开的 ChainRow[] 作为 `prefetchedChain` 传入 routeRequest，failover 严格限定在展开链内、组内优先、用尽即报错（不跨档位、不跨 alias、不回退全局）。pin 与 auto 行为不变。三协议入口（chat/messages/responses）统一接入。清理 65a55ee 的 `findModelByName`/`strictModelId` dead code。
- `alias-management-ui`: ManageModelsDrawer 内的 alias 管理。新增"逻辑模型"分区集中管理 alias（新建/改名/设 level/设 priority/启停/删除），模型行增加 alias 归属下拉（选已有 alias 或留空）与 alias_priority 输入。复用现有抽屉，不新建独立页。

## 8. 复杂度判定

**复杂度结论：** 复杂需求

**判定依据：**
- [x] 涉及两个及以上模块、服务或分层（DB 迁移层、shared 类型层、router 服务层、三协议 routes 层、client UI 层）
- [x] 涉及接口协议、数据结构、存储模型变化（新建表、加列、新 API、新 UI 分区）
- [x] 涉及迁移、灰度、回滚、兼容处理（新表新列需可重复执行迁移；pin/auto 向后兼容；catalog-sync 进来的模型 alias_id=NULL 兜底）
- [ ] 涉及安全、性能、并发、缓存、幂等等专项权衡
- [x] 仅依靠 proposal + specs 无法稳定拆出 tasks（五步解析的歧义消解顺序、组内优先 failover 的排序键、三入口共享 helper 的抽取位置、用尽报错错误码区分需要 design）

**Design 是否必需：** 必需

**说明：** 跨五层改动、新表新列、三协议入口统一解析、与现有 pin/auto/catalog-sync 的边界都需要详细设计。特别是五步解析的歧义消解、scoped-failover 复用 prefetchedChain 的接线方式、alias 与 profile 两套分组机制的边界。

## 9. Knowledge 使用与影响

**本次使用的 Knowledge：**
- 无外部库或文档依赖

**本次受影响的 Knowledge：**
- 无（不涉及已有 knowledge 文档的修改）

**是否需要新增 Knowledge 文档：** 否

## 10. 影响评估

**新增文件：**
- `server/src/routes/aliases.ts`
- （可能）`server/src/services/requested-model.ts` - 三入口共享的五步解析 helper（位置见 design）

**修改文件：**
- `server/src/db/migrations.ts` - 新 migration：aliases 表 + models 两列
- `server/src/app.ts` - 注册 aliases 路由（1 行）
- `server/src/routes/models.ts` - CRUD 读写 aliasId/aliasPriority
- `server/src/services/router.ts` - 新增 `resolveScopedChain`，删除 `findModelByName`/`strictModelId`
- `server/src/routes/proxy.ts` - 接入五步解析，level/alias 路径传 prefetchedChain
- `server/src/routes/anthropic.ts` - 接入五步解析
- `server/src/routes/responses.ts` - 接入五步解析
- `shared/types.ts` - `Alias` 类型 + `Model` 扩展
- `client/src/pages/components/ManageModelsDrawer.tsx` - 逻辑模型分区 + 模型行 alias 下拉
- `client/src/lib/api.ts` - alias CRUD 客户端方法

**不影响：**
- 现有 `auto` / `auto:xxx` 路由、profile/fallback_config 机制、scoring、rate limiting、context handoff、catalog-sync 主流程
- 现有 `ChatMessage` 类型、Provider 实现、流式适配器
- 现有精确 `model_id` pin 的外部可观察行为

**测试影响：**
- 新增 `server/src/__tests__/routes/aliases.test.ts`、`server/src/__tests__/services/scoped-routing.test.ts`
- 新增 `server/src/__tests__/routes/proxy-scoped-model.test.ts`（覆盖 level/alias/pin/auto 四路径 + 用尽报错 + 三入口）
- 现有测试全量回归（含 proxy-pinned-model / proxy-auto-model / routing-exhaustion）

## 11. 非目标与后续议题

- **非目标**：跨档位降级（high 用尽不自动回退 middle）
- **非目标**：按 intelligence_rank 自动归档或校验
- **非目标**：自定义档位名
- **非目标**：一个物理模型归属多个 alias
- **非目标**：catalog-sync 自动归 alias
- **后续议题**：alias 级别的 sticky session（同一会话粘在同一 alias）
- **后续议题**：alias 级别启停（整组禁用）已在本期 enabled 字段预留，UI 可后补
- **后续议题**：档位级别的负载统计与展示

## 12. 阶段自检

- [x] 已说明为什么要做以及本工程负责哪一部分
- [x] 已明确纳入范围 / 不纳入范围
- [x] 每个 capability 都有清晰边界，且不是简单模块名
- [x] 每个 capability 都能追溯到业务目标和变更点
- [x] 已判断 design 是否必需（必需）
- [x] 未写入具体实现代码或过细任务
- [x] 已列出仍需确认的问题，且不阻塞 specs 的事项已标明
