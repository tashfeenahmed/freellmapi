# Streaming Pipeline — Deep Dive

> **Source:** `server/src/routes/proxy.ts`, `server/src/routes/responses.ts`, `server/src/routes/anthropic.ts`, `server/src/lib/fallback-loop.ts`

## 1. Design Principles

- **SSE only** — zero WebSockets. Every surface (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, legacy `/completions`) streams via Server-Sent Events.
- **Turn integrity** — the stream is validated as a *turn*, not a transport. Headers are held until first real payload; anything dying before that fails over invisibly.
- **Failover mid-stream** — if an error frame arrives before headers flush, it's retryable; after flush, an error frame is surfaced honestly (stream_error).
- **Unified fallback loop** — all surfaces share `lib/fallback-loop.ts` for retry budget, cooldowns, attempt trail, exhaustion rendering.

---

## 2. OpenAI Chat Completions (`/v1/chat/completions`)

### Request Flow

```
parse + validate (zod)
  ├─ compression (optional, X-FreeLLM-Compress)
  ├─ system-prompt injection (profile-enforced)
  ├─ image downscale (normalizeMessageImages)
  ├─ token estimation (chars/4 heuristic)
  ├─ vision/tools gates (422 if no capable model)
  ├─ token budget guardrail (request_max_tokens_budget)
  ├─ response cache check (opt-in, exact-match LRU)
  ├─ sticky session / context handoff
  ├─ resolve routing chain (auto / pinned / group)
  └─ runFallbackLoop()
        ├─ route() → picks model+key
        ├─ dispatch() → streamChatCompletion()
        ├─ on success → recordUpstreamSuccess(), log, cache store
        ├─ on retryable failure → recordRetryableFailure(), cooldown, skipKeys, next
        ├─ on fatal → onFatal() (502)
        └─ on exhaustion → exhaustedRetryError() → onExhausted() (429/502/413/404/503)
```

### Streaming Pump (`proxy.ts` lines ~1873–2150)

**State machine per attempt:**

```
mode = 'undecided' | 'passthrough' | 'dialect'
heldText = ''
preamble = []          // role/keep-alive chunks held until mode decided
toolCallAcc = Map<index, {id, name, args}>
ttfbMs = null          // first token of ANY kind (content or reasoning)
headerSent = false
```

**Per chunk:**

1. **Metadata capture**: `upstreamModel` (first frame with `model` field), `lastMeta` (id/created/model for our framing).
2. **In-band error frame** (`{error:..., choices: undefined}`):
   - Before headers: throw → failover
   - After headers: write error frame + `[DONE]` → `committed`
3. **Usage frame**: captured wherever it lands (choice-less or on last choice), re-emitted once after our finish chunk.
4. **Reasoning accumulation** (#764): `streamReasoningText()` extracts `reasoning_content` / `reasoning`; added to `streamReasoning` for session memory + token accounting.
5. **Tool-call deltas**: buffered in `toolCallAcc`, arguments repaired against request schemas at end.
6. **Content text**: `streamChunkText()` extracts `delta.content`.
7. **TTFB** (#764): recorded on **first token of any kind** (content OR reasoning).
8. **Mode decision**:
   - `undecided` + `wantsTools` + `startsWithDialectMarker(heldText)` → `dialect` (buffer everything)
   - `undecided` + `!wantsTools` OR `!couldBecomeDialectMarker` OR `heldText > 256` → `passthrough`, flush headers, stream
   - `passthrough` → forward immediately (strip tool_calls from delta, re-emit complete at end)
   - `dialect` → keep buffering
9. **Empty chunks** (role/keep-alive/reasoning-only): held in `preamble` until flush.

**Stream end (clean):**

1. Assemble buffered tool calls → `repairToolArguments()` against request schemas.
2. If `dialect` mode: `rescueInlineToolCalls(heldText)` → structured `tool_calls` or failover.
3. Emit complete tool calls (single chunk, `finish_reason: 'tool_calls'`).
4. Emit final chunk (`finish_reason: 'stop' | 'length' | upstreamFinish`).
5. Emit captured usage frame.
6. `recordUpstreamSuccess()`, `logRequest()`, `observeServedModel()`, store in cache if applicable.

**Mid-stream error:**

- Before headers: throw → failover (next model)
- After headers: write `stream_error` frame + `[DONE]` → `committed` (loop stops, no further fallback)

### Token Accounting (Streaming)

- **Output tokens**: `ceil((text.length + reasoning.length) / 4)` per chunk — reasoning tokens are real consumption (#764).
- **TTFB**: wall-clock to first content OR reasoning token.
- **Non-stream reconciliation**: provider's `usage` block overrides estimates.

---

## 3. Anthropic Messages (`/v1/messages`)

### Translation Layer (`routes/anthropic.ts`)

| Anthropic | OpenAI (internal) |
|-----------|-------------------|
| `messages[]` (no system role) | `system` + `messages[]` |
| `tool_use` blocks in content | `tool_calls` array |
| `tool_result` blocks | `tool` messages |
| `stop_reason: 'tool_use'` | `finish_reason: 'tool_calls'` |
| `thinking` budget/type | `reasoning_effort` / `max_completion_tokens` |

**Streaming**: upstream OpenAI SSE → translated chunk-by-chunk to Anthropic SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`). Tool-use blocks are rendered as structured `tool_use` content blocks, not inline text.

### Error Mapping (exhaustion)

| FreeLLM kind | Anthropic type |
|--------------|----------------|
| `auth` | `api_error` |
| `bad_request` | `invalid_request_error` |
| `rate_limit` | `overloaded_error` (429) |
| `unavailable` | `overloaded_error` (503) |
| `context_too_large` | `request_too_large` |
| `model_not_found` | `not_found_error` |
| `upstream` | `api_error` |

---

## 4. Gemini (`/v1beta` via `/v1/chat/completions`)

### Request Translation (`providers/gemini.ts`)

- **Parts-based content**: `content: [{text:...}, {inline_data:...}, {function_call:...}]`
- **System prompt**: injected as first `user` turn with `role: 'user'` + `parts: [{text: system}]` then a `model` acknowledgement (Gemini requires alternating roles).
- **Tool calls**: `function_call` parts → OpenAI `tool_calls` on forward; `function_response` parts ← OpenAI `tool` messages.
- **Structured output**: `response_format: json_schema` → Gemini native `responseSchema` + `responseMimeType: 'application/json'`.
- **Thinking**: `thinking_config: {thinking_budget: N}` from `reasoning_effort` / `max_completion_tokens`.

### Streaming

- Native Gemini SSE → normalized to OpenAI chunk shape in `base.ts` `streamChatCompletion()`.
- Inline tool-call dialect (`function_call` in text) rescued by same dialect detector.
- `thought_signature` preserved on tool calls (#13).

---

## 5. Responses API Shim (`/v1/responses`)

> **Source:** `server/src/routes/responses.ts`

### Purpose

Codex CLI and Agents SDK speak the **Responses API** (stateful, `previous_response_id` chaining). The shim translates to/from chat completions so the same router/quota/failover machinery serves both.

### Translation

| Responses API | Chat Completions |
|---------------|------------------|
| `input` (string or array) | `messages[]` |
| `previous_response_id` | sticky session (sessionId = response_id) |
| `tools` (function + `type: 'function'`) | `tools` + `tool_choice` |
| `text.format` (json_schema) | `response_format: json_schema` |
| `reasoning` (effort/summary) | `reasoning_effort` + `max_completion_tokens` |
| `stream: true` | SSE with `_fusion`-style additive frames for tool calls |

### Streaming

- Opens SSE immediately.
- Tool calls emitted as additive `_fusion` frames (no `choices`, standard clients skip) → final answer streamed as normal content deltas.
- `response.output_text` convenience field on final non-stream response.

### Failover

- Shares `runFallbackLoop()` — identical retry budget, cooldowns, attempt trail.
- Exhaustion rendering maps to Responses API error shape.

---

## 6. Legacy Completions (`/v1/completions`)

Thin adapter over shared fallback loop:

- `prompt` + `suffix` → chat messages (system: "code autocomplete engine", user: prefix/suffix).
- Response: `text_completion` shape (choices[0].text).
- Streaming: `legacyCompletionChunk()` wraps upstream chunks.
- Same commit-point logic: headers held until first text; reasoning tokens counted (#764).

---

## 7. Fusion Virtual Model (`model: "fusion"`)

> **Source:** `server/src/services/fusion.ts`

- Fans prompt to **panel of diverse models** in parallel (vision/tools filtered per member).
- **Judge model** synthesizes one answer.
- Each sub-call routes through **normal path** (cooldowns, quotas, analytics).
- Streaming: additive `_fusion` frames for panel/judge events, then judge's synthesis as normal content deltas.
- Non-stream: structured-output enforcement on judge output (#516).
- Failover: panel members fail over within their own chains; judge failure → fallback to best-of panel.

---

## 8. Error Handling Mid-Stream

| Scenario | Before Headers | After Headers |
|----------|----------------|---------------|
| In-band `{error}` frame | Throw → failover | Write error frame + `[DONE]` → `committed` |
| Client disconnect | `clientGone` → abort in-flight, no bench | `clientGone` → stop pulling, `committed` |
| Hedge abort (budget expiry) | `abortInFlight()` → `HedgeAbortError` → loop stops, `timedOut` exhaustion | Same |
| Empty completion (no text, no tools) | Throw `empty completion` → failover | N/A (would have flushed) |
| Upstream classification output ("safe"/"unsafe") | Throw → failover (a961d93) | N/A |
| Tool dialect detected | Buffer → rescue at end or failover | N/A |

---

## 9. Headers Emitted on Every Response

| Header | Value |
|--------|-------|
| `X-Request-ID` | UUID (or `x-request-id` from client) |
| `X-Routed-Via` | `platform/model` (safeHeaderValue) |
| `X-Fallback-Attempts` | Failed hops before this response |
| `X-Fallback-Trail` | `platform/model keyN=class; …` (max 10) |
| `X-Fallback-Detail` | **Opt-in**: `platform/model keyN=outcome t=start+durationMs msg=summary; …` |
| `Retry-After` | Seconds until soonest cooldown expiry (429 exhaustions) |
| `X-FreeLLM-Cache` | `HIT` / `MISS` (response cache) |
| `X-FreeLLM-Compress` | Compression pipeline metadata |

---

## 10. Key Functions (proxy.ts)

| Function | Purpose |
|----------|---------|
| `runFallbackLoop(hooks)` | Shared attempt loop (see 04-degraded-mode) |
| `streamChunkText(chunk)` | Extract `delta.content` (tolerates no-choices frames) |
| `streamReasoningText(chunk)` | Extract `delta.reasoning_content` / `delta.reasoning` |
| `restoreSessionReasoning(messages, reasoning, platform)` | #797: replay thinking trace stripped by client |
| `rememberReasoning(sessionKey, modelKey, reasoning)` | Store per-session trace |
| `rescueInlineToolCalls(text, tools)` | Convert inline dialect → structured `tool_calls` |
| `repairToolArguments(args, schemas)` | Fix double-encoded JSON against request schemas |
| `truncateMessagesForGithub(messages)` | Trim history to GitHub Models input ceiling |
| `normalizeOutboundContent(chunk)` | Provider-specific response normalization |
| `sanitizeResponse(chunk)` | Redact secrets from streamed frames |

---

## 11. Concurrency & Cancellation

- **Client disconnect**: `res.on('close')` → `clientGone = true`, `clientAbort.abort()` → in-flight fetch canceled, lease released immediately.
- **Hedging** (1d2226a): `hedgeAbort` controller, `abortInFlight()` called when wall-clock budget expires mid-attempt. `HedgeAbortError` is **non-provider-health** → no cooldown/penalty, renders `timedOut` exhaustion.
- **Lease release**: in `finally` block of `dispatch()`, idempotent. Optional on `RouteResult` so a `TypeError` in `finally` cannot replace the upstream error.

---

## 12. Compression Pipeline (Opt-In)

`X-FreeLLM-Compress` header → `compressRequest(messages, {header, tools, cacheControlPrefixLength})` → returns compressed messages + cache key. Engines: `lite`, `jsoncompact`, `dedup`, `aging`, `relevance`, `hard-budget`, `filter-definitions`, `custom-filters`, `toolfilter`, `read-lifecycle`. Cache key includes `compression.cacheKey` so different compression levels never collide.

---

## 13. Response Cache (Opt-In)

- **Scope**: non-streaming only, cacheable temperature (`temperature ≤ 1` or unset), `X-FreeLLM-Cache: on` or `RESPONSE_CACHE=1`.
- **Key**: SHA-256 over canonical request (model, messages, all sampling params, tools, stop, response_format, n, seed, penalties, logit_bias, logprobs, top_logprobs, reasoning_effort, compression).
- **Store**: in-memory LRU, TTL + temperature gates.
- **Hit**: returns cached body, `X-Routed-Via: cache`, `X-FreeLLM-Cache: HIT`, **zero provider quota consumed**.