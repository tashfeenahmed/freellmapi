# 一、背景知识

## 业务背景

AGNES AI 是 Sapiens AI（新加坡）运营的免费 AI API 网关，2026 年 6 月起全球免费开放。旗舰模型 `agnes-2.0-flash` 具备 256K context、vision 和 tool calling 能力，RPM 20。API 完全兼容 OpenAI 协议。

## 技术背景

freellmapi 已有 14 个供应商通过 `OpenAICompatProvider` 注册，模式高度标准化。AGNES 的接入完全遵循同一模式，无需自定义 Provider 类。

## 现有知识沉淀

- `server/src/providers/index.ts` — 所有供应商注册入口
- `server/src/providers/openai-compat.ts` — OpenAI 兼容 Provider 实现
- `shared/types.ts` — Platform 类型定义
- `client/src/pages/KeysPage.tsx` — 前端供应商列表
- `server/src/db/migrations.ts` — 模型数据 migration 模式（参照 `migrateModelsV18OpenCodeZen`）

# 二、名词解释

| 业务语言 | 技术自然语言 | 技术代码语言 |
|---|---|---|
| AGNES AI 供应商 | OpenAI 兼容的 API 网关 | `OpenAICompatProvider({ platform: 'agnes', baseUrl: 'https://apihub.agnes-ai.com/v1' })` |
| agnes-2.0-flash | 旗舰文本模型，256K context | `models` 表行，`platform='agnes', model_id='agnes-2.0-flash'` |
| AGNES API Key | `sk-` 前缀的 Bearer token | `Authorization: Bearer <key>` header |
| AGNES 平台 | Key 管理后台 | `https://platform.agnes-ai.com/settings/apiKeys` |

# 三、业务流程设计（纵向）

## 系统相关现状

freellmapi 的供应商注册流程：

```
用户配置 key → 健康检查 validateKey → 模型数据写入 models 表
                                                    ↓
客户端请求 → routeRequest → resolveProvider → chatCompletion/streamChatCompletion
```

### 领域划分

- **类型层:** `shared/types.ts` Platform 联合类型 — 定义所有合法平台标识
- **Provider 层:** `server/src/providers/` — 供应商实现，注册到 `Map<Platform, BaseProvider>`
- **前端层:** `client/src/pages/KeysPage.tsx` — 用户配置 key 的 UI
- **数据层:** `server/src/db/migrations.ts` — 模型元数据初始化和迁移

### 数据结构设计

AGNES 不引入新数据结构。`models` 表新增一行，字段与现有模型一致：

```
models 表 (无 schema 变更)
├── platform: 'agnes'
├── model_id: 'agnes-2.0-flash'
├── display_name: 'Agnes 2.0 Flash'
├── intelligence_rank: 4
├── speed_rank: 2
├── size_label: 'Frontier'
├── rpm_limit: 20
├── rpd_limit: 200
├── context_window: 262144
├── supports_vision: 1
├── supports_tools: 1
├── monthly_token_budget: 'free (promo)'
└── enabled: 1 (默认)
```

## 本次新增改动

### 领域划分变更

无变更。AGNES 完全复用现有 OpenAI 兼容流程。

### 数据结构变更

`models` 表新增 1 行（INSERT OR IGNORE），无 schema 变更。

### 对外接口定义

无新接口。AGNES 通过现有 `/v1/chat/completions` 端点处理。

# 四、技术实现设计（横向）

## client 层设计

**文件:** `client/src/pages/KeysPage.tsx`

在 `PLATFORMS` 数组中新增一项：

```typescript
{ value: 'agnes', label: 'Agnes AI', url: 'https://platform.agnes-ai.com/settings/apiKeys' }
```

按字母序插入（在现有列表中的合适位置）。

## domain 层设计

**文件:** `shared/types.ts`

Platform 类型添加 `'agnes'`：

```typescript
| 'agnes'
```

按字母序插入。

## infrastructure 层设计

**文件 1:** `server/src/providers/index.ts`

注册 OpenAICompatProvider 实例：

```typescript
register(new OpenAICompatProvider({
  platform: 'agnes',
  name: 'Agnes AI',
  baseUrl: 'https://apihub.agnes-ai.com/v1',
}));
```

`validateKey` 默认行为：向 `{baseUrl}/models` 发 GET 请求。`chatCompletion` 和 `streamChatCompletion` 使用标准 OpenAI 端点 `/chat/completions`。

**文件 2:** `server/src/db/migrations.ts`

新增函数 `migrateModelsV27Agnes`，使用 `INSERT OR IGNORE` + fallback_config backfill 模式，与 `migrateModelsV18OpenCodeZen` 一致。在 `migrateDbSchema` 中调用。

# 五、风险与权衡

| 风险 | 影响 | 缓解 |
|------|------|------|
| AGNES `/v1/models` 端点行为未知 | validateKey 可能误判 | 默认行为大概率正确（OpenAI 标准），如果异常可后续通过 `validateUrl` 参数调整 |
| AGNES 免费策略变化 | 模型不可用 | `monthly_token_budget: 'free (promo)'` 标记明确，与其他 promo 模型处理一致 |
| intelligence_rank/speed_rank 估值不准 | 路由优先级不当 | 可通过后续 catalog-sync 或 migration 调整 |

# 六、技术决策记录

| 决策 | 选择 | 备选方案 | 取舍依据 |
|---|---|---|---|
| Provider 实现方式 | OpenAICompatProvider | 自定义 Provider 类 | AGNES 完全兼容 OpenAI 协议，无需自定义 |
| 模型数据来源 | Migration (INSERT OR IGNORE) | 仅依赖 catalog-sync | 用户选 B，需要立即可用；catalog-sync 可能有延迟 |
| intelligence_rank | 4 | 5 或 3 | 对标 DeepSeek V4 Flash Free 等前沿 flash 模型 |
| speed_rank | 2 | 3 或 4 | Flash 模型以速度见长 |

# 七、迁移 / 灰度 / 回滚方案

- **上线:** migration 随版本发布自动执行，`INSERT OR IGNORE` 幂等安全
- **灰度:** 无需灰度，改动为纯增量，不影响现有供应商
- **回滚:** 如需移除，手动删除 `models` 表中 `platform='agnes'` 的行，并撤销代码改动。migration 中的 `INSERT OR IGNORE` 不会在回滚后重新插入

# 八、测试与验证方案

- **类型检查:** `npm run typecheck` 通过（新增 `'agnes'` 不破坏现有类型）
- **构建:** client 和 server 构建通过
- **手动验证:** 注册 AGNES 账号 → 获取 API key → 在 Keys 页面添加 → 验证健康检查显示 healthy → 发起 chat completion 请求 → 确认正常返回
- **回归:** 现有测试全部通过，不涉及现有逻辑变更

# 九、Knowledge 回写计划

无需新增或更新 Knowledge 文档。

# 十、开放问题

- AGNES `/v1/models` 端点对带有效 key 的请求是否返回 200？需要实际测试确认（不影响实现，但影响健康检查行为）
- 如果后续 AGNES 推出更多文本模型，可通过 catalog-sync 下发

# 十一、阶段自检

- [x] 设计没有引入 proposal/specs 未声明的新需求
- [x] 每个关键设计决策都有依据和备选方案说明
- [x] 涉及接口、数据结构、依赖、迁移和回滚的内容已写清
- [x] 测试与验证方案能覆盖 specs 中的关键 Scenario
- [x] 设计足以拆分为原子任务
- [x] 未写入具体实现代码
