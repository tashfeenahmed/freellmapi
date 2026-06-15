## 1. 需求摘要

**背景:** AGNES AI 是 Sapiens AI（新加坡）运营的免费 AI API 网关，2026 年 6 月起对全球开放免费调用。其 API 完全兼容 OpenAI 协议，旗舰模型 `agnes-2.0-flash` 具备 256K context window、vision 输入和 tool calling 能力，RPM 20，无需信用卡即可注册使用。

**问题:** freellmapi 目前支持 17 个供应商，但不包含 AGNES AI。用户无法通过 freellmapi 统一管理和路由 AGNES 的免费模型。

**为什么现在做:** AGNES 刚开放免费 API，是当前少有的同时支持 vision + tool calling 的免费模型供应商，对 freellmapi 用户价值显著。且 AGNES 使用标准 OpenAI 协议，接入成本极低。

## 2. 当前工程范围与边界

**纳入范围:**
- `Platform` 类型扩展，新增 `'agnes'` 平台标识
- 通过 `OpenAICompatProvider` 注册 AGNES 供应商，复用现有 chat completion、流式、key 验证基础设施
- 前端 Keys 页面添加 AGNES AI 选项，指向其 API key 管理页面
- 数据库 migration 添加 `agnes-2.0-flash` 模型数据，使其出现在路由链中

**不纳入范围:**
- 图片生成模型 (`agnes-image-2.1-flash`) — freellmapi 仅处理 chat completion
- 视频生成模型 (`agnes-video-v2.0`) — 同上
- AGNES 平台的账户注册、充值、计费等
- 代理 bypass 配置变更 — AGNES 不需要特殊代理

## 3. 业务语义拆解

**业务对象:**
- **供应商 (Provider):** AGNES AI，OpenAI 兼容协议，需要 API key 认证
- **模型 (Model):** `agnes-2.0-flash`，文本 chat completion，256K context，支持 vision 和 tool calling
- **API Key:** 用户从 `platform.agnes-ai.com/settings/apiKeys` 获取，格式 `sk-*`

**业务规则:**
- API key 通过 `Authorization: Bearer <key>` header 传递
- 速率限制: RPM 20（免费层），RPD 保守估计 200
- 当前免费推广期，无月度 token 预算上限
- Key 验证: 默认通过 `GET {baseUrl}/models` 验证（OpenAICompatProvider 默认行为）

**场景边界:**
- 仅处理 `/v1/chat/completions` 端点（流式和非流式）
- 不处理 `/v1/images/generations` 和 `/v1/videos` 端点

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块或入口 | 备注 |
|---|---|---|---|
| AGNES AI 供应商 | `Platform = 'agnes'` | `shared/types.ts` Platform 类型 | 类型级新增 |
| AGNES API 端点 | `OpenAICompatProvider({ baseUrl: 'https://apihub.agnes-ai.com/v1' })` | `server/src/providers/index.ts` | 复用现有 Provider |
| API key 管理页面 | `{ value: 'agnes', label: 'Agnes AI', url: '...' }` | `client/src/pages/KeysPage.tsx` PLATFORMS | 前端选项 |
| agnes-2.0-flash 模型 | `models` 表行: platform='agnes', model_id='agnes-2.0-flash' | `server/src/db/migrations.ts` migration | 路由链可见 |
| 健康检查 | `OpenAICompatProvider.validateKey` → `GET /v1/models` | `server/src/providers/openai-compat.ts` | 自动适配 |
| 速率限制 | `getProviderDailyRequestCap('agnes')` | `server/src/services/ratelimit.ts` | 自动适配 |

## 5. 变更清单

1. **新增 Platform 值:** `shared/types.ts` Platform 联合类型添加 `'agnes'`
2. **新增 Provider 注册:** `server/src/providers/index.ts` 注册 `OpenAICompatProvider` 实例
3. **新增前端选项:** `client/src/pages/KeysPage.tsx` PLATFORMS 数组添加 AGNES AI
4. **新增模型 Migration:** `server/src/db/migrations.ts` 添加 `migrateModelsV27Agnes` 函数并在 `migrateDbSchema` 中调用

## 6. 追踪关系

| 业务目标 | 变更点 | Capability | 影响对象 | 验收口径 |
|---|---|---|---|---|
| 用户可使用 AGNES API | Platform 类型 + Provider 注册 | `provider-agnes` | `shared/types.ts`, `server/src/providers/index.ts` | 系统接受 `platform='agnes'` 的请求 |
| 用户可在 UI 添加 AGNES key | 前端 PLATFORMS 列表 | `provider-agnes` | `client/src/pages/KeysPage.tsx` | Keys 页面下拉框出现 "Agnes AI" 选项 |
| agnes-2.0-flash 可路由 | Migration 添加模型 | `model-agnes-2.0-flash` | `server/src/db/migrations.ts`, `models` 表 | 模型出现在路由链中，可被选中 |
| API key 健康检查正常 | OpenAICompatProvider.validateKey | `provider-agnes` | `server/src/services/health.ts` | 有效 key 显示 healthy，无效 key 显示 bad_key |

## 7. Capabilities

### 新增 Capabilities
- `provider-agnes`: AGNES AI 作为 OpenAI 兼容供应商的完整支持，包括 API 调用、key 验证、流式传输、速率限制。通过 `OpenAICompatProvider` 实现，无需自定义 Provider 类。
- `model-agnes-2.0-flash`: AGNES 旗舰文本模型，256K context window，支持 vision 和 tool calling，RPM 20，当前免费。通过数据库 migration 写入模型表。

### 修改 Capabilities
- 无

### 移除 Capabilities
- 无

## 8. 复杂度判定

**复杂度结论:** 简单需求

**判定依据:**
- [ ] 涉及两个及以上模块、服务或分层
- [ ] 涉及接口协议、数据结构、存储模型变化
- [ ] 涉及迁移、灰度、回滚、兼容处理
- [ ] 涉及安全、性能、并发、缓存、幂等等专项权衡
- [ ] 仅依靠 proposal + specs 无法稳定拆出 tasks

> 注: 虽然改动跨 4 个文件（类型、provider、前端、migration），但每个改动都是纯增量添加、模式高度标准化，与已有的 14 个 OpenAICompatProvider 注册完全一致。不涉及新协议、新接口、数据结构变更或兼容性处理。

**Design 是否必需:** 可选

**说明:** 改动模式与现有 14 个 OpenAICompatProvider 注册完全一致，无需设计新架构。唯一需要决策的模型参数（intelligence_rank、speed_rank）已在 explore 阶段确定。

## 9. Knowledge 使用与影响

**Knowledge 证据:**
- Source: `server/src/providers/index.ts` (codegraph_explore)
- Evidence: 14 个 OpenAICompatProvider 注册实例，模式一致
- 可信度: high
- 未证实推断: 无

- Source: AGNES AI 官方文档 (web_search_exa, aifreeplan.com, openclawlaunch.com)
- Evidence: Base URL `https://apihub.agnes-ai.com/v1`, API key 格式 `sk-*`, 模型名 `agnes-2.0-flash`, 256K context, vision + tool calling
- 可信度: high
- 未证实推断: `/v1/models` 端点对带认证 key 的请求行为（推断返回标准 OpenAI 模型列表）

**本次受影响的 Knowledge:** 无现有 knowledge 文档受影响

**是否需要新增 Knowledge 文档:** 否

## 10. 影响评估

**代码影响:**
- `shared/types.ts`: +1 行（Platform 联合类型）
- `server/src/providers/index.ts`: +7 行（import + register 调用）
- `client/src/pages/KeysPage.tsx`: +1 行（PLATFORMS 数组项）
- `server/src/db/migrations.ts`: +25 行（新函数 + 调用）

**接口影响:** 无。API 接口不变，AGNES 通过现有 OpenAI 兼容路由处理。

**依赖影响:** 无。不需要新增 npm 包。

**数据影响:** `models` 表新增 1 行，`fallback_config` 表可能新增 1 行（backfill）。

## 11. 非目标与后续议题

- **图片和视频模型:** `agnes-image-2.1-flash` 和 `agnes-video-v2.0` 不在本次范围，freellmapi 当前不处理这些模态
- **catalog-sync 集成:** 后续如果 AGNES 模型列表扩展，可通过远端 catalog 下发，无需 migration
- **模型参数调优:** intelligence_rank 和 speed_rank 可能需要根据实际使用反馈调整

## 12. 阶段自检

- [x] 已说明为什么要做以及本工程负责哪一部分
- [x] 已明确纳入范围 / 不纳入范围
- [x] 每个 capability 都有清晰边界，且不是简单模块名
- [x] 每个 capability 都能追溯到业务目标和变更点
- [x] 已判断 design 是否必需（可选）
- [x] 未写入具体实现代码或过细任务
- [x] 已列出仍需确认的问题，且不阻塞 specs 的事项已标明
