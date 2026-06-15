## 1. 输入需求与原始上下文

**原始需求:** 在 freellmapi 项目中添加 AGNES AI 作为新的 API 供应商。

**来源:** 用户需求，AGNES AI 是一个 OpenAI 兼容的免费 AI API 网关。

**业务背景:**
- AGNES AI 由 Sapiens AI（新加坡）运营，2026 年 6 月起免费提供
- API Base URL: `https://apihub.agnes-ai.com/v1`
- 认证方式: `Authorization: Bearer sk-...`（需注册获取 API key）
- 旗舰模型 `agnes-2.0-flash`: 256K context window, 支持 vision 输入, 支持 tool calling
- 速率限制: RPM 20（免费层）
- 也提供图片生成 (`agnes-image-2.1-flash`) 和视频生成 (`agnes-video-v2.0`) 模型，但本次仅关注文本 chat completion

**目标用户:** 使用 freellmapi 的所有用户，通过免费网关访问 AGNES AI 的模型。

## 2. 业务目标与成功标准

**为什么做:** 为 freellmapi 用户增加一个免费、高质量的 API 供应商选项。AGNES 的旗舰模型在能力上对标前沿 flash 模型（DeepSeek V4 Flash Free 级别），且完全免费，对用户价值显著。

**成功标准:**
- 用户可以在 Keys 页面添加 AGNES AI 的 API key
- 系统能够通过 AGNES API 完成 chat completion（流式和非流式）
- `agnes-2.0-flash` 模型出现在路由链中
- 健康检查正确验证 AGNES API key

## 3. 当前工程职责边界

**纳入范围:**
- 在 `Platform` 类型中注册 `'agnes'` 平台
- 使用 `OpenAICompatProvider` 注册 AGNES 供应商
- 在前端 Keys 页面添加 AGNES AI 选项
- 通过数据库 migration 添加 `agnes-2.0-flash` 模型数据
- 路由、健康检查、速率限制等基础设施自动适配（因为复用 OpenAICompatProvider）

**不纳入范围:**
- 图片生成 (`agnes-image-2.1-flash`) — freellmapi 当前仅处理 chat completion
- 视频生成 (`agnes-video-v2.0`) — 同上
- AGNES 平台本身的账户管理、充值等

## 4. 现状调研与证据

### 4.1 现有模块与入口

**Platform 类型定义** — `shared/types.ts:10`:
```typescript
export type Platform =
  | 'google' | 'groq' | 'cerebras' | 'nvidia' | 'mistral'
  | 'openrouter' | 'github' | 'cohere' | 'cloudflare' | 'zhipu'
  | 'ollama' | 'kilo' | 'pollinations' | 'llm7' | 'huggingface'
  | 'opencode' | 'ovh' | 'custom';
```
证据: codegraph_node 读取 shared/types.ts:10-34

**Provider 注册** — `server/src/providers/index.ts:8-12`:
```typescript
const providers = new Map<Platform, BaseProvider>();
function register(provider: BaseProvider) {
  providers.set(provider.platform, provider);
}
```
已有 17 个供应商注册，其中 14 个使用 `OpenAICompatProvider`（Groq, Cerebras, NVIDIA, Mistral, OpenRouter, GitHub, Zhipu, Ollama, Kilo, Pollinations, HuggingFace, OpenCode, OVH, LLM7）。

**OpenAICompatProvider** — `server/src/providers/openai-compat.ts:17-50`:
构造函数接受 `{ platform, name, baseUrl, extraHeaders?, validateUrl?, timeoutMs?, keyless?, forceSingleToolCall? }`，覆盖了 OpenAI 兼容供应商的所有通用需求。

**前端平台列表** — `client/src/pages/KeysPage.tsx:39-57`:
`PLATFORMS` 常量数组，每项 `{ value: Platform, label: string, url: string, keyless?: boolean }`。`url` 指向各供应商的 key 管理页面。

**模型 Migration** — `server/src/db/migrations.ts`:
- `migrateDbSchema:6-50` 按序调用所有 migration，V25 是最后一个 model-data migration
- 注释说明: "V25 is the LAST model-data migration. Since the Premium live catalog shipped (June 2026), model/limit DATA is maintained in the published catalog"
- 但 `applyCatalog` (`catalog-sync.ts:145`) 有 `skippedUnknownPlatform` 计数器，会跳过未注册平台的模型
- 参照 `migrateModelsV18OpenCodeZen:1541-1567` 的模式: INSERT OR IGNORE + fallback_config backfill

### 4.2 上下游与依赖

- **上游:** AGNES AI API (`https://apihub.agnes-ai.com/v1`)，OpenAI 兼容协议
- **下游:** freellmapi 的路由器、健康检查、速率限制等基础设施
- **依赖:** 无需新增 npm 包，完全复用 `OpenAICompatProvider`

### 4.3 现有行为与约束

- `OpenAICompatProvider` 的 `validateKey` 默认向 `{baseUrl}/models` 发 GET 请求验证 key
- 速率限制默认通过 `getProviderDailyRequestCap` 基于平台名匹配
- 代理 bypass 机制通过 `PROXY_BYPASS_PLATFORMS` 环境变量控制

## 5. 改动点拆解

### 5.1 必做改动点

| # | 改动点 | 文件 | 说明 |
|---|--------|------|------|
| 1 | Platform 类型扩展 | `shared/types.ts` | 添加 `'agnes'` 到 Platform 联合类型 |
| 2 | Provider 注册 | `server/src/providers/index.ts` | `register(new OpenAICompatProvider({...}))` |
| 3 | 前端平台列表 | `client/src/pages/KeysPage.tsx` | PLATFORMS 数组添加 AGNES AI |
| 4 | 模型数据 migration | `server/src/db/migrations.ts` | 新函数 `migrateModelsV27Agnes`，添加 `agnes-2.0-flash` |

### 5.2 可选 / 后续改动点

- 如果 AGNES 的 `/v1/models` 端点对未认证请求返回非 200，可能需要自定义 `validateUrl`
- 如果 AGNES 支持更多文本模型（未来可能），可通过 catalog-sync 下发
- 图片和视频生成模型不在当前范围内

## 6. 追踪关系草案

| 业务目标 | 改动点 | 候选 Capability | 证据 | 状态 |
|---|---|---|---|---|
| 用户可使用 AGNES API | Platform 类型 + Provider 注册 | `provider-agnes` | index.ts OpenAICompatProvider 模式 | 已确认 |
| 用户可在 UI 添加 AGNES key | 前端 PLATFORMS 列表 | `provider-agnes` | KeysPage.tsx PLATFORMS 常量 | 已确认 |
| agnes-2.0-flash 可路由 | Migration 添加模型 | `model-agnes-flash` | migrateModelsV18OpenCodeZen 模式 | 已确认 |
| API key 健康检查 | OpenAICompatProvider.validateKey | `provider-agnes` | openai-compat.ts validateKey 实现 | 推断（需验证 AGNES /v1/models 行为） |

## 7. 风险、未知项与待确认问题

- **待确认:** AGNES 的 `/v1/models` 端点是否需要认证。如果未认证返回 401/403，`OpenAICompatProvider` 默认的 validateKey 逻辑可能需要设置自定义 `validateUrl` 或覆盖 validateKey
- **待确认:** `intelligence_rank` 和 `speed_rank` 的具体数值。当前估计 `intelligence_rank: 4`（对标 DeepSeek V4 Flash Free），`speed_rank: 2`（Flash 模型）。需要实际测试确认
- **低风险:** AGNES 免费策略可能变化。当前标记为 `monthly_token_budget: 'free (promo)'`，与 OpenCode Zen 等 promo 模型一致

## 8. Knowledge 使用情况

**Knowledge 证据记录:**
- Source: `server/src/providers/index.ts` (codegraph_explore)
- Evidence: OpenAICompatProvider 注册模式，Groq/Cerebras/Mistral 等均为 OpenAI 兼容
- 结论属性: 代码推断

- Source: `shared/types.ts` (codegraph_node)
- Evidence: Platform 联合类型当前包含 17 个值
- 结论属性: 代码推断

- Source: `server/src/db/migrations.ts` (codegraph_node)
- Evidence: migrateModelsV18OpenCodeZen 的 INSERT OR IGNORE + fallback backfill 模式
- 结论属性: 代码推断

- Source: AGNES AI 官方文档 (web_search_exa)
- Evidence: Base URL `https://apihub.agnes-ai.com/v1`, API key 格式 `sk-*`, 模型 `agnes-2.0-flash`, 256K context, vision + tool calling
- 结论属性: 知识证据支持

**当前是否足够支撑后续阶段:** 是

## 9. Knowledge 缺口与回写预估

**本次预计需要新增或更新的 Knowledge:**
- 无需新增 Knowledge 文档。AGNES 供应商信息已在 explore 阶段充分获取

## 10. Capability 候选草案

### 新增 Capabilities
- `provider-agnes`: AGNES AI 作为新的 API 供应商，OpenAI 兼容协议，通过 OpenAICompatProvider 注册
- `model-agnes-2.0-flash`: AGNES 旗舰文本模型，256K context, vision, tool calling, RPM 20

### 修改 Capabilities
- 无现有 capability 需要修改

## 11. 阶段自检

- [x] 已明确本工程纳入范围和不纳入范围
- [x] 每个关键结论都有证据或标记为推断
- [x] 已列出进入 proposal 前必须确认的问题（/v1/models 行为、rank 数值）
- [x] 已给出业务目标到 capability 候选的追踪关系
- [x] 未写入具体实现方案或代码级任务
