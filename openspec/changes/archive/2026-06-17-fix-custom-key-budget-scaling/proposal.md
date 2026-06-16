## 1. 需求摘要

**问题：**

1. **Custom 平台 key 唯一性限制** — `POST /api/keys/custom` 对相同 `base_url` 做 upsert，用户无法为同一自定义端点配置多个 API key。这与 built-in 平台（google、openrouter 等）的行为不一致——后者无此限制，支持多 key 叠加。

2. **月度令牌预算不感知 key 数量** — 每个模型的 `monthly_token_budget`（如 `~12M`）代表单个 key 的免费配额，但 `headroomFactor` 计算时使用模型级别的固定值，不随 key 数量缩放。例如 3 个 Google key × 12M/mo = 36M，系统却只按 12M 保护，导致明明有富余配额却过早触发限流。

**机会：**
- 修复 custom 平台的行为一致性，解锁多账号负载均衡场景
- 让 headroom 保护逻辑正确反映多 key 叠加后的真实可用配额

**为什么现在做：** 用户直接反馈的两个 bug，是生产环境的实际痛点。

## 2. 当前工程范围与边界

**纳入范围：**
- `POST /api/keys/custom` 去除 base_url 去重，改为始终创建新 key 行
- Custom model 的 model_id 命名策略改为 `{keyId}-{name}`，避免 `UNIQUE(platform, model_id)` 冲突
- `scoreChainEntry` 中的 budget 计算乘以该平台/模型下启用的 key 数量
- 验证 custom key 删除级联逻辑不受影响

**不纳入范围：**
- 前端 KeysPage UI 改动（现有 key 列表已支持显示多个 custom key）
- 非 custom 平台的 key 创建逻辑（无需改动）
- `monthly_token_budget` 字段从 models 表迁移到 api_keys 表
- Per-key 自定义预算覆盖
- 前端显示"key 数 × 单 key 预算"的总预算

## 3. 业务语义拆解

**业务对象：**
- **Custom API Key** — 用户持有的 OpenAI-compatible 端点的认证凭证，属于某个 base_url 端点
- **Custom Model** — 注册于 custom 端点下的模型，绑定到一个特定的 key
- **月度令牌预算** — 每个 key 每月可免费使用的令牌上限，所有 key 的配额可叠加

**业务规则：**
- 同一个 base_url 下可以有多个 key（不同账号、不同权限级别）
- 每个 custom model 归属于一个特定的 key
- 系统可用的月度总预算 = 单 key 预算 × 启用 key 数
- 删除一个 custom key 时，仅删除该 key 注册的 model，不影响同 base_url 下其他 key 的 model

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块或入口 | 备注 |
|---|---|---|---|
| 添加 custom key | `POST /api/keys/custom` 不再 upsert，始终 INSERT | `server/src/routes/keys.ts:147-248` | 移除 base_url 去重分支 |
| Custom model 注册 | model_id 前缀 `{keyId}-`，ON CONFLICT 不再误覆盖 | `server/src/routes/keys.ts:209-216` | UNIQUE(platform, model_id) 保持不变 |
| Custom key 级别的 model 绑定 | `models.key_id` 精确绑定 key，路由时跳过非匹配 key | `server/src/services/router.ts:631` | 已有逻辑，无需改动 |
| 单 model 月度总预算 | `parseBudget(budget) × keyCount` | `server/src/services/router.ts:347-348` | 需要在 scoreChainEntry 注入 key 计数 |
| Key 数量统计 | `SELECT COUNT(*) FROM api_keys WHERE platform = ? AND enabled = 1` | `server/src/services/router.ts` | 在 chain 构建阶段查询一次 |

## 5. 变更清单

1. **去除 custom key 的 base_url 去重** — `keys.ts` 中将 upsert 改为 insert
2. **Custom model 的 model_id 加 keyId 前缀** — 避免同名 model 在不同 key 下冲突
3. **月度预算 × key 数量** — router 中传入缩放后的 budget
4. **确认删除级联不受影响** — 验证 `DELETE FROM models WHERE key_id = ?` 逻辑

## 6. 追踪关系

| 业务目标 | 变更点 | Capability | 影响对象 | 验收口径 |
|---|---|---|---|---|
| 同 baseURL 多 key | 去除 base_url 去重 | custom-key-management | `POST /api/keys/custom` | 同 base_url 下可创建多个 key，互不覆盖 |
| model 绑定不冲突 | model_id 加 keyId 前缀 | custom-key-management | `models` 表 INSERT | 不同 key 注册同名 model 各自独立 |
| 预算按 key 缩放 | budget × keyCount | token-budget | `headroomFactor` 入参 | N 个 key 时预算 = N × 模型基础预算 |
| 删除仅影响自身 key | 验证级联逻辑 | custom-key-management | `DELETE /api/keys/:id` | 删除一个 custom key 不影响同 base_url 其他 key 的 model |

## 7. Capabilities

### 新增 Capabilities
- 无新增，属于现有功能的修正

### 修改 Capabilities
- **custom-key-management**: custom 平台去除 base_url 唯一性限制；model_id 加 keyId 前缀隔离
- **token-budget**: 月度令牌预算计算改为 `基础预算 × 该平台下启用 key 数量`

### 移除 Capabilities
- 无

## 8. 复杂度判定

**复杂度结论：** 简单需求

**判定依据：**
- [x] 涉及两个及以上模块、服务或分层 — keys route + router service
- [ ] 涉及接口协议、数据结构、存储模型变化 — 无 schema 迁移
- [ ] 涉及迁移、灰度、回滚、兼容处理 — 仅新增 key 受影响，存量不受影响
- [ ] 涉及安全、性能、并发、缓存、幂等等专项权衡 — key 计数是一次性查询
- [ ] 仅依靠 proposal + specs 无法稳定拆出 tasks

**Design 是否必需：** 可选

**说明：** 改动范围明确、改动量小（~30 行代码），两个改动点各自独立。没有新表、新接口、新协议。proposal + specs 足够指导实现。

## 9. Knowledge 使用与影响

**本次使用的 Knowledge：** 代码库

**Knowledge 证据：**
- Source: `server/src/routes/keys.ts:183-201` — Evidence: base_url upsert 逻辑 — 可信度: high
- Source: `server/src/routes/keys.ts:209-216` — Evidence: ON CONFLICT(platform, model_id) — 可信度: high
- Source: `server/src/services/router.ts:347-348` — Evidence: budget 从 models 表读取 — 可信度: high
- Source: `server/src/services/router.ts:631` — Evidence: key_id 绑定跳过逻辑 — 可信度: high
- Source: `server/src/services/scoring.ts:124-130` — Evidence: headroomFactor 公式 — 可信度: high

**本次受影响的 Knowledge：** 无外部文档受影响

**是否需要新增 Knowledge 文档：** 否

## 10. 影响评估

| 受影响 | 详情 |
|---|---|
| `server/src/routes/keys.ts` | POST /custom 去重逻辑移除（~10行）；model_id 改为 `{keyId}-{name}`（1行） |
| `server/src/services/router.ts` | `scoreChainEntry` 引入 key 计数；`orderChain` 处查询一次 key 计数 |
| `server/src/services/scoring.ts` | 无直接改动（`headroomFactor` 签名不变，入参值变） |
| 前端 | 无改动（已有 key 列表支持显示多个 custom key） |
| 数据库 | 无 schema 变更 |
| 已有数据 | 无影响（已有 key 和 model 不变，新 key 才走新逻辑） |

## 11. 非目标与后续议题

- 前端显示"总预算 = key 数 × 单 key 预算"
- Per-key 自定义 monthly_token_budget
- `monthly_token_budget` 从 models 表迁移到 api_keys 表

## 12. 阶段自检

- [x] 已说明为什么要做以及本工程负责哪一部分
- [x] 已明确纳入范围 / 不纳入范围
- [x] 每个 capability 都有清晰边界，且不是简单模块名
- [x] 每个 capability 都能追溯到业务目标和变更点
- [x] 已判断 design 是否必需（可选，proposal + specs 足够）
- [x] 未写入具体实现代码或过细任务
- [x] 已列出仍需确认的问题，且不阻塞 specs 的事项已标明
