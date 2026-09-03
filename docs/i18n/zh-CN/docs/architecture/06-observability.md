[English](../../../../architecture/06-observability.md) · **简体中文**

# 可观测性 —— 深度剖析

> **源码：** `server/src/lib/server-logs.ts`、`server/src/routes/logs.ts`、`server/src/lib/request-log.ts`、`server/src/lib/log-redaction.ts`、`server/src/lib/attempt-trace.ts`

## 1. 服务器日志查看器 (`server-logs.ts`)

### 双层存储

| 层级 | 容量 | 持久化 | 级别 | 用途 |
|------|----------|-------------|--------|---------|
| **环形缓冲区** | 1000 条 | 仅内存 | 全部（trace、debug、info、warn、error） | 实时仪表盘视图、轮询 |
| **SQLite 表** | 无界（经用量修剪 1 天留存） | 持久化 | **仅 warn、error** | 重启保留、历史分析 |

- **单一 ID 空间**：`id` 在入口分配（不是 SQLite），启动时从 `MAX(id)` 种子，所以 ID 跨重启单调递增。仪表盘用 `sinceId` 游标轮询，两层通用。
- **噪音过滤**：`NOISE_RE` 丢弃 `GET /api/logs` 和 `GET /api/ping` 的访问日志行（防自喂缓冲）。
- **消息上限**：6000 字符，超出截断并加 `… [truncated]` 后缀。
- **来源提取**：从消息里的 `[Tag]` 前缀推导（如 `[Health]`、`[CooldownProbe]`、`[Proxy]`）——无需调用点标注。

### 入口路径

```
console.log/warn/error/debug/trace
    │
    ▼
lib/log-redaction.ts (console 包装器)
    ├─ 脱敏机密（API 密钥、令牌、认证头等）
    ▼
server-logs.ts.recordConsoleLine(level, args)
    ├─ 格式化参数（Error → 堆栈、对象 → inspect 深度 2）
    ├─ 噪音过滤 + 长度上限
    ├─ 推入环（>1000 则 splice）
    └─ 若 level ∈ {warn, error} → persist(entry) → INSERT INTO server_logs
```

**重入守卫**：
- `mirroring` —— `providerLog()` 经包装过的 console 镜像回 stdout；防二次入口。
- `persisting` —— DB 层会记日志（忙超时、权限）；跳过持久化写但环仍收。
- `seeding` —— 启动种子探 DB，那也能记日志。

### 结构化提供方日志

```typescript
providerLog(level, message, { provider, model, event, requestId })
```

- 带元数据记录供仪表盘过滤，**并**镜像到 stdout（已脱敏）。
- 用于：健康检查器、冷却探测、路由器、回退循环、目录同步。

### 启动预加载

首次入口（或显式 `initServerLogs()` 调用）时：
1. 从 `server_logs` 的 `MAX(id)` 种子 `lastId`。
2. 预加载最近 200 条持久化行（最新优先，反转成最旧优先进环）。
3. 把持久化最大 ID **之上**的任何启动前环条目**重打戳**（ID 跨层唯一）。

### API (`GET /api/logs`)

```typescript
queryLogs({
  levels?: ServerLogLevel[],    // 过滤（trace 并入 debug）
  q?: string,                   // 全文搜（message + provider + source + event）
  provider?: string,            // 精确提供方过滤
  sinceId?: number,             // 游标（返回 > sinceId 的条目）
  limit?: number                // 1..500（默认 200）
}): ServerLogEntry[]
```

- **倒着走环**，这样 `limit` 真管用，不是只管结果集大小。
- 返回最旧→最新。
- `currentMaxId()` → 最高已发 ID（即使被过滤空也能给游标上界）。

### 级别计数（仪表盘徽章）

```typescript
levelCounts(): { debug: number; info: number; warn: number; error: number }
```

- `trace` 并入 `debug`（共 4 个徽章）。

### 清空 / 重置

- `clearLogs()` —— 清环 + `DELETE FROM server_logs`。**ID 计数器不重置**（不然仪表盘游标会收到重复 ID）。
- `resetServerLogsForTest()` —— 测试缝：全清 + 计数器 + 种子态。

---

## 2. 请求分析 (`request-log.ts`)

### 逐请求行 (`requests` 表)

| 列 | 来源 |
|--------|--------|
| `platform`, `model_id`, `key_id` | RouteResult |
| `request_type` | `'chat' \| 'embeddings' \| 'image' \| 'speech' \| 'transcription' \| 'fusion'` |
| `status` | `'success' \| 'error' \| 'canceled'` |
| `input_tokens`, `output_tokens`, `total_tokens` | 提供方用量 + 估算 |
| `latency_ms` | 挂钟 |
| `ttfb_ms` | 首词元（内容**或**推理） |
| `error` | 脱敏提供方消息 |
| `created_at_ms` | 时间戳 |
| `client_info` | User agent、IP 哈希 |
| `served_model` | 上游报的模型（可观测性） |
| `attempt_error_summary` | 本请求聚合的失败类别 |

### 尝试轨迹 (`request_attempts` 表)

每个派发并失败的尝试一行：

| 列 | 用途 |
|--------|---------|
| `request_id` | FK 到 `requests` |
| `attempt_ordinal` | 0-based |
| `platform`, `model_id`, `key_id` | 试了什么 |
| `error_class` | `AttemptErrorClass`（auth、rate_limited、upstream_error、...） |
| `error_summary` | 脱敏提供方消息（≤200 字符） |
| `latency_ms` | 逐尝试挂钟 |
| `ttfb_ms` | 逐尝试 TTFB |
| `input_tokens`, `output_tokens` | 逐尝试估算 |

- 给 `X-Fallback-Trail` / `X-Fallback-Detail` 头供电。
- 让仪表盘能按请求钻取。

### 聚合 (`request_aggregates` 物化视图)

仪表盘图表的预计算卷起（24h / 7d / 30d / 90d 窗口）：
- 延迟 p50 / p95 / p99
- TTFB p50 / p95
- 词元吞吐
- 成功率
- 估算成本节省
- 按提供方 / 模型 / 密钥细分

---

## 3. 日志脱敏 (`log-redaction.ts`)

### 脱敏什么

| 模式 | 替换 |
|---------|-------------|
| `Bearer <token>` | `Bearer [REDACTED]` |
| `x-api-key: <key>` | `x-api-key: [REDACTED]` |
| `x-goog-api-key: <key>` | `x-goog-api-key: [REDACTED]` |
| `Authorization: Basic <creds>` | `Authorization: Basic [REDACTED]` |
| JSON 体里的 API 密钥 | `[REDACTED]` |
| 带嵌入凭证的 URL | `[REDACTED]` |
| SQLite 加密密钥 | `[REDACTED]` |

- 在 console 包装器单次通过 → **所有**日志路径（console、providerLog、启动行）都被脱敏。
- 幂等：已脱敏文本原样通过。

---

## 4. 尝试追踪 (`attempt-trace.ts`)

### AsyncLocalStorage 作用域

每个请求得一个 `AsyncLocalStorage<RequestTrace>` 作用域：

```typescript
interface RequestTrace {
  requestId: string;
  startedAtMs: number;
  records: AttemptTraceRecord[];
}

interface AttemptTraceRecord {
  platform: string;
  modelId: string;
  keyOrdinal: number;      // 本请求内 1-based
  outcome: AttemptOutcome; // 'success' | 'retryable_failure' | 'auth_failure' | 'fatal' | 'hedge_abort'
  startOffsetMs: number;   // 相对请求开始
  durationMs: number;
  errorSummary: string | null; // 脱敏、≤200 字符
}
```

- `runWithRequestTrace(fn)` 包装回退循环。
- `dispatch()` 记开始偏移、跑尝试、记时长 + 结果 + 摘要。
- `getRequestTrace()` 读当前作用域（给 `X-Fallback-Detail` 头）。

### 结果

| 结果 | 含义 |
|---------|---------|
| `success` | 尝试完成、响应已发 |
| `retryable_failure` | 429/5xx/超时/空 → 回退 |
| `auth_failure` | 401 → 触发密钥重校验 |
| `fatal` | 非可重试（400、404 模型没了、等） |
| `hedge_abort` | 预算中途过期中止尝试 (1d2226a) |

---

## 5. 健康端点 (`/api/health`、`/livez`、`/readyz`)

| 端点 | 用途 |
|----------|---------|
| `GET /livez` | 进程活着（k8s 存活探针） |
| `GET /readyz` | 可服务（DB + 至少一健康提供方） |
| `GET /api/health` | 完整状态：`{status, degraded, providers: [{platform, healthy, totalKeys, usableKeys, status}], catalog: {version, tier, lastSync}}` |

- 降级模式经 `degradation.getDegradationStatus()` 上报。
- 提供方健康来自 `api_keys` 状态（healthy/unknown/rate_limited/invalid/error）。

---

## 6. 路由追踪头部（每个响应都有）

| 头部 | 值 |
|--------|-------|
| `X-Request-ID` | UUID（或客户端 `x-request-id`） |
| `X-Routed-Via` | `platform/model` (safeHeaderValue) |
| `X-Fallback-Attempts` | 成功/耗尽前的失败跳数 |
| `X-Fallback-Trail` | `platform/model keyN=class; …`（最多 10，1KB） |
| `X-Fallback-Detail` | **可选**：`platform/model keyN=outcome t=start+dur msg=summary; …`（2KB） |
| `Retry-After` | 到最近冷却过期的秒数（429 耗尽） |
| `X-FreeLLM-Cache` | `HIT` / `MISS`（响应缓存） |
| `X-FreeLLM-Compress` | 压缩管线元数据 |

---

## 7. 仪表盘分析页

| 页 | 数据源 |
|------|-------------|
| **概览** | `request_aggregates` (24h/7d/30d/90d) |
| **模型** | 逐模型延迟、词元、成功率、成本节省 |
| **提供方** | 逐提供方细分 + 额度用量 |
| **密钥** | 逐密钥健康、用量、冷却、重校验历史 |
| **日志** | `server_logs` 环 + 持久化（按级别、提供方、搜索过滤） |
| **缓存** | 命中率、词元节省、LRU 统计 |

---

## 8. 关键函数 (server-logs.ts)

| 函数 | 用途 |
|----------|---------|
| `recordLogEntry(options)` | 单一入口（console 抽头、providerLog、启动预加载） |
| `recordConsoleLine(level, args)` | 被 log-redaction 包装器调 |
| `providerLog(level, message, meta)` | 结构化 + stdout 镜像 |
| `initServerLogs()` | 强制种子/预加载（首次轮询时路由调） |
| `queryLogs(query)` | 过滤、分页、游标式 |
| `levelCounts()` | 仪表盘徽章 |
| `currentMaxId()` | 游标上界 |
| `clearLogs()` | 清两层（ID 计数器保留） |
| `resetServerLogsForTest()` | 测试冷启动模拟 |

---

## 9. 关键函数 (request-log.ts)

| 函数 | 用途 |
|----------|---------|
| `logRequest(platform, modelId, keyId, status, inTokens, outTokens, latencyMs, error, ttfbMs, pinnedModelId)` | 插入请求行 |
| `persistRequestAttempts(requestId, attempts)` | 批量插入尝试轨迹 |
| `getRequestAnalytics(window)` | 仪表盘用的聚合卷起 |
| `getRequestAttempts(requestId)` | 逐请求钻取 |

---

## 10. 环境变量

| 变量 | 默认值 | 用途 |
|----------|---------|---------|
| `RESPONSE_CACHE` | `0` | 启用响应缓存（可选） |
| `REQUEST_MAX_TOKENS_BUDGET` | `0`（关） | 逐请求词元天花板 |
| `FALLBACK_TIME_BUDGET_MS` | `45000` | 重试预算（影响耗尽） |
| `MAX_CONSECUTIVE_UPSTREAM_FAILS` | `0`（关） | 断路器阈值 |
| `EXPOSE_FALLBACK_DETAIL_HEADER` | `0` | 可选 X-Fallback-Detail |
| `COOLDOWN_PROBE_DISABLED` | `0` | 探测任务熔断开关 |

---

## 11. 隐私与安全

- **日志无 PII**：请求体从不记。仅元数据（模型、平台、词元、延迟、脱敏错误）。
- **先脱敏**：Console 包装器在 `server-logs` 看到行前先脱敏。
- **单用户设计**：无多租户日志隔离需求。
- **本地优先**：除非操作员配置外部日志传输，日志永不出机器。

---

## 12. 表

```sql
-- 服务器日志（仅 warn/error，跨重启保留）
CREATE TABLE server_logs (
  id INTEGER PRIMARY KEY,
  level TEXT CHECK(level IN ('trace','debug','info','warn','error')),
  source TEXT, provider TEXT, model TEXT, event TEXT, request_id TEXT,
  message TEXT, created_at_ms INTEGER
);

-- 逐请求分析
CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  platform TEXT, model_id TEXT, key_id INTEGER,
  request_type TEXT, status TEXT,
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
  latency_ms INTEGER, ttfb_ms INTEGER,
  error TEXT, created_at_ms INTEGER,
  client_info TEXT, served_model TEXT, attempt_error_summary TEXT
);

-- 逐尝试轨迹
CREATE TABLE request_attempts (
  id INTEGER PRIMARY KEY,
  request_id INTEGER, attempt_ordinal INTEGER,
  platform TEXT, model_id TEXT, key_id INTEGER,
  error_class TEXT, error_summary TEXT,
  latency_ms INTEGER, ttfb_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  FOREIGN KEY(request_id) REFERENCES requests(id)
);

-- 物化聚合（定期刷新）
CREATE VIEW request_aggregates AS ...;
```