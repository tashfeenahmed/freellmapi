[English](../../../../architecture/02-quota-and-cooldown-engine.md) · **简体中文**

# 额度与冷却引擎 —— 深度剖析

> **源码：** `server/src/services/ratelimit.ts`、`server/src/services/cooldown-probe.ts`、`server/src/services/provider-quota.ts`

## 1. 概览

额度引擎是路由器与上游提供方之间的**看门人**。它为每个 `(platform, model, key)` 维护四个滑动窗口加提供方级池、持久化到 SQLite、并从提供方错误正文学真实限额。冷却用升级阶梯停用失败的密钥/模型，后台探测任务提前恢复启发式冷却。

---

## 2. 四维额度核算

### 按 (平台, 模型, 密钥) 的窗口

| 窗口 | 宽度 | 持久化列 | 内存兜底 |
|--------|-------|------------------|-------------------|
| RPM    | 60 s  | `rpm_limit`      | `timestamps[]`    |
| RPD    | 24 h (UTC 午夜) | `rpd_limit` | `timestamps[]` |
| TPM    | 60 s  | `tpm_limit`      | `{ts, tokens}[]`  |
| TPD    | 24 h (UTC 午夜) | `tpd_limit` | `{ts, tokens}[]` |

- RPM/TPM 用**滑动分钟**；RPD/TPD 用 **UTC 天边界**（提供方在午夜重置，不是 24h 滚动）。
- `rate_limit_usage` 表：每个请求/词元事件一行，`kind = 'request' | 'tokens'`，`created_at_ms`。
- 留存：1 天（插入时修剪，节流到 1/分）。
- **降级模式**：数据库写失败时，计数只进内存窗口（推入时修剪，长故障也不会无界增长）。

### 暂存用量（在途租约）

> **把 check-then-act 缝紧。** 从选密钥到事后 `recordRequest/recordTokens` 写入之间，N 个并发请求会读到同一个预检值，合力冲破限额。**租约让在途请求对下一个调用者可见。**

```typescript
acquireLease(platform, modelId, keyId, estimatedTokens) → leaseId
releaseLease(leaseId)  // finally 块里，幂等
```

- 租约同时计入**分钟和天窗口**（一个在途请求属于本分钟也属于今天）。
- 最大租约寿命：2 分钟（泄漏租约的兜底）。
- 按密钥并发上限（经 `MAX_CONCURRENT_REQUESTS_PER_KEY[_PLATFORM]` 可选开启）。

### 提供方级池

有些提供方在**整个账号**上强制一个额度，不是按模型：

| 池 | 提供方 | 配置 |
|------|-----------|--------|
| 每日请求 | OpenRouter（免费 1000/天，<10 积分 50/天）、ModelScope（2000→1800 边际） | `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` |
| 每日词元 | NavyAI（共享 150K/天，模型乘数） | `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` |
| 每分钟请求 | NVIDIA NIM（账号级 40 RPM） | `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` |

- 通过对同一 `platform + keyId` 的各模型窗口求和来计数。
- NavyAI 词元乘数从 `monthly_token_budget` 标签（如 `2x`）解析或从 `tpd_limit` 推导。

### 提供方额度键（跨模型池化）

`inferQuotaPoolKey(platform, modelId)` → 形如 `openrouter::free`、`google::project`、`nvidia::account` 的字符串。供分析把用量归到正确的共享桶。

---

## 3. 冷却阶梯与来源

### 来源

| 来源 | 含义 | 可探测？ |
|--------|---------|-----------------|
| `heuristic` | 我们自己的猜测（瞬时 90s、升级阶梯、鉴权失败停用、空补全） | **是** |
| `authoritative` | 有显式提供方 Retry-After 或每日额度重置支撑（事实） | 否 |
| `credit` | 402 额度用光——密钥校验对充值证明不了任何事 | 否 |
| `tier` | 403 模型不在档位——密钥校验通过但模型仍被档位门槛挡住 | 否 |

### 升级阶梯（按模型+密钥，滚动 24h）

| 命中数 | 时长 | 注记 |
|-------|----------|-------|
| 1 | 2 min | |
| 2 | 10 min | |
| 3 | 1 h | |
| 4+ | 24 h | |

- 日计数器健康时的**瞬时 RPM/TPM 429** → 短 90s 冷却，**不计入**阶梯。
- **每日耗尽**（RPD/TPD 计数器 ≥ 上限） → 走阶梯（最多 24h）。
- **未知限额**（NULL RPD/TPD）：启发式——1 小时内 2+ 次 429 → "实际上每日耗尽" → 升级**但封顶 10 分钟**（`UNKNOWN_LIMIT_MAX_COOLDOWN_MS`）。防止 Ollama/Cloudflare 等在每个请求都是 429 时陷入 90s 死循环。
- **本地端点**（环回/RFC1918 `base_url`）：封顶 **5 s**，绝不升级（#592）。

### Retry-After 处理

```
if (retryAfterMs > ourBench) → bench = min(retryAfterMs, 24h), source = 'authoritative'
else → our bench 维持, source = 'heuristic'
```

提供方给的重置时间胜出；超过它的部分是我们猜的。

### 特殊冷却

| 触发 | 时长 | 来源 |
|---------|----------|--------|
| 402 需付款 | 24 h | `credit` |
| 403 模型被禁 | 24 h | `tier` |
| 每日额度耗尽（显式） | 到 UTC 午夜 / Retry-After | `authoritative` |
| 鉴权失败 (401) | 5 min（健康周期） | `heuristic` |
| 空补全连击（≥3） | 正常阶梯 | `heuristic` |

---

## 4. 从错误正文学真实限额 (#798)

提供方拒绝时在正文里给出真实限额时，我们**持久化它**，让预检在下一次 413/429 前拦住我们。

```typescript
// Groq 413: "...on tokens per minute (TPM): Limit 30000, Requested 33476"
parseProviderLimit(message) → { kind: 'tpm', limit: 30000 }
learnLimitFromError(modelDbId, err) → 写入 models.tpm_limit（如果 NULL 或更低）
```

- **只收紧**：填 NULL 或**降低**现有限额。永不升高——撞上天花板意味着预检已经放行过量。
- 轴优先级：TPD → TPM → RPD → RPM（天先于分钟，词元先于请求）。
- 要求**同时**有 "Limit N" 和自信的轴匹配——不猜。

---

## 5. 冷却探测提前恢复 (`cooldown-probe.ts`)

### 目的

启发式冷却是悲观的。提供方更早恢复（分钟窗口滚过、事故结束）时，产能会闲置到计时器过期。探测任务**校验密钥**并提前清除启发式冷却。

### 算法

- **扫描间隔**：60 s（在 `rate_limit_cooldowns` 上做便宜的索引 SELECT，`source = 'heuristic'`）。
- **成熟度**：冷却必须已过 ≥50% **且** 剩余 ≥60 s。
- **按密钥退避**：2m → 4m → 8m → 15m 封顶（探测失败 = 退避，冷却不变）。
- **首见错开**：重启时所有持久化冷却一次性被看见。首次探测排在 `now + jitter(0..45s)` 避免惊群。
- **预算**：`COOLDOWN_PROBE_MAX_PER_PASS`（默认 3，环境变量可调）。
- **探测通过时**：清除该密钥的**所有**启发式冷却（跨模型），记 `cooldown_recovered` 事件。
- **绝不探测**：authoritative/credit/tier 冷却（查询时过滤掉）。

### 熔断开关

`COOLDOWN_PROBE_DISABLED=1`

---

## 6. 关键函数 (ratelimit.ts)

| 函数 | 用途 |
|----------|---------|
| `canMakeRequest(platform, modelId, keyId, limits)` | RPM+RPD+在途租约预检 |
| `canUseTokens(platform, modelId, keyId, estTokens, limits)` | TPM+TPD+在途租约预检 |
| `canUseProvider(platform, keyId)` | 提供方级每日请求上限 |
| `canUseProviderMinute(platform, keyId)` | 提供方级每分钟请求上限 |
| `canUseProviderTokens(platform, keyId, modelId, estTokens)` | 提供方级每日词元上限 |
| `recordRequest/recordTokens` | 成功后核算（DB + 在途释放） |
| `acquireLease/releaseLease` | 在途并发 + 暂存用量 |
| `getCooldownDecisionForLimit(...)` | 完整阶梯 + Retry-After + 来源 |
| `setCooldown(platform, modelId, keyId, durationMs, source)` | 持久化 + 内存 |
| `isOnCooldown(platform, modelId, keyId)` | 查内存 → DB → 过期 |
| `getProbeableCooldowns()` | 仅启发式，给探测任务 |
| `clearCooldownEarly(platform, modelId, keyId)` | 探测恢复（保留升级历史） |
| `parseProviderLimit(message)` | 从错误正文提取 `{kind, limit}` |
| `learnLimitFromError(modelDbId, err)` | 收紧时持久化 |
| `getSoonestCooldownExpiry()` | 给 `Retry-After` 头 + 耗尽消息 |

---

## 7. 关键函数 (cooldown-probe.ts)

| 函数 | 用途 |
|----------|---------|
| `runCooldownProbePass(opts?)` | 一次扫描 → 探测成熟密钥 → 通过即清除 |
| `isRipe(cooldown, now)` | ≥50% 已过 + ≥60s 剩余 |
| `startCooldownProbe(scheduler)` | 注册 60s 间隔任务 |
| `resetCooldownProbeState()` | 测试缝合点 |

---

## 8. 持久化 Schema（相关表）

```sql
-- 按 (平台,模型,密钥) 的用量事件
CREATE TABLE rate_limit_usage (
  platform TEXT, model_id TEXT, key_id INTEGER,
  kind TEXT CHECK(kind IN ('request','tokens')),
  tokens INTEGER, created_at_ms INTEGER
);
CREATE INDEX idx_rate_limit_usage_lookup
  ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);

-- 带来源的冷却
CREATE TABLE rate_limit_cooldowns (
  platform TEXT, model_id TEXT, key_id INTEGER,
  expires_at_ms INTEGER, source TEXT CHECK(source IN ('heuristic','authoritative','credit','tier')),
  set_at_ms INTEGER,
  PRIMARY KEY (platform, model_id, key_id)
);

-- 服务器日志（仅 warn/error）
CREATE TABLE server_logs (
  id INTEGER PRIMARY KEY, level TEXT, source TEXT, provider TEXT,
  model TEXT, event TEXT, request_id TEXT, message TEXT, created_at_ms INTEGER
);
```

---

## 9. 环境变量

| 变量 | 默认值 | 用途 |
|----------|---------|---------|
| `MAX_CONCURRENT_REQUESTS_PER_KEY` | null（无限） | 全局按密钥并发上限 |
| `MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM>` | null | 平台专属覆盖 |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` | 见表 | 提供方级每日请求上限（0 = 关） |
| `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` | 见表 | 提供方级每日词元上限 |
| `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` | 见表 | 提供方级每分钟请求上限 |
| `COOLDOWN_PROBE_DISABLED` | 0 | 探测任务熔断开关 |
| `COOLDOWN_PROBE_MAX_PER_PASS` | 3 | 每 60s 扫描的探测数 |
| `DEGRADED_HEALTHY_RATIO` | 0.5 | 降级模式阈值（见 04-degraded-mode） |
| `DEGRADED_MIN_PROVIDERS` | 3 | 降级评估的最少提供方数 |
| `DEGRADED_ENTRY_GRACE_MS` | 60000 | 低于阈值多久后进入 |
| `DEGRADED_EXIT_GRACE_MS` | 120000 | 高于阈值多久后退出 |

---

## 10. 流程图：请求 → 额度检查 → 派发 → 核算

```
routeRequest()
  ├─ canMakeRequest()        → RPM + RPD + 在途租约
  ├─ canUseTokens()          → TPM + TPD + 在途租约
  ├─ canUseProvider()        → 提供方每日请求上限
  ├─ canUseProviderMinute()  → 提供方每分钟请求上限
  ├─ canUseProviderTokens()  → 提供方每日词元上限
  ├─ canUseKeyConcurrency()  → 按密钥并发上限
  └─ isOnCooldown()          → 启发式/权威性停用
        ↓
acquireLease()  （暂存用量对下一个调用者可见）
        ↓
派发给提供方
        ↓
成功:
  recordRequest()  → DB + releaseLease()
  recordTokens()   → DB + releaseLease()
  清除冷却命中 / 空限额命中
失败（可重试）:
  recordRetryableFailure() → cooldownDecisionForError() → setCooldown()
  recordRateLimitHit() / recordModelFailure() (模型惩罚)
  learnLimitFromError()    （提供方报了天花板）
  skipKeys.add(platform:modelId:keyId)
  403/404/上下文过大 → skipModels.add(modelDbId)
  5xx/超时 → skipPlatforms.add(platform) (#788)
```