[English](../../en/api/02-idempotency.md) · **简体中文**

# Idempotency-Key —— 非流式聊天补全的安全重试

> **来源：** `server/src/services/idempotency.ts`、`server/src/routes/proxy.ts:1793-1835`（入口）+ `2640-2656`（持久化）、`server/src/db/migrations/20260901_000001_idempotency_claims.ts`、提交 `36b877d`（功能）、`95bc46f`（在途请求说明），环境变量 `IDEMPOTENCY_TTL_MS` 记录在 `docs/en/env/01-variables.md#idempotency`。

非流式的 `POST /v1/chat/completions` 支持可选的 `Idempotency-Key` 请求头：客户端超时后重试时，不会为一个已经收到过的答案再消耗一次免费额度。在重放窗口内再次看到相同的键与相同的请求内容时，网关以**零提供方成本**重放已存储的响应；相同的键配上不同的内容则返回 `409`，而不是悄悄给出错误答案。

---

## 1. 请求头

在**非流式**请求上发送 `Idempotency-Key`（大小写不敏感 —— Express 会转为小写的 `idempotency-key`）：

```
Idempotency-Key: <opaque client token>
```

规范化（`server/src/services/idempotency.ts:176-182` 中的 `normalizeIdempotencyKey`）：

- 去掉首尾空白；去掉后为空 → 忽略（不启用幂等）。
- 必须 `≤ 255` 个 UTF-8 字节（`Buffer.byteLength(..., 'utf8')`）；更长 → 忽略。
- 若请求头重复出现，以**第一个**值为准（`Array.isArray(raw) ? raw[0] : raw`），与 Express 的多值处理一致。

只存储键的 `SHA-256` 十六进制摘要（`hashIdempotencyKey`）—— 原始键永远不会进入 SQLite，与管理令牌、运行时令牌的处理方式相同。

流式请求（`stream: true`）**始终绕过**幂等（`proxy.ts:1805` 中的 `const idemKey = !stream ? normalize... : null`）。一个流无法作为整体重放，而打开的连接本身就是重试信号 —— 与响应缓存的策略相同。

---

## 2. 状态 —— `miss` / `replay` / `409 conflict`

`server/src/services/idempotency.ts:91-119` 中的 `lookupIdempotencyReplay(keyHash, fingerprint)` 在 `idempotency_claims` 表中查询同一 `key_hash` 的**未过期**行，并比较其存储的 `request_fingerprint`：

| 结果 | 条件 | 网关行为 |
|--------|-----------|-----------------|
| `miss` | 没有满足 `WHERE key_hash = ? AND expires_at_ms > now` 的行，或存储的正文已损坏，或数据库不可用 | 正常继续；若上游随后以 `finish_reason !== 'length'` 成功，则持久化结果供后续重放。 |
| `replay` | 行存在**且** `request_fingerprint` 匹配 | `X-Routed-Via: idempotency`，原样重放存储的 `response_status` + `response_body`。**不消耗任何提供方额度** —— 与响应缓存 `HIT` 的零成本理由相同，因此跳过请求与用量记账。 |
| `conflict` | 行存在但指纹不同 | `409` 并返回 `idempotency_key_conflict`（见 §7）—— 调用方用同一个键发送了不同内容。 |

过期的行按 `miss` 处理；同一键的一次新的成功补全会**替换**之前的记录（`storeIdempotencyResult` 中的 `INSERT ... ON CONFLICT(key_hash) DO UPDATE`）。

数据库故障降级为 `miss` —— 幂等是尽力而为，绝不让热路径失败（与 `services/cache.ts` 一致）。

---

## 3. 仅限非流式

- **仅**适用于 `stream` 为假值的 `POST /v1/chat/completions`。流式、`/v1/responses`、`/v1/messages`（Anthropic）、`/v1/completions`、`/v1/embeddings` 以及媒体端点均不覆盖。
- 被截断的回合（`finish_reason === 'length'`）**不会存储**也不会重放 —— 重放一个被截断的答案比重新生成更糟。这与响应缓存的策略一致（`proxy.ts:2644-2648` 检查 `result.choices?.[0]?.finish_reason !== 'length'`）。

---

## 4. 指纹的构成

`computeIdempotencyFingerprint`（`server/src/services/idempotency.ts:51-70`）对下列字段的 JSON 序列化结果计算规范化的 `SHA-256`，且只包含这些字段：

```typescript
{
  model:       input.model ?? null,
  messages:    input.messages,
  temperature: input.temperature ?? null,
  top_p:       input.top_p ?? null,
  max_tokens:  input.max_tokens ?? null,
  tools:       input.tools ?? null,
  tool_choice: input.tool_choice ?? null,
}
```

`model` 原样取自客户端的 `model` 字段（例如 `auto`、`auto:fast`、`gemini-2.5-flash`）；`messages` 是经过 `developer`→`system` 规范化后的完整 OpenAI 形态数组。`tools`/`tool_choice` 包含其 schema，因此改变了工具绑定的重试会正确地产生冲突。

取默认值的采样参数会被规范化（缺省时为 `null`），所以 `top_p: 1` 与省略 `top_p` 不会为同一个逻辑请求产生两个指纹 —— 与缓存键 `v4` 一致。

---

## 5. 在途请求**不会**去重（95bc46f）

在原请求仍在执行时到达的重复请求**不会被合并**：

> 只有**已完成**的响应才可被记录。若两个请求以相同的键与指纹竞争，两者都会执行到底；第二次 `storeIdempotencyResult` 会替换第一次。之后第三个重复该键的请求将重放胜出者。

要守住在途窗口，需要一个带有自身短 TTL 的 `pending` 记录状态，以免崩溃把一个键卡住 24 小时。这被**有意排除在范围之外**（提交 `95bc46f`，`server/src/services/idempotency.ts:17-20`）。需要更强去重的调用方，应等到第一个请求返回或客户端自己的超时触发后再重试。

---

## 6. TTL —— `IDEMPOTENCY_TTL_MS`

| 变量 | 默认值 | 含义 |
|----------|---------|---------|
| `IDEMPOTENCY_TTL_MS` | `86400000`（24 小时） | 已完成记录的重放窗口 |

- 通过 `idempotencyTtlMs()` → `envNum('IDEMPOTENCY_TTL_MS', 24*60*60*1000)` **每次调用时**读取，便于测试实时切换；非有限值或负数 → 回退到默认值。
- `expires_at_ms = now + ttl`；过期行在下一次 `storeIdempotencyResult` 时**按 `key_hash`** 惰性清理（`DELETE ... WHERE key_hash = ? AND expires_at_ms <= ?`），范围扫描则借助 `idx_idempotency_claims_expires` 索引。
- 权威来源：`server/src/services/idempotency.ts:40-42`、`docs/en/env/01-variables.md#idempotency`。

---

## 7. 409 处理 —— `idempotency_key_conflict`

用同一个键重发**不同**的 `model`/`messages`/采样参数/`tools` 会得到 `409 Conflict`（在调用任何提供方之前）：

```json
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "message": "idempotency_key_conflict",
    "type": "invalid_request_error"
  }
}
```

客户端的恢复方式：

1. 为真正的新内容生成一个**新的** `Idempotency-Key`，或
2. 逐字节重发**原始**请求体以获得重放。

`409` 不消耗任何提供方额度 —— 它直接由查询返回（`proxy.ts:1827-1835`）。把它当作程序错误处理，而不是可重试的状态码。

---

## 8. curl 示例 —— 超时、重试、重放

```bash
# 1. First attempt — times out on the client side, but the gateway
#    finishes and stores the response under the key hash.
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f3a-2026-09-02-retry-1" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Summarise the fall of Rome in one sentence."}]
  }' --max-time 10 || echo "client timed out"

# 2. Retry with the SAME key + SAME body → replay, zero provider cost
curl -i http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f3a-2026-09-02-retry-1" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Summarise the fall of Rome in one sentence."}]
  }'
# Response headers include: X-Routed-Via: idempotency
# Body is the exact JSON from the first success, including usage/model fields.

# 3. Same key with DIFFERENT content → 409
curl -i http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f3a-2026-09-02-retry-1" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Different question"}]
  }'
# → 409 {"error":{"message":"idempotency_key_conflict","type":"invalid_request_error"}}
```

提示：

- 每个逻辑操作使用一个 **UUID v4** 或 KSUID；不要在不相关的调用之间复用键。
- 超时正是预期的使用场景 —— 把客户端超时设得比网关的提供方预算短，重试才真的会触发。
- 重放可通过 `X-Routed-Via: idempotency` 识别（正常命中是 `X-Routed-Via: <platform>/<model>`）；缓存命中则是 `X-FreeLLM-Cache: HIT`。

---

## 9. 存储与成本模型

| 方面 | 细节 |
|--------|--------|
| 表 | `idempotency_claims`（`id`、`key_hash UNIQUE`、`request_fingerprint`、`response_status`、`response_body TEXT`、`execution_id`、`created_at_ms`、`expires_at_ms`）—— 迁移 `20260901_000001_idempotency_claims.ts` |
| 索引 | `idx_idempotency_claims_expires ON expires_at_ms` |
| 成本 | 重放 = **零提供方密钥/额度**，不产生 `requests`/`request_attempts` 行，与缓存 `HIT` 相同 |
| 作用域 | 按调用方的键（键由调用方控制），不同于响应缓存对请求内容做全局精确匹配 |
| 语义 | 每个 `key_hash` 一行；新的成功补全会**替换**旧的（指纹与正文一并覆盖） |

---

## 10. 与响应缓存及降级模式的关系

- **响应缓存**（`services/cache.ts`，`X-FreeLLM-Cache`）是正交的：全局、受温度门控、内存 LRU；幂等则是持久化的（SQLite）、按调用方、与指纹绑定。两者都会绕过提供方调用。
- **降级模式**（`../architecture/04-degraded-mode-and-failover.md`）会关闭老虎机探索，但不影响幂等 —— 重放仍然完全绕过路由。
- **故障转移**：只存储最终成功的正文。若一个请求耗尽了回退循环，该键不会存储任何内容。

---

## 相关

- `docs/en/env/01-variables.md#idempotency` —— `IDEMPOTENCY_TTL_MS` 的默认值与边界。
- [`../architecture/04-degraded-mode-and-failover.md`](../architecture/04-degraded-mode-and-failover.md) —— `miss` 进入循环后适用的重试预算、对冲和回退响应头。
- [`01-rest-api.md`](01-rest-api.md) —— 兼容 OpenAI 的接口（`/v1/chat/completions`）与响应头（`X-Routed-Via`、`X-Fallback-Detail`）。
