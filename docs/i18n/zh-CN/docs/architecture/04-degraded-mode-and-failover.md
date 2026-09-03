[English](../../../../architecture/04-degraded-mode-and-failover.md) · **简体中文**

# 降级模式与回退 —— 深度剖析

> **源码：** `server/src/services/degradation.ts`、`server/src/lib/fallback-loop.ts`、`server/src/routes/proxy.ts`、`server/src/services/ratelimit.ts`

## 1. 降级模式状态机 (f412e97)

### 目的

当大量启用的提供方同时挂掉时，逐请求探测和老虎机探索只会在死路上烧重试预算。降级模式状态机跟踪**健康提供方比率**（由定时健康巡检驱动），一旦比率在持续期内跌破阈值，就把网关翻进降级态。

### 状态机

```
┌─────────────┐     比率 < 阈值 持续 DEGRADED_ENTRY_GRACE_MS     ┌─────────────┐
│   normal    │ ─────────────────────────────────────────────────────▶ │  degraded   │
└─────────────┘                                                       └─────────────┘
      ▲                                                                     │
      │     比率 ≥ 阈值 持续 DEGRADED_EXIT_GRACE_MS                       │
      └────────────────────────────────────────────────────────────────────┘
```

### 参数（环境变量可调）

| 变量 | 默认值 | 含义 |
|----------|---------|---------|
| `DEGRADED_HEALTHY_RATIO` | 0.5 | 必须有 ≥1 可用密钥的提供方占比 |
| `DEGRADED_MIN_PROVIDERS` | 3 | 评估用的最少启用提供方数（单提供方部署不抖动） |
| `DEGRADED_ENTRY_GRACE_MS` | 60,000 | 低于阈值多久后进入降级 |
| `DEGRADED_EXIT_GRACE_MS` | 120,000 | 高于阈值多久后退出（更长 = 迟滞） |

### 健康快照

```typescript
interface HealthSnapshot {
  healthyProviders: number  // 有 ≥1 密钥处于 {healthy, unknown} 的启用提供方数
  totalProviders: number    // 有 ≥1 密钥的启用提供方数（任意状态）
  ratio: number             // healthy / total（total=0 时为 1）
}
```

- `unknown` 算健康（未探测密钥 = 探测说不行前视为可用）。
- 每次健康巡检 + 按需（仪表盘、路由器入口）从 `api_keys` 表算出。

### 降级态下的行为变化

| 方面 | 正常 | 降级 |
|--------|--------|----------|
| 老虎机探索 | 10% 底线（若开启） | **禁用** —— 只按剩余健康提供方的评分顺序 |
| 路由器 | 路由时查 `isDegraded()` | 同 |
| 健康端点 | 报 `state: 'normal'` | 报 `state: 'degraded', degradedAt: timestamp` |
| 日志 | — | 进入时 `console.warn`，退出时 `console.log` |

### API

```typescript
isDegraded(): boolean                    // 只读，路由器用
getDegradationStatus(): DegradationStatus // {healthyProviders, totalProviders, ratio, state, degradedAt}
updateDegradationState(now?): DegradationStatus // 每次健康巡检后调
resetDegradationState()                  // 测试、启动后重探
```

---

## 2. 重试预算与对冲 (1d2226a)

### 挂钟重试预算

- **默认**：45 s（`FALLBACK_TIME_BUDGET_MS`、设置 `fallback_time_budget_ms`、0 = 关）。
- **在每次重试**前检查（尝试 ≥ 1）。尝试 0 总跑；尝试 1 总跑（这样尝试 0 即使耗尽整个预算，回退在结构上也是可能的）。
- **耗尽渲染**：`timedOut: true` + `budgetMs` 在 `ExhaustionContext` 里 → 消息含 "stopped early: retry time budget 45s exceeded — one failover hop is always allowed, and past that the budget stops starting further retries and cancels an attempt still waiting on its first byte"。

### 对冲（中止在途）

> v2 前：预算只拒绝**发起**下一次重试。一个停滞的尝试能跑几分钟，卡住链。
>
> **v2 (1d2226a)**：预算中途过期时，`abortInFlight()` 经 `AbortController` 取消上游取获（穿进 `CompletionOptions.signal`）。

```typescript
// 在 fallback-loop.ts 里
abortInFlight: () => hedgeAbort.abort(newHedgeAbortError())
```

- `HedgeAbortError` 是**非提供方健康** → 无冷却、无惩罚、无限额学习。
- 渲染 `timedOut` 耗尽（不是提供方失败）。
- 流式面在首字节/头部刷出时调 `ctx.disarmHedge()` —— 过了那点答案已经在路上了，杀掉它只会为了无回退收益而截断健康响应。

### 断路器护栏

- `max_consecutive_upstream_fails`（设置 `max_consecutive_upstream_fails`，默认 0 = 关）。
- 计数尝试循环里连续的可重试上游失败。
- 触发 → `ExhaustionContext` 里的 `breakerFails` → **503 service_unavailable** 并带 "upstream_unhealthy" 码。
- "The enabled pool looks unhealthy right now, so the remaining candidates were skipped instead of burning quota on them."

---

## 3. X-Fallback-Detail 头 (8cb75ac)

### 目的

`X-Fallback-Trail` 告诉**哪些跳烧了、为什么**。`X-Fallback-Detail` 加上**烧了多久**——这是智能体重构不出来的部分（一个 40s 响应：一家卡了 39s vs 四家快速失败）。

### 格式

```
X-Fallback-Detail: platform/model keyN=outcome t=startOffset+durationMs msg=summary; +N more
```

- **逐跳耗时** + 脱敏提供方消息。
- **可选**：`EXPOSE_FALLBACK_DETAIL_HEADER=1` 或设置 `expose_fallback_detail_header`。
- **预算**：总计 2048 字符，单条消息摘要 120 字符，最多显示 10 跳。
- **仅失败跳**：当前服务的跳在头部开着时不可知（dispatch 返回后才记），所以不显示。

### 示例

```
X-Fallback-Detail: google/gemini-2.5-pro key1=rate_limited t=0+1205ms msg=429 Quota exceeded; groq/llama-3.3-70b key2=upstream_error t=1205+3450ms msg=503 Service unavailable; +1 more
```

### 实现

```typescript
// fallback-loop.ts
formatAttemptDetail(records: AttemptTraceRecord[]): string
// AttemptTraceRecord: {platform, modelId, keyOrdinal, outcome, startOffsetMs, durationMs, errorSummary}

// 响应上设置（flush 前）：
if (isFallbackDetailHeaderEnabled() && records?.length) {
  res.setHeader('X-Fallback-Detail', safeHeaderValue(formatAttemptDetail(records), 2048));
}
```

---

## 4. 裸 Safe/Unsafe 分类输出回退 (a961d93)

### 问题

某些中继模型（如 OpenCode Zen）把裸的 `"safe"` 或 `"unsafe"` 分类词作为**整个补全**吐出来，而不是被请求的答案。这是上游内容过滤器，不是模型输出。

### 修复

```typescript
// proxy.ts，非流补全后：
const text = completionTextFromChat(result);
if (!text) { throw empty completion... }

// #809：中继吐裸分类输出时回退
if (isUpstreamClassificationOutput(text, route.platform)) {
  throw Object.assign(
    new Error(`empty completion from ${route.displayName} (upstream classification output)`),
    result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
  );
}
```

- `isUpstreamClassificationOutput(text, platform)` 在已知中继平台上检查精确的 `"safe"` / `"unsafe"`（大小写不敏感、去首尾空白）。
- 视同空补全：**回退**，`finish_reason === 'length'` 时 `skipBench: true`（推理吃光预算）。
- 流式路径：流结束时对累积文本做同一检查。

---

## 5. 统一回退循环 (`lib/fallback-loop.ts`)

### 所有面共享

| 面 | 路由 | 派发 |
|---------|-------|----------|
| `/v1/chat/completions` | `proxy.ts` | SSE 流式 + 非流 |
| `/v1/responses` | `responses.ts` | Responses API 分帧 |
| `/v1/messages` | `anthropic.ts` | Anthropic SSE 事件 |
| `/v1/completions` | `proxy.ts` | 旧版 text_completion SSE |

### 循环契约

```typescript
interface FallbackHooks {
  maxRetries?: number;              // 默认 20
  timeBudgetMs?: number;            // 默认 getFallbackTimeBudgetMs()
  breakerLimit?: number;            // 默认 getMaxConsecutiveUpstreamFails()
  attemptLog?: AttemptRecord[];     // 突变，用于 X-Fallback-Trail
  state: FallbackState;             // skipKeys, skipModels, skipPlatforms
  clientGone?: () => boolean;       // 每次重试前查
  abortInFlight?: () => void;       // 对冲 (v2)
  route(attempt): RouteResult;      // 同步耗尽时抛 RouteError
  dispatch(route, attempt, ctx): Promise<'done' | 'committed'>;
  logFailure(route, err, attempt): void;
  onFatal(route, err, attempt): void;           // 非可重试 → 502
  onRoutingExhausted(lastError, routeErr, exhaustion, info): void; // 零尝试
  onExhausted(exhaustion, info): void;          // 重试耗尽
}
```

### 尝试分类 (recordRetryableFailure)

| 错误 | 跳过范围 | 冷却 | 模型惩罚 | 限额学习 |
|-------|------------|------|---------------|-------------|
| 401 无效密钥 | 密钥 | 5 min | 否 | 否 |
| 402 需付款 | 密钥 | 24h | 否 | 否 |
| 403 模型被禁 | **模型** | 24h | 否 | 否 |
| 429 每日耗尽 | 模型+密钥 | 到午夜 / Retry-After | **重 (3)** | 是 |
| 429 瞬时 (rpm/tpm) | 密钥 | 90s / 阶梯 | 轻 (1) | 是 |
| 5xx / 超时 / 传输 | **平台** (#788) | 90s / 阶梯 | 轻 (1) | 否 |
| 空补全（推理） | 密钥 | 豁免（连击 ≤3） | 否 | 否 |
| 上下文过大 | 模型 | — | 否 | 否 |
| response_format 被忽略 | 模型 | — | 否 | 否 |
| 无效工具参数 | 密钥 | — | 否 | 否 |

### 模型级失败停用 (#806)

- 15 分钟内跨密钥 3 次可重试失败 → 模型在**其所有密钥**上停用 10 分钟（启发式、可探测）。
- 一次服务成功的请求清空失败窗口。

### 空补全连击限制 (#751)

- 同一模型+密钥上连续 3 次推理截断补全 → 豁免取消 → 正常冷却/惩罚/限额学习生效。
- 成功或正常惩罚失败时重置。

### 提供方级跳过 (#788)

- 5xx / 超时 / 传输 / 降级 → `skipPlatforms.add(platform)`。
- 整个提供方在本请求里排除——循环直接跳到下一提供方，而不是按密钥烧一跳。

### 耗尽渲染 (exhaustedRetryError)

**按尝试类最具体优先聚合：**

1. **全 auth** → 502 `provider_error` (`provider_authentication_failed`) —— 区别于限流，从不怪客户端密钥。
2. **全 context_too_large** → 413 `invalid_request_error` (`context_length_exceeded`)。
3. **全 model_not_found** → 404 `invalid_request_error` (`model_not_found`)。
4. **末尾错误 = degraded 400**（NVIDIA NIM） → 503 `service_unavailable` (`provider_degraded`)。
5. **末尾错误 = 提供方坏请求** → 400 `invalid_request_error` (`provider_rejected_request`)。
6. **断路器** → 503 `service_unavailable` (`upstream_unhealthy`)。
7. **全 UNAVAILABLE_UNTIL_KNOWN_TIME**（rate_limited、daily_quota_exhausted、out_of_credits、forbidden） → 429 `rate_limit_error` 带 `retryAtMs` + `Retry-After`。
8. **混合/其他** → 502 `provider_error` (`upstream_failed`) —— 绝不 500（那是我们的 bug）。

**同步耗尽（零尝试）：** `routingExhaustionBody(routeErr)` 把 diagnostics 映射到同一分类：
- 全配置（无密钥、无提供方） → 503 `no_providers_configured`
- 全 too_large (+ 配置) → 413 `context_length_exceeded`
- 部分 time_bound、其余配置/too_large → 429 带 `retryAtMs`
- 否则 → 429 `routing_exhausted`

---

## 6. 尝试轨迹与头部

### X-Fallback-Attempts

成功**和**耗尽响应上、本次响应前的失败跳数。

### X-Fallback-Trail

```
platform/model key1=class; platform/model key2=class; +N more
```

- `class` ∈ `AttemptErrorClass`（auth、out_of_credits、daily_quota_exhausted、model_not_found、forbidden、context_too_large、provider_bad_request、empty_completion、format_ignored、invalid_tool_arguments、timeout、rate_limited、upstream_error、error）。
- 最多显示 10 个，1024 字符上限。

### X-Fallback-Detail（可选）

见 §3 上文。

---

## 7. 关键函数 (degradation.ts)

| 函数 | 用途 |
|----------|---------|
| `computeHealthSnapshot()` | 读 `api_keys` → `{healthyProviders, totalProviders, ratio}` |
| `updateDegradationState(now)` | 状态机步进，健康巡检后调 |
| `isDegraded()` | 路由器闸门 |
| `getDegradationStatus()` | 仪表盘 + 健康端点 |
| `resetDegradationState()` | 测试 / 启动重探 |

---

## 8. 关键函数 (fallback-loop.ts)

| 函数 | 用途 |
|----------|---------|
| `runFallbackLoop(hooks)` | 主循环 |
| `newFallbackState()` | 新 `{skipKeys, skipModels, skipPlatforms}` |
| `cooldownDecisionForError(route, err)` | 阶梯 + Retry-After + 来源 |
| `recordRetryableFailure(route, err, state, now)` | 完整记账 |
| `recordAuthFailure(route, state)` | 401：跳密钥、5min 停用、触发重校验 |
| `recordUpstreamSuccess(route, tokens)` | 核算 + 清连击 + 标密钥健康 |
| `exhaustedRetryError(lastError, maxRetries, ctx)` | 诚实终态 + 响应体 |
| `routingExhaustionBody(routeErr)` | 从 diagnostics 来的零尝试耗尽 |
| `setFallbackHeaders(res, failedAttempts, trail)` | X-Fallback-Attempts + X-Fallback-Trail |
| `setExhaustionHeaders(res, body)` | 从 `retryAtMs` 算 Retry-After |
| `formatAttemptTrail(attempts)` | X-Fallback-Trail 值 |
| `formatAttemptDetail(records)` | X-Fallback-Detail 值 |
| `isFallbackDetailHeaderEnabled()` | 设置 → 环境 → false |
| `getFallbackTimeBudgetMs()` | 设置 → 环境 → 45s |
| `msUntilNextUtcMidnight()` | 每日额度重置边界 |

---

## 9. 流程：请求进入降级网关

```
request → /v1/chat/completions
  ├─ isDegraded() = true
  │   └─ router: 探索 禁用，只按评分顺序
  ├─ runFallbackLoop()
  │   ├─ 尝试 0: route() → 最佳健康模型
  │   ├─ dispatch() → 429 每日耗尽
  │   │   └─ recordRetryableFailure() → 冷却（权威性、到午夜）
  │   │   └─ skipKeys.add()、skipModels.add()（每日耗尽 = 模型级）
  │   ├─ 尝试 1: route() → 下一健康（遵守 skipKeys）
  │   ├─ ... 每次重试前预算检查 ...
  │   ├─ 预算中途过期于尝试 3
  │   │   └─ abortInFlight() → HedgeAbortError
  │   │   └─ 循环停、timedOut 耗尽
  │   └─ onExhausted() → 429 带 X-Fallback-Detail + Retry-After
  └─ 响应头：X-Fallback-Attempts、X-Fallback-Trail、X-Fallback-Detail
```