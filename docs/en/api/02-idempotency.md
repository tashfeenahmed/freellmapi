# Idempotency-Key — Safe Retries for Non-Streaming Chat Completions

> **Sources:** `server/src/services/idempotency.ts`, `server/src/routes/proxy.ts:1793-1835` (entry) + `2640-2656` (persist), `server/src/db/migrations/20260901_000001_idempotency_claims.ts`, commit `36b877d` (feature), `95bc46f` (in-flight clarification), env `IDEMPOTENCY_TTL_MS` documented in `docs/env/01-variables.md#idempotency`.

Non-streaming `POST /v1/chat/completions` supports an opt-in `Idempotency-Key` header so a client that times out and retries does not burn a second free-tier slot for an answer it already received. When the same key + same request content is seen again inside the replay window the gateway replays the stored response at **zero provider cost**; the same key with different content is a `409` rather than a silent wrong answer.

---

## 1. Header

Send `Idempotency-Key` (case-insensitive — Express lower-cases to `idempotency-key`) on a **non-streaming** request:

```
Idempotency-Key: <opaque client token>
```

Normalization (`normalizeIdempotencyKey` in `server/src/services/idempotency.ts:176-182`):

- Trim surrounding whitespace; empty after trim → ignored (no idempotency).
- Must be `≤ 255` UTF-8 bytes (`Buffer.byteLength(..., 'utf8')`); longer → ignored.
- If the header is repeated, the **first** value wins (`Array.isArray(raw) ? raw[0] : raw`), matching Express multi-value handling.

Only a `SHA-256 hex` of the key is stored (`hashIdempotencyKey`) — the raw key never touches SQLite, mirroring how admin/runtime tokens are handled.

Streaming requests (`stream: true`) **always bypass** idempotency (`const idemKey = !stream ? normalize... : null` in `proxy.ts:1805`). A stream cannot be replayed as a unit and the open connection is itself the retry signal — same policy as the response cache.

---

## 2. States — `miss` / `replay` / `409 conflict`

`lookupIdempotencyReplay(keyHash, fingerprint)` in `server/src/services/idempotency.ts:91-119` queries the `idempotency_claims` table for an **unexpired** row with the same `key_hash` and compares its stored `request_fingerprint`:

| Result | Condition | Gateway behavior |
|--------|-----------|-----------------|
| `miss` | No row `WHERE key_hash = ? AND expires_at_ms > now`, or corrupt stored body, or DB unavailable | Proceed normally; if the upstream later succeeds with `finish_reason !== 'length'`, persist the result for future replays. |
| `replay` | Row exists **and** `request_fingerprint` matches | `X-Routed-Via: idempotency`, replay stored `response_status` + `response_body` verbatim. **No provider quota is consumed** — same zero-cost rationale as a `HIT` from the response cache, so request/usage bookkeeping is skipped. |
| `conflict` | Row exists but fingerprints differ | `409` with `idempotency_key_conflict` (see §6) — the caller reused a key with different content. |

Expired rows are treated as `miss`; a new successful completion with the same key **replaces** the previous claim (`INSERT ... ON CONFLICT(key_hash) DO UPDATE` in `storeIdempotencyResult`).

DB failures degrade to `miss` — idempotency is best-effort and never fails the hot path (mirrors `services/cache.ts`).

---

## 3. Non-streaming only

- Applies **only** to `POST /v1/chat/completions` with `stream` falsy. Streaming, `/v1/responses`, `/v1/messages` (Anthropic), `/v1/completions`, `/v1/embeddings`, and media endpoints are not covered.
- A truncated turn (`finish_reason === 'length'`) is **not stored** and not replayed — replaying a cut-off answer would be worse than regenerating. This matches the response-cache policy (`proxy.ts:2644-2648` guards `result.choices?.[0]?.finish_reason !== 'length'`).

---

## 4. Fingerprint composition

`computeIdempotencyFingerprint` (`server/src/services/idempotency.ts:51-70`) builds a canonical `SHA-256` over the JSON serialization of exactly these fields:

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

`model` comes from the client's `model` field as-is (e.g. `auto`, `auto:fast`, `gemini-2.5-flash`); `messages` is the full OpenAI-shaped array after `developer`→`system` normalization. `tools`/`tool_choice` include their schemas so a retry that changes a tool binding correctly conflicts.

Default-valued sampling params are canonicalized (`null` when absent) so `top_p: 1` and omitting `top_p` do not create two fingerprints for the same logical request — consistent with cache key `v4`.

---

## 5. In-flight requests are NOT deduplicated (95bc46f)

A duplicate that arrives while the original is still running is **not coalesced**:

> Only **completed** responses are claimable. If two requests race with the same key + fingerprint, both execute to completion; the second `storeIdempotencyResult` replaces the first. A third request that then repeats the key will replay the winner.

Guarding the in-flight window would require a `pending`-claim state with its own short TTL so a crash cannot wedge a key for 24 h. That is **deliberately out of scope** (commit `95bc46f`, `server/src/services/idempotency.ts:17-20`). Callers that need stronger dedup should hold off retrying until the first request either returns or the client's own timeout fires.

---

## 6. TTL — `IDEMPOTENCY_TTL_MS`

| Variable | Default | Meaning |
|----------|---------|---------|
| `IDEMPOTENCY_TTL_MS` | `86400000` (24 h) | Replay window for completed claims |

- Read **per call** via `idempotencyTtlMs()` → `envNum('IDEMPOTENCY_TTL_MS', 24*60*60*1000)` so tests can flip it live; non-finite / negative → fallback.
- `expires_at_ms = now + ttl`; stale rows are lazily swept **per `key_hash`** at the next `storeIdempotencyResult` (`DELETE ... WHERE key_hash = ? AND expires_at_ms <= ?`) and via the `idx_idempotency_claims_expires` index for range scans.
- Source of truth: `server/src/services/idempotency.ts:40-42`, `docs/env/01-variables.md#idempotency`.

---

## 7. 409 handling — `idempotency_key_conflict`

Reusing a key with **different** `model`/`messages`/sampling/`tools` is a `409 Conflict` (before any provider is called):

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

Client recovery:

1. Generate a **new** `Idempotency-Key` for genuinely new content, or
2. Resend the **original** body byte-for-byte to get the replay.

No provider quota is spent on the `409` — it is returned directly from the lookup (`proxy.ts:1827-1835`). Treat it as a programmer error, not a retryable status.

---

## 8. Curl example — timeout, retry, replay

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

Tips:

- Use a **UUID v4** or KSUID per logical operation; do not reuse keys across unrelated calls.
- Timeouts are the expected use case — set the client timeout shorter than the gateway's provider budget so retries actually fire.
- A replay can be distinguished by `X-Routed-Via: idempotency` (normal hits use `X-Routed-Via: <platform>/<model>`); cache hits use `X-FreeLLM-Cache: HIT`.

---

## 9. Storage & cost model

| Aspect | Detail |
|--------|--------|
| Table | `idempotency_claims` (`id`, `key_hash UNIQUE`, `request_fingerprint`, `response_status`, `response_body TEXT`, `execution_id`, `created_at_ms`, `expires_at_ms`) — migration `20260901_000001_idempotency_claims.ts` |
| Index | `idx_idempotency_claims_expires ON expires_at_ms` |
| Cost | Replay = **zero provider keys/quota**, no `requests`/`request_attempts` rows, same as cache `HIT` |
| Scoping | Per-caller key (caller controls the key), unlike the response cache which is global exact-match on request content |
| Semantics | One row per `key_hash`; a new successful completion **replaces** the old one (fingerprint + body overwritten) |

---

## 10. Relationship to response cache & degraded mode

- **Response cache** (`services/cache.ts`, `X-FreeLLM-Cache`) is orthogonal: global, temperature-gated, in-memory LRU; idempotency is durable (SQLite), per-caller, and fingerprint-bound. Both short-circuit provider calls.
- **Degraded mode** (`docs/architecture/04-degraded-mode-and-failover.md`) disables bandit exploration but does not affect idempotency — replays still bypass routing entirely.
- **Failover**: only the final successful body is stored. If a request exhausts the fallback loop, nothing is stored for that key.

---

## Related

- `docs/env/01-variables.md#idempotency` — `IDEMPOTENCY_TTL_MS` defaults and bounds.
- `docs/architecture/04-degraded-mode-and-failover.md` — retry budget, hedging, and fallback headers that apply when a `miss` enters the loop.
- `01-rest-api.md` — OpenAI-compatible surface (`/v1/chat/completions`) and response headers (`X-Routed-Via`, `X-Fallback-Detail`).
