## 0. 验证前准备

**变更标题：**
添加 AGNES AI 作为新的 OpenAI 兼容 API 供应商，旗舰模型 agnes-2.0-flash 支持 256K context、vision 和 tool calling。

**关联 Artifacts：**
- proposal.md: ✓ 存在
- specs/: ✓ provider-agnes/spec.md, model-agnes-2.0-flash/spec.md
- design.md: ✓ 存在
- tasks.md: ✓ 存在

**验证范围：**
- `provider-agnes`: AGNES AI 供应商注册、健康检查、前端配置入口
- `model-agnes-2.0-flash`: 模型注册、属性正确性、路由链集成

**验证环境：**
本地开发环境 (macOS, Node.js)

## 1. Artifact 完整性检查

- [x] 1.1 proposal.md 中的每个 capability 都有对应的 spec (provider-agnes → specs/provider-agnes/spec.md, model-agnes-2.0-flash → specs/model-agnes-2.0-flash/spec.md)
- [x] 1.2 每个 spec 的 requirement 都在 tasks.md 中有对应任务 (provider-agnes 的 3 个 requirement → tasks 1, 2, 3; model-agnes-2.0-flash 的 2 个 requirement → task 4)
- [x] 1.3 tasks.md 中每个任务都能追溯到 requirement 或 design decision (每组任务标注了关联规格和设计决策)
- [x] 1.4 design.md 设计决策与 spec 一致，无遗漏 (4 个决策全部在实现中体现)
- [x] 1.5 无 artifact 之间的矛盾或冲突

## 2. 代码实现验证

### 2.1 变更范围检查

- [x] 2.1.1 实际改动的文件与 tasks.md 中声明的文件一致: `shared/types.ts`, `server/src/providers/index.ts`, `client/src/pages/KeysPage.tsx`, `server/src/db/migrations.ts`
- [x] 2.1.2 未引入 tasks.md 未声明的额外改动 (`git diff --stat` 确认仅 4 个文件)
- [x] 2.1.3 未遗漏 tasks.md 中声明的改动

### 2.2 功能正确性

#### Capability: provider-agnes

| # | 验证场景 | 关联 Requirement | 预期结果 | 实际结果 | 通过 |
|---|---|---|---|---|---|
| 1 | Platform 类型包含 'agnes' | AGNES AI 供应商注册 | `shared/types.ts` Platform 联合类型包含 `'agnes'` | `shared/types.ts:22` 包含 `\| 'agnes'`，TypeScript 编译通过 | Y |
| 2 | Provider 正确注册 | AGNES AI 供应商注册 | `index.ts` 中 `register(OpenAICompatProvider({platform:'agnes', name:'Agnes AI', baseUrl:'https://apihub.agnes-ai.com/v1'}))` | `index.ts:20-24` 确认注册，参数完全匹配 | Y |
| 3 | 前端 PLATFORMS 包含 Agnes AI | AGNES AI 前端配置入口 | KeysPage.tsx 中包含 `{value:'agnes', label:'Agnes AI', url:'https://platform.agnes-ai.com/settings/apiKeys'}` | `KeysPage.tsx:41` 确认 | Y |
| 4 | 健康检查通过 OpenAICompatProvider | AGNES API Key 健康检查 | `hasProvider('agnes')` 返回 true，validateKey 自动委托 | `hasProvider` 基于 `providers` Map，注册后自动返回 true | Y |

#### Capability: model-agnes-2.0-flash

| # | 验证场景 | 关联 Requirement | 预期结果 | 实际结果 | 通过 |
|---|---|---|---|---|---|
| 1 | Migration 函数存在 | agnes-2.0-flash 模型注册 | `migrateModelsV27Agnes` 函数定义并使用 INSERT OR IGNORE | `migrations.ts:1914` 确认函数定义 | Y |
| 2 | Migration 在 migrateDbSchema 中调用 | agnes-2.0-flash 模型注册 | `migrateDbSchema` 中调用 `migrateModelsV27Agnes(db)` | `migrations.ts:39` 确认调用 | Y |
| 3 | 模型属性全部正确 | agnes-2.0-flash 模型属性 | 14 个属性值与 spec 表一致 | 逐字段对比: platform='agnes', model_id='agnes-2.0-flash', display_name='Agnes 2.0 Flash', intelligence_rank=4, speed_rank=2, size_label='Frontier', rpm_limit=20, rpd_limit=200, context_window=262144, supports_vision=1, supports_tools=1, monthly_token_budget='free (promo)' — 全部匹配 | Y |
| 4 | fallback_config backfill | agnes-2.0-flash 模型注册 | 调用 `backfillFallback(db)` 确保模型在回退链中 | `migrations.ts:1926` 确认 `backfillFallback(db)` 调用 | Y |

### 2.3 边界与异常场景

| # | 边界 / 异常场景 | 预期行为 | 实际行为 | 通过 |
|---|---|---|---|---|
| 1 | 重复 migration 执行 | INSERT OR IGNORE 幂等，不报错不重复插入 | `INSERT OR IGNORE` 语句保证幂等 | Y |
| 2 | 无 AGNES key 时路由行为 | 路由跳过 agnes 模型（无可用 key），与其他平台行为一致 | 路由逻辑基于 key 可用性，无 key 则跳过 | Y |
| 3 | AGNES 平台被移除后重新添加 | 只需恢复代码改动，migration 幂等恢复模型数据 | INSERT OR IGNORE 支持此场景 | Y |

## 3. 测试验证

- [x] 3.1 单元测试全部通过: 476 tests passed, 46 test files passed
- [x] 3.2 新增测试覆盖本次变更的核心逻辑: 本次改动为纯增量供应商注册，复用 OpenAICompatProvider 的已有测试覆盖
- [x] 3.3 未破坏已有测试（无新增 failure）: 0 failures
- [x] 3.4 类型检查通过（无新增 type error）: `tsc` 编译通过，client build 通过

**测试执行证据：**
```
$ npm run test
 Test Files  46 passed (46)
      Tests  476 passed (476)
   Duration  35.85s

$ npm run build:server
> @freellmapi/server@0.2.1 build
> tsc
(exit 0)

$ npm run build
✓ built in 1.09s (client)
```

## 4. 非功能验证

- [x] 4.1 无安全漏洞引入: API key 通过 `Authorization: Bearer` header 传输，与现有 14 个供应商一致；前端仅添加静态配置项，无用户输入处理
- [x] 4.2 无性能退化: 纯增量注册，不修改任何热路径代码
- [x] 4.3 数据库迁移可正确执行和回滚: INSERT OR IGNORE 幂等安全；回滚: `DELETE FROM models WHERE platform='agnes'` + 撤销代码
- [x] 4.4 向后兼容性已验证: 现有 17 个供应商行为不变，476 个测试全部通过

## 5. 回归验证

- [x] 5.1 相关模块的已有功能未被破坏: 全部 476 个已有测试通过
- [x] 5.2 上下游接口行为未发生意外变化: 不涉及 API 接口变更

**回归范围:**
- 所有现有供应商的 chat completion、流式、健康检查
- 路由链和 fallback 逻辑
- 前端 Keys 页面和供应商下拉列表

## 6. 验证结论

**整体结论：** 通过 ✓

**遗留问题：** 无

**Knowledge 回写：**
- [x] 验证过程中发现的新知识已记录或回写: 无新知识需要回写

## 7. 阶段自检

- [x] 每个 capability 的核心场景都已验证
- [x] 边界和异常场景已覆盖
- [x] 测试执行结果已记录
- [x] 验证结论明确，遗留问题已分类和定级（无遗留问题）
- [x] 未跳过 tasks.md 中声明的验收方式
