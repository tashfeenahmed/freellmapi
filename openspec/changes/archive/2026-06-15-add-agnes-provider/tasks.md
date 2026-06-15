## 0. 执行前判断

**复杂度结论：**
简单需求

**Design 是否存在：**
是

**是否允许直接进入任务拆解：**
是

**Knowledge 是否需要更新：**
否

**说明：**
改动模式与现有 14 个 OpenAICompatProvider 注册完全一致，纯增量添加，无架构变更。

## 0.1 Knowledge 更新任务

- [x] 0.1.1 确认本次 change 受影响的 `config.yaml` 中 `knowledge.sources` 文档 — 无影响
- [x] 0.1.2 记录本次引用的 knowledge 证据、可信度和知识缺口 — 已在 explore.md 和 proposal.md 中记录
- [x] 0.1.3 如有需要，在本地 knowledge source 中编写或更新本次知识草稿 — 无需更新
- [x] 0.1.4 更新相关索引、映射文档或知识回写建议 — 无需更新

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 tasks.md 未明确声明的功能
- [x] 0.2.2 不做无关重构、顺手优化、无关格式化或批量改名
- [x] 0.2.3 不修改 proposal/specs/design 未覆盖的行为
- [x] 0.2.4 如发现 artifact 与代码事实冲突，先暂停并更新 artifact，再继续实施

## 1. Platform 类型扩展

**关联规格：**
- `provider-agnes` / AGNES AI 供应商注册

**关联设计决策：**
- Provider 实现方式: OpenAICompatProvider

**涉及文件或模块：**
- `shared/types.ts`

**验收方式：**
- TypeScript 类型检查通过

**回滚方式：**
- 删除 `'agnes'` 行即可

- [x] 1.1 在 `shared/types.ts` 的 `Platform` 联合类型中添加 `'agnes'`（按字母序）

## 2. Provider 注册

**关联规格：**
- `provider-agnes` / AGNES AI 供应商注册
- `provider-agnes` / AGNES API Key 健康检查

**关联设计决策：**
- Provider 实现方式: OpenAICompatProvider

**涉及文件或模块：**
- `server/src/providers/index.ts`

**验收方式：**
- TypeScript 类型检查通过
- `hasProvider('agnes')` 返回 `true`

**回滚方式：**
- 删除 register 调用即可

- [x] 2.1 在 `server/src/providers/index.ts` 中注册 AGNES 的 `OpenAICompatProvider` 实例（platform: `'agnes'`, name: `'Agnes AI'`, baseUrl: `'https://apihub.agnes-ai.com/v1'`）

## 3. 前端平台列表

**关联规格：**
- `provider-agnes` / AGNES AI 前端配置入口

**关联设计决策：**
- 无

**涉及文件或模块：**
- `client/src/pages/KeysPage.tsx`

**验收方式：**
- 前端构建通过
- Keys 页面下拉列表中出现 "Agnes AI" 选项

**回滚方式：**
- 删除 PLATFORMS 中对应的数组项

- [x] 3.1 在 `client/src/pages/KeysPage.tsx` 的 `PLATFORMS` 数组中添加 AGNES AI 选项（value: `'agnes'`, label: `'Agnes AI'`, url: `'https://platform.agnes-ai.com/settings/apiKeys'`）

## 4. 模型数据 Migration

**关联规格：**
- `model-agnes-2.0-flash` / agnes-2.0-flash 模型注册
- `model-agnes-2.0-flash` / agnes-2.0-flash 模型属性

**关联设计决策：**
- 模型数据来源: Migration (INSERT OR IGNORE)
- intelligence_rank: 4
- speed_rank: 2

**涉及文件或模块：**
- `server/src/db/migrations.ts`

**验收方式：**
- 服务启动后 `models` 表中存在 `platform='agnes', model_id='agnes-2.0-flash'` 记录
- 模型属性与 spec 中定义一致
- `fallback_config` 表中有对应的回退配置行

**回滚方式：**
- `DELETE FROM models WHERE platform='agnes'` 并撤销代码改动

- [x] 4.1 在 `server/src/db/migrations.ts` 中创建 `migrateModelsV27Agnes` 函数，使用 `INSERT OR IGNORE` 写入 `agnes-2.0-flash` 模型数据，并 backfill `fallback_config`
- [x] 4.2 在 `migrateDbSchema` 函数中调用 `migrateModelsV27Agnes`

## 5. 构建与验证

**关联规格：**
- 全部

**关联设计决策：**
- 无

**涉及文件或模块：**
- 全部改动文件

**验收方式：**
- TypeScript 类型检查通过
- Client 构建通过
- Server 构建通过
- 现有测试全部通过

**回滚方式：**
- `git revert`

- [x] 5.1 运行 `npm run typecheck`（或等效的类型检查命令），确认无新增类型错误
- [x] 5.2 运行 client 和 server 构建，确认构建通过
- [x] 5.3 运行现有测试套件，确认无回归

## 99. 最终自检

- [x] 所有任务都能追溯到 requirement、design decision 或 knowledge 更新项
- [x] 每个任务都有明确验收方式
- [x] 未包含无关重构、顺手优化或未授权范围
- [x] 已列出必要测试、验证和回滚任务
- [x] 如果存在开放问题，已标记为阻塞或非阻塞
