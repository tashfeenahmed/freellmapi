[English](../../../../architecture/01-routing-and-bandit-scoring.md) · **简体中文**

# 路由与老虎机评分 —— 深度剖析

> **源码：** `server/src/services/router.ts`、`server/src/services/scoring.ts`

## 1. 概览

路由器为每个请求挑选一个 `(platform, model, key)` 三元组。它**不是**轮询负载均衡器——它是一个持续从实时流量学习的上下文老虎机，从五个归一化轴合成一个分数：

```
base = w_rel·reliability + w_speed·speed + w_intel·intelligence   （凸组合，权重和为 1）
effective = base × headroomFactor × rateLimitFactor               （护栏乘数 ∈ [floor, 1]）
```

**权重**来自可选策略（`balanced` / `smartest` / `fastest` / `reliable` / `custom` / `priority`）。默认是 `balanced`（0.5 / 0.25 / 0.25）。操作者可从仪表盘或经 `PUT /api/fallback/routing` 切换策略。

---

## 2. 链构建

启用的回退链按优先级从以下来源取：

1. **活跃配置档**（`profile_models` 表）——命名链如 "coding"、"long-context"
2. **全局 fallback_config**——旧版单链
3. **全局排序别名**——`auto:smart`、`auto:fast`、`auto:cheap`、`auto:reliable`、`auto:balanced`
4. **按名配置档**——`auto:my-profile`

每个链行（`ChainRow`）携带模型的静态元数据（`intelligence_rank`、`size_label`、`monthly_token_budget`、限流、能力）加上**端点作用域**（目录模型为 `''`，中继模型为 `'custom:<base_url_hash>'`），这样服务同一 `model_id` 的两个中继能独立评分、独立限流。

### 匹配层级

`match_tier`（默认 0）是**外层排序键**，支配分数。仅当统一组把一个 slug（如 `glm-4.7`）解析到提供方专属模型（如 `z-ai/glm-4.5`）时才设置——被匹配的成员得 `match_tier = 1`，这样无论它的实时数字多好，永远不会超越直接请求 `model_id` 的行。

---

## 3. 可靠性 —— 带 Beta 后验的 Thompson 采样

### 衰减加权样本

可靠性不是原始成功率。分析窗口 7 天，**2 天半衰期**指数衰减：

```
weight(age_days) = 0.5^(age_days / 2)
```

每个请求桶（按 `platform, model_id, key_id, age_days` 分组）贡献衰减加权的伪计数到 `successes` 和 `failures`。超时对可靠性算**失败**但对速度**有贡献**（挂钟延迟、零词元）。

### 后验与采样

```
α = successes + community_successes + 1   （Beta(1,1) 均匀先验）
β = failures  + community_failures  + 1
```

- **路由（实时）**：`reliability = sampleBeta(α, β)` —— Thompson 采样。探索自动且与不确定性成正比。
- **仪表盘（显示）**：`reliability = α / (α + β)` —— 期望值，排序稳定。

### 社区先验（可选）

`routing_community_prior_enabled = 1` 时，来自其他自托管实例的去毒聚合计数折入后验作起始余额。每个先验封顶 **50 个有效样本**，所以本地证据（衰减加权、繁忙实例上百个样本）几百请求内就占主导。

### 探索底线（10%）

`routing_explore_enabled = 1` 时（默认关），未测量模型（衰减加权 `successes + failures < 5`）获得**保底 10% 概率**被优先尝试，防止被先验重的对手饿死。老虎机的 Thompson 采样本身就会探索；这是个硬底线。

---

## 4. 速度轴 —— 吞吐 + TTFB 混合

```
throughputScore(tok/s) = 1 - exp(-tok/s / 60)          # 饱和，60 tok/s ≈ 0.63
ttfbScore(ms)          = 线性斜坡 300ms→1.0 … 5000ms→0.0
speedScore             = 0.6·throughput + 0.4·ttfb       # 两者皆有时
```

- 无成功样本 → 返回 `SPEED_PRIOR = 0.6`（乐观，让未测模型在速度上也被探索）。
- 仅有吞吐（无 TTFB）→ 单用吞吐。
- 仅有 TTFB（无吞吐）→ 单用 TTFB。

**超时喂速度**（#619）：超时把其封顶挂钟延迟（最长 120s）算进吞吐分母且**零输出词元**，同一延迟也作 TTFB 样本（落在 `TTFB_WORST_MS` 之后，得零延迟信用）。一个老是挂起的模型不能再靠着优秀的速度数混日子。

### 观测速度秩回写

每 10 分钟，拥有 ≥20 个衰减加权速度承载样本（成功+超时）且无用户设置 `speed_rank` 覆盖的模型，把观测速度投影回目录 1..10 的 `speed_rank` 刻度（1 = 最快）。这让仪表盘的按速度排序预设对中继模型也诚实。

---

## 5. 智能轴 —— 层优先，√-压缩秩

```
tierValue: Frontier=4, Large=3, Medium=2, Small=1, unknown=0
intelligenceComposite = tierValue * 1000 - sqrt(rank) * 31
```

- **层严格占优**：某层最差秩（√1000·31 ≈ 980）仍打赢下一层最好秩（1000）。
- **秩编辑可见**：√ 压缩让 1→3→10 的变化在轴上明显移动，不像旧线性秩被层乘数淹没。
- 在启用链上做 min-max 归一化到 [0,1]。

自定义模型按目录中位数层播种（"unknown" = 无意见，不是"最差"）。

---

## 6. 护栏 —— 乘法，从不重排好模型

### 余量因子（额度保护）

```
remaining = 1 - usedTokens / budgetTokens
if remaining >= 0.2:  factor = 1.0
else:                 factor = 0.1 + 0.9 * (remaining / 0.2)   # 线性斜坡到底线 0.1
```

- `budgetTokens` = `monthly_token_budget` × `usableKeyCount(platform)` —— 汇聚 N 个密钥的免费额度。
- 未知预算（0 或 NULL）→ factor = 1（无意见）。

### 限流因子（实时惩罚）

```
penalty ∈ [0, 10]   （来自 429 升级阶梯，每 2 分钟衰减 1）
factor = 1 - (penalty / 10) * 0.6   # 最大惩罚时保留 40% 分数
```

- 强降但不排除——惩罚衰减时模型恢复。

---

## 7. 按模型权重覆盖（环境变量：`MODEL_ROUTING_OVERRIDES`）

```
MODEL_ROUTING_OVERRIDES='{"gpt-4o": {"weight": 0.5}, "llama-3.3-70b": {"weight": 1.5}}'
```

缩放**最终有效分数**（护栏之后），让又慢又烂的模型降级而不禁用。手动 `priority` 链仍可选它。

---

## 8. 模型内密钥选择（密钥级老虎机）

模型有多密钥时，密钥按**密钥级 Thompson 分数**排序：

```
keyReliability = sampleBeta(α_key + community_α, β_key + community_β)
keySpeed       = speedScore(keyStats.tokPerSec, keyStats.avgTtfbMs)
keyScore       = 0.75·keyReliability + 0.25·keySpeed
```

<2 个密钥有记录数据时返回 `null`（回退轮询）。捕捉汇总模型桶看不见的过期/耗尽/区域封锁密钥。

---

## 9. 回退循环与耗尽诊断

共享循环（`lib/fallback-loop.ts`）驱动所有面（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、旧版 `/completions`）：

- **最多 20 次重试**（可配）。
- **挂钟重试预算**（默认 45s，设置 `fallback_time_budget_ms`）。预算用完后不再**发起**新尝试，改返回耗尽错误（首次尝试总跑；进行中的尝试绝不中途截断）。
- **对冲**（1d2226a）：预算中途过期时，`abortInFlight()` 取消上游取获，而不是等停滞。
- **断路器**：`max_consecutive_upstream_fails`（默认 0 = 关）在池看起来不健康时以 503 停下循环。
- **逐尝试轨迹**：`X-Fallback-Trail` 头 + `X-Fallback-Detail`（可选）含耗时和脱敏错误摘要。
- **同步耗尽**（零上游调用）：`RouteError.diagnostics` 逐行记录每个被考虑模型及其不能服务的理由（无密钥、冷却、提供方上限、rpm/rpd、tpm/tpd、上下文太小……）。`summarizeExhaustion()` 把这卷成客户端安全的分桶消息（如 "All models exhausted: 5 routes checked (3 rate-limited or on cooldown, 2 no usable key configured). Add more API keys or wait for rate limits to reset. Soonest reset ~2m."）。

### 失败分类与记账

| 错误 | 跳过范围 | 冷却 | 模型惩罚 | 限流学习 |
|-------|----------|------|----------|----------|
| 401 无效密钥 | 仅密钥 | 5 min（健康周期） | 否 | 否 |
| 402 需付款 | 仅密钥 | 24h | 否 | 否 |
| 403 模型被禁 | **模型** | 24h | 否 | 否 |
| 429 每日耗尽 | 模型+密钥 | 到 UTC 午夜 / Retry-After | 重 (3) | 是 |
| 429 瞬时 (rpm/tpm) | 仅密钥 | 90s / 升级阶梯 | 轻 (1) | 是 |
| 5xx / 超时 / 传输 | **平台** (#788) | 90s / 阶梯 | 轻 (1) | 否 |
| 空补全（推理） | 仅密钥 | **豁免**（连击 ≤3） | 否 | 否 |
| 上下文过大 | 模型 | — | 否 | 否 |
| response_format 被忽略 | 模型 | — | 否 | 否 |

- **模型级失败停用**（#806）：15 分钟内跨密钥 3 次可重试失败 → 模型在**其所有密钥**上停用 10 分钟（启发式、可探测）。
- **空补全连击限制**（#751）：同一模型+密钥上连续 3 次推理截断补全 → 豁免取消 → 正常冷却/惩罚/限流学习生效。

---

## 10. 粘性会话

- 键 = SHA-1(首条用户消息 [:: strategyKey])，TTL 30 分钟。
- 防止会话中途换模型 → 幻觉激增。
- 会话亲和推理轨迹记忆（#797）：恢复客户端回放时剥离的 `reasoning_content`，作用域限定在生成它的模型。

---

## 11. 统一模型组（Unify）

启用时，逻辑模型（如 `glm-4.7`）把多提供方折叠成一个 `/v1/models` 条目。路由**严格在组内回退**——绝不去别的模型。slug 解析成员上的 `match_tier = 1` 防止静默替换。

---

## 12. 策略预设

| 策略 | 可靠性 | 速度 | 智能 |
|----------|-------------|-------|--------------|
| balanced | 0.50 | 0.25 | 0.25 |
| smartest | 0.35 | 0.10 | 0.55 |
| fastest  | 0.35 | 0.55 | 0.10 |
| reliable | 0.70 | 0.15 | 0.15 |
| custom   | 用户自调（归一化） | | |
| priority | 手动顺序 + 429 惩罚（密集秩 + 惩罚） | | |

---

## 13. 关键函数 (router.ts)

| 函数 | 用途 |
|----------|---------|
| `routeRequest(...)` | 主入口：选路由，应用所有过滤（视觉、工具、粘性、组、response_format） |
| `orderChain(chain, strategy, sampled)` | 按策略排序链；`sampled=true` 实时路由，`false` 稳定仪表盘 |
| `scoreChainEntry(...)` | 算五轴 + 护栏 → 最终分 |
| `orderKeysByScore(entry, keys)` | 密钥级 Thompson 排序 |
| `resolveRoutingChain(modelString)` | 解析 `auto`、`auto:smart`、`auto:profile-name` |
| `recordRateLimitHit/recordModelFailure/recordSuccess` | 惩罚突变 |
| `summarizeExhaustion(diag, soonestResetMs)` | 客户端安全耗尽消息 |

---

## 14. 关键函数 (scoring.ts)

| 函数 | 用途 |
|----------|---------|
| `reliabilityPosterior(s, f, community?)` | 返回 `{alpha, beta}` |
| `expectedReliability(s, f, community?)` | 确定性 α/(α+β) |
| `sampleBeta(α, β)` | Marsaglia & Tsang 双 Gamma 抽样 |
| `speedScore(tok/s, ttfbMs)` | 混合 [0,1] 速度 |
| `intelligenceComposite(sizeLabel, rank)` | 层优先复合 |
| `intelligenceScore(composite, min, max)` | Min-max 归一化 |
| `headroomFactor(used, budget)` | 额度护栏乘数 |
| `rateLimitFactor(penalty)` | 惩罚护栏乘数 |
| `combineScore(inputs, weights)` | 凸基础 × 护栏 |