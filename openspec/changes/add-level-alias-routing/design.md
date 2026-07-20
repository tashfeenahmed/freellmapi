# Design: add-level-alias-routing

本文聚焦 proposal 第 8 节判定为"必需 design"的决策点。每个决策给出选项、取舍与落点，不写实现代码。

## 决策 1：五步解析的歧义消解顺序

**问题**：客户端 `model` 字段可能是 `auto` / `auto:xxx` / `high-level` / `glm5.2` / `gpt-5`（精确 model_id），按什么顺序判别？

**选项：**

| 顺序方案 | 行为 | 风险 |
|---|---|---|
| A. auto -> level -> alias -> model_id | 先档位后别名后精确 | alias 名撞档位名时档位优先；需保留字校验 |
| B. auto -> 精确 model_id -> level -> alias | 精确优先 | 一个 model_id 恰好叫 `high-level` 时永远走不到档位（理论可能） |
| C. 用前缀区分 `level:high` / `alias:glm5.2` | 无歧义 | 客户端写法冗长，偏离"裸名"初衷 |

**决策：A**。理由：
- 用户明确要裸名入口（`high-level` / `glm5.2`），否决 C。
- 档位名是固定三个受控集合，加保留字校验后不会与 alias 名碰撞；精确 model_id 历史上无 `*-level` 命名，B 的理论风险不存在实际收益。
- A 让"更宽的范围"优先于"更窄的范围"，符合"客户端意图从粗到细"的心智。

**落点**：`resolveRequestedModel(modelString)` 返回一个判别结果联合：
```
{ kind: 'auto' }                              // 走现有 resolveRoutingChain
{ kind: 'scoped-level', level: 'high'|'middle'|'low' }
{ kind: 'scoped-alias', aliasName: string }
{ kind: 'pinned', modelId: string }           // 现有 pin 路径
```
调用方据 kind 决定传不传 `prefetchedChain`、传不传 `preferredModel`。

**保留字校验**：alias CRUD 创建/改名时拒绝 `name ∈ {high-level, middle-level, low-level}`（大小写不敏感）。

## 决策 2：scoped-failover 复用 prefetchedChain 的接线方式

**问题**：档位/alias 路由的"组内优先 failover、用尽即报错"要不要在 routeRequest 里加新逻辑？

**关键事实（代码现状）**：
- `routeRequest` 收到 `prefetchedChain` 时直接用它（router.ts:590 `chain = prefetchedChain`），**不回退全局活动链**。
- `routeRequest` 遍历 sortedChain，跳过 skipModels/不满足 vision/tools/context 的条目；全跳过则循环落空、抛错（proxy.ts:729 catch 块返回 429 或 503）。
- pin 路径下 proxy.ts **不传 prefetchedChain**，routeRequest 才回退到 `getActiveChain()`——这就是 pin 全局 failover 的来源。

**决策：零新 failover 逻辑**。档位/alias 路径只需：
1. `resolveScopedChain()` 展开成 ChainRow[]，按 `aliases.priority, models.alias_priority` 排好序（组内优先天然成立——同一 alias 的实例在数组里连续）。
2. proxy.ts 把这条链作为 `prefetchedChain` 传入 routeRequest，**不传 preferredModel**。
3. routeRequest 现有循环 + 用尽抛错机制接管，failover 自动限定在展开链内。

**与 pin 路径的区分**（核心简化点）：

```
路径          prefetchedChain    preferredModel    failover 池
─────────────────────────────────────────────────────────────
auto          (resolveRoutingChain) undefined        全局活动链
level/alias   展开链              undefined        展开链 (用尽报错)
pin           undefined           model_db_id      全局活动链 (preferredModel 提到队首)
```

三套语义靠"传不传 prefetchedChain / preferredModel"两个开关自然区分，routeRequest 内部无需感知"这是 scoped 路由"。

**代价**：proxy.ts 现有 pin 分支（685-706 行查 model_id 设 preferredModel）需要前置一个 `resolveRequestedModel` 判别，按 kind 分流。anthropic.ts / responses.ts 同样接入。

## 决策 3：组内优先 failover 的排序键

**问题**：档位展开链里，多个 alias 之间、alias 内多个实例之间怎么排，才能"同一 alias 的实例连续、全挂才进下一个 alias"？

**决策**：SQL 层一次排好，`ORDER BY aliases.priority ASC, models.alias_priority ASC`。

- `aliases.priority`：同 level 内 alias 间的先后（用户手动设）。glm5.2 priority=0，deepseek-v4-pro priority=1 -> glm5.2 整组在前。
- `models.alias_priority`：alias 内 provider 实例间的先后（用户手动设）。

展开后的数组天然满足"同 alias 连续"：
```
[(a.priority=0, m.alias_priority=0), (0,1), (0,2), (a.priority=1, m.alias_priority=0), (1,1)]
 └──────── glm5.2 组 ────────────────┘  └──── deepseek-v4-pro 组 ────┘
```
routeRequest 从左到右试，glm5.2 三个全挂才进 deepseek-v4-pro——组内优先 failover 自然成立，无需额外分组逻辑。

**alias 路由**（`model:"glm5.2"`）：只查 `WHERE aliases.name=?`，按 `models.alias_priority` 排，是档位路由的"单组特例"。

## 决策 4：三入口共享 helper 的抽取位置

**问题**：proxy.ts / anthropic.ts / responses.ts 都要接入五步解析，helper 放哪？

**选项：**
- A. 放 `server/src/services/router.ts`（与 resolveRoutingChain/resolveScopedChain 同处）
- B. 新建 `server/src/services/requested-model.ts`
- C. 各 route 内联（重复三份）

**决策：A**。理由：
- `resolveScopedChain` 本来就在 router.ts，`resolveRequestedModel` 调用它和 `resolveRoutingChain`，同文件避免循环依赖。
- router.ts 已是路由解析的单一事实源，新增 helper 与现有 `resolveRoutingChain`/`getActiveChain` 同层。
- B 多一个文件无收益；C 违反 DRY 且三入口易漂移。

**暴露面**：router.ts 导出 `resolveRequestedModel(modelString): RequestedModelKind`，三入口调用。`RequestedModelKind` 类型也放 router.ts 或 shared/types.ts（后者更合适，client 也可能用）。

## 决策 5：alias 与 profile 两套分组机制的边界

**问题**：项目已有 profile（`profiles` + `profile_models`）表达"一组按 priority 排序的模型"。alias 跟 profile 都是"模型分组"，为什么不复用？

**决策：并存，不复用**。两者语义不同：

| 维度 | profile | alias |
|---|---|---|
| 语义 | 策略组（一组备选模型，用于 `auto:<profileName>`） | 同义模型组（同一逻辑模型的多 provider 实例） |
| 客户端入口 | `auto:<profileName>` | 裸名 `<aliasName>` |
| 成员关系 | 一个模型可属多个 profile（多对多） | 一个模型只属一个 alias（多对一） |
| 分层 | 单层 | 带 level 归属（alias.level） |
| 管理入口 | FallbackPage | ManageModelsDrawer |

复用 profile 会让 profile 承担双重身份（策略组 + 同义模型组），且 profile 无 level 概念、无多对一约束，强行加字段比新建 alias 表更乱。alias 表独立、语义干净，与 profile 正交。

**边界约束**：档位/alias 路由**只查 aliases 表**，不碰 profile_models；`auto:<profileName>` 仍只查 profile。两套机制数据流不交叉。

## 决策 6：用尽报错的错误码区分

**问题**：proxy.ts:729-744 现有 catch 块在 routeRequest 抛错时，有 lastError 返回 429 "All models rate-limited"，否则返回 err.status/503。档位/alias 链用尽时这个消息不准确（不是限流，是范围用尽）。

**选项：**
- A. 不区分，沿用现有消息（用尽时若有 lastError 仍显示 429）
- B. routeRequest 在链空/全 skip 时抛带特定 code 的错误，proxy.ts 识别后返回 503 "All models in <scope> exhausted"
- C. 区分"链空"（没有任何可用模型，503）与"链用尽"（有模型但全被 skip，429）

**决策：B**。理由：
- 档位/alias 用尽是"范围内无可用模型"，语义不是限流；返回 429 会误导客户端退避重试。
- routeRequest 已有抛错路径（`Model '...' not found` 等），加一个 `code: 'scope_exhausted'` 的错误符合现有模式。
- proxy.ts catch 块识别该 code 返回 503 + 描述当前 scope（level/alias 名）。
- pin/auto 路径行为不变（仍走现有 429/503 分支）。

**非目标**：不为档位/alias 路由新增独立的退避策略；用尽即终态，客户端应换 scope 或换模型。

## 决策 7：迁移可重复执行与 catalog-sync 兜底

**问题**：新表新列迁移要可重复执行；catalog-sync 持续写入 models 表，新模型 alias_id 怎么处理？

**决策：**
- `CREATE TABLE IF NOT EXISTS aliases (...)` + `ALTER TABLE models ADD COLUMN alias_id INTEGER REFERENCES aliases(id) ON DELETE SET NULL`（SQLite 的 ALTER TABLE ADD COLUMN 幂等性需在 migration 代码里检查 `PRAGMA table_info(models)` 是否已有该列，参考现有 migrateModelsVN 模式）。
- `alias_id` / `alias_priority` 默认 NULL / 0。
- catalog-sync 写 models 行时**不设 alias_id**（保持 NULL）。同步进来的模型不参与档位/alias 路由，只能走 `auto` 或精确 pin——符合决策"无 alias 不参与"。
- alias 删除时 `ON DELETE SET NULL`，模型行保留、alias_id 置空，自动退出档位/alias 路由。

**回滚**：新表新列不影响现有读取（alias_id NULL 兜底），回滚只需移除新代码；表结构可保留（无破坏性）。

## 决策 8：dead code 清理的影响面

**问题**：65a55ee 的 `findModelByName` 与 `routeRequest` 的 `strictModelId` 参数移除是否安全？

**事实核查**（已 grep 确认）：
- `strictModelId` 参数：三个调用方（proxy.ts:728、anthropic.ts:223、responses.ts:360）**均未传入**，始终 undefined。
- `findModelByName`：仅被 `routeRequest` 的 `if (strictModelId)` 分支调用，该分支永不触发。
- 无测试覆盖 `strictModelId` 路径（grep 测试目录无引用）。

**决策：直接删除**。`findModelByName` 整个函数 + `routeRequest` 的 `strictModelId` 参数 + `if (strictModelId)` 分支。零外部影响。新解析逻辑 `resolveScopedChain` / `resolveRequestedModel` 是全新代码，不基于 `findModelByName`（它只查单模型 LIMIT 1，与多模型展开语义不符）。

## 决策 9：UI 形态——复用 ManageModelsDrawer

**问题**：alias 管理放哪？

**决策：ManageModelsDrawer 内加"逻辑模型"分区，不新建独立页。**

- ManageModelsDrawer 现已是模型管理的一站式入口（27 symbols，含 ModelListRow / startEdit / SourceBadge 等）。
- 加一个 tab 或 section"逻辑模型"：列出所有 alias，行内可改名/设 level（下拉 high/middle/low）/设 priority/启停/删除，点 alias 展开看成员。
- 模型行（ModelListRow）加 alias 归属下拉（选已有 alias 或"无"）+ alias_priority 输入；与现有 displayName/contextWindow/supportsVision/supportsTools 编辑同处。
- 不放 FallbackPage：FallbackPage 管全局链/profile，概念正交（见决策 5）。
- 不新建页：Simplicity First，避免导航膨胀。

**AddCustomModelDialog**（添加自定义模型对话框）：加 alias 归属下拉，新建模型时可直接归组（可选）。

## 决策 10：requestedModel 解析的大小写与归一化

**问题**：客户端写 `High-Level` / `GLM5.2` 要不要归一化？

**决策：**
- Level 名匹配大小写不敏感（`high-level` / `High-Level` / `HIGH-LEVEL` 都命中 high 档），因为档位是固定受控集合。
- alias 名匹配大小写敏感（`glm5.2` ≠ `GLM5.2`），因为 alias.name 是用户自定义字符串，大小写敏感避免歧义。创建时保留原大小写。
- 精确 model_id pin 沿用现有行为（proxy.ts:689 `WHERE model_id = ?` 大小写敏感）。
- `auto` 判别沿用 `isAutoModel()`（已大小写不敏感）。

**保留字校验**同样大小写不敏感（拒绝 `High-Level` 作为 alias 名）。

## 风险与未决

- **风险**：alias.name 与未来新增的 model_id 命名碰撞（如某 provider 上线一个叫 `glm5.2` 的 model_id，而用户也建了同名 alias）。五步解析中 alias 优先于 model_id pin，会导致该 model_id 永远走 alias 路径。可接受（用户可改名 alias），但 UI 应在碰撞时提示。
- **未决**：alias 级别 sticky session（同会话粘同 alias）留作后续议题，本期 alias 路由每次都从 alias_priority=0 开始。
- **未决**：档位/alias 路由是否参与 context handoff。本期 handoff 仅对 auto 生效（proxy.ts:668 `isAutoRouted`），scoped 路由不注入 handoff，与 pin 一致。
