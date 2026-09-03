# Degraded Mode & Failover — Deep Dive

> **Source:** `server/src/services/degradation.ts`, `server/src/lib/fallback-loop.ts`, `server/src/routes/proxy.ts`, `server/src/services/ratelimit.ts`

## 1. Degraded-Mode State Machine (f412e97)

### Purpose

When a large share of enabled providers fails simultaneously, per-request probing and bandit exploration just burn retry budget on dead routes. The degraded-mode state machine tracks the **healthy-provider ratio** (driven by the scheduled health pass) and flips the gateway into a degraded state once the ratio stays below a threshold for a sustained period.

### State Machine

```
┌─────────────┐     ratio < threshold for DEGRADED_ENTRY_GRACE_MS     ┌─────────────┐
│   normal    │ ─────────────────────────────────────────────────────▶ │  degraded   │
└─────────────┘                                                       └─────────────┘
      ▲                                                                     │
      │     ratio ≥ threshold for DEGRADED_EXIT_GRACE_MS                  │
      └────────────────────────────────────────────────────────────────────┘
```

### Parameters (env-tunable)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DEGRADED_HEALTHY_RATIO` | 0.5 | Fraction of providers that must have ≥1 usable key |
| `DEGRADED_MIN_PROVIDERS` | 3 | Min enabled providers for evaluation (single-provider deployments don't flap) |
| `DEGRADED_ENTRY_GRACE_MS` | 60,000 | Time below threshold before entering degraded |
| `DEGRADED_EXIT_GRACE_MS` | 120,000 | Time above threshold before exiting (longer = hysteresis) |

### Health Snapshot

```typescript
interface HealthSnapshot {
  healthyProviders: number  // enabled providers with ≥1 key in {healthy, unknown}
  totalProviders: number    // enabled providers with ≥1 key (any status)
  ratio: number             // healthy / total (1 if total=0)
}
```

- `unknown` counts as healthy (unprobed key = usable until probe says otherwise).
- Computed from `api_keys` table on every health pass + on demand (dashboard, router entry).

### Behavioral Changes in Degraded Mode

| Aspect | Normal | Degraded |
|--------|--------|----------|
| Bandit exploration | 10% floor (if enabled) | **Disabled** — sticks to scored order of remaining healthy providers |
| Router | `isDegraded()` checked at route time | Same |
| Health endpoint | Reports `state: 'normal'` | Reports `state: 'degraded', degradedAt: timestamp` |
| Logging | — | `console.warn` on entry, `console.log` on exit |

### API

```typescript
isDegraded(): boolean                    // read-only, used by router
getDegradationStatus(): DegradationStatus // {healthyProviders, totalProviders, ratio, state, degradedAt}
updateDegradationState(now?): DegradationStatus // call after every health pass
resetDegradationState()                  // tests, post-start re-probe
```

---

## 2. Retry Budget & Hedging (1d2226a)

### Wall-Clock Retry Budget

- **Default**: 45 s (`FALLBACK_TIME_BUDGET_MS`, setting `fallback_time_budget_ms`, 0 = disabled).
- **Checked BEFORE starting each retry** (attempt ≥ 1). Attempt 0 always runs; attempt 1 always runs (so failover is structurally possible even when attempt 0 consumes the whole budget).
- **Exhaustion rendering**: `timedOut: true` + `budgetMs` in `ExhaustionContext` → message includes "stopped early: retry time budget 45s exceeded — one failover hop is always allowed, and past that the budget stops starting further retries and cancels an attempt still waiting on its first byte".

### Hedging (Abort In-Flight)

> Pre-v2: budget only refused to *start* the next retry. A stalled attempt could run for minutes, blocking the chain.
>
> **v2 (1d2226a)**: When budget expires mid-attempt, `abortInFlight()` cancels the upstream fetch via `AbortController` (threaded as `CompletionOptions.signal`).

```typescript
// In fallback-loop.ts
abortInFlight: () => hedgeAbort.abort(newHedgeAbortError())
```

- `HedgeAbortError` is **non-provider-health** → no cooldown, no penalty, no limit learning.
- Renders `timedOut` exhaustion (not a provider failure).
- Streaming surfaces call `ctx.disarmHedge()` on first byte / header flush — past that point the answer is on its way, killing it would truncate a healthy response for no failover benefit.

### Circuit Breaker Guardrail

- `max_consecutive_upstream_fails` (setting `max_consecutive_upstream_fails`, default 0 = disabled).
- Counts consecutive retryable upstream failures across the attempt loop.
- Trips → `breakerFails` in `ExhaustionContext` → **503 service_unavailable** with "upstream_unhealthy" code.
- "The enabled pool looks unhealthy right now, so the remaining candidates were skipped instead of burning quota on them."

---

## 3. X-Fallback-Detail Header (8cb75ac)

### Purpose

`X-Fallback-Trail` tells **which hops burned and why**. `X-Fallback-Detail` adds **how long they cost** — the part an agent cannot reconstruct (a 40s response: one provider stalled 39s vs four failed fast).

### Format

```
X-Fallback-Detail: platform/model keyN=outcome t=startOffset+durationMs msg=summary; +N more
```

- **Per-hop timings** + redacted provider message.
- **Opt-in**: `EXPOSE_FALLBACK_DETAIL_HEADER=1` or setting `expose_fallback_detail_header`.
- **Budget**: 2048 chars total, 120 chars per message summary, max 10 hops shown.
- **Only failed hops**: the currently-serving hop isn't knowable while headers are open (recorded after dispatch returns).

### Example

```
X-Fallback-Detail: google/gemini-2.5-pro key1=rate_limited t=0+1205ms msg=429 Quota exceeded; groq/llama-3.3-70b key2=upstream_error t=1205+3450ms msg=503 Service unavailable; +1 more
```

### Implementation

```typescript
// fallback-loop.ts
formatAttemptDetail(records: AttemptTraceRecord[]): string
// AttemptTraceRecord: {platform, modelId, keyOrdinal, outcome, startOffsetMs, durationMs, errorSummary}

// Set on response (before flush):
if (isFallbackDetailHeaderEnabled() && records?.length) {
  res.setHeader('X-Fallback-Detail', safeHeaderValue(formatAttemptDetail(records), 2048));
}
```

---

## 4. Bare Safe/Unsafe Classification Failover (a961d93)

### Problem

Some relay models (e.g. OpenCode Zen) emit a bare `"safe"` or `"unsafe"` classification word as the **entire completion** instead of the requested answer. This is an upstream content filter, not the model's output.

### Fix

```typescript
// proxy.ts, after non-stream completion:
const text = completionTextFromChat(result);
if (!text) { throw empty completion... }

// #809: fail over on relay's bare classification output
if (isUpstreamClassificationOutput(text, route.platform)) {
  throw Object.assign(
    new Error(`empty completion from ${route.displayName} (upstream classification output)`),
    result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
  );
}
```

- `isUpstreamClassificationOutput(text, platform)` checks for exact `"safe"` / `"unsafe"` (case-insensitive, trimmed) on known relay platforms.
- Treated like an empty completion: **fail over**, `skipBench: true` when `finish_reason === 'length'` (reasoning consumed budget).
- Streaming path: same check on accumulated text at stream end.

---

## 5. Unified Fallback Loop (`lib/fallback-loop.ts`)

### Shared by All Surfaces

| Surface | Route | Dispatch |
|---------|-------|----------|
| `/v1/chat/completions` | `proxy.ts` | SSE streaming + non-stream |
| `/v1/responses` | `responses.ts` | Responses API framing |
| `/v1/messages` | `anthropic.ts` | Anthropic SSE events |
| `/v1/completions` | `proxy.ts` | Legacy text_completion SSE |

### Loop Contract

```typescript
interface FallbackHooks {
  maxRetries?: number;              // default 20
  timeBudgetMs?: number;            // default getFallbackTimeBudgetMs()
  breakerLimit?: number;            // default getMaxConsecutiveUpstreamFails()
  attemptLog?: AttemptRecord[];     // mutated, used for X-Fallback-Trail
  state: FallbackState;             // skipKeys, skipModels, skipPlatforms
  clientGone?: () => boolean;       // checked before each retry
  abortInFlight?: () => void;       // hedging (v2)
  route(attempt): RouteResult;      // throws RouteError on synchronous exhaustion
  dispatch(route, attempt, ctx): Promise<'done' | 'committed'>;
  logFailure(route, err, attempt): void;
  onFatal(route, err, attempt): void;           // non-retryable → 502
  onRoutingExhausted(lastError, routeErr, exhaustion, info): void; // zero attempts
  onExhausted(exhaustion, info): void;          // retries exhausted
}
```

### Attempt Classification (recordRetryableFailure)

| Error | Skip Scope | Cooldown | Model Penalty | Limit Learn |
|-------|------------|----------|---------------|-------------|
| 401 invalid key | key | 5 min | no | no |
| 402 payment required | key | 24h | no | no |
| 403 model forbidden | **model** | 24h | no | no |
| 429 daily exhausted | model+key | until midnight / Retry-After | **heavy (3)** | yes |
| 429 transient (rpm/tpm) | key | 90s / ladder | light (1) | yes |
| 5xx / timeout / transport | **platform** (#788) | 90s / ladder | light (1) | no |
| empty completion (reasoning) | key | exempt (streak ≤3) | no | no |
| context too large | model | — | no | no |
| response_format ignored | model | — | no | no |
| invalid tool arguments | key | — | no | no |

### Model-Level Failure Benching (#806)

- 3 retryable failures across keys within 15 min → bench model on **all its keys** for 10 min (heuristic, probe-eligible).
- A served request clears the failure window.

### Empty-Completion Streak Limit (#751)

- 3 consecutive reasoning-truncated completions on same model+key → exemption lifts → normal cooldown/penalty/limit-learning applies.
- Reset on success or normally-penalized failure.

### Provider-Level Skip (#788)

- 5xx / timeout / transport / degraded → `skipPlatforms.add(platform)`.
- Whole provider ruled out for this request — loop moves to next provider instead of burning one hop per key.

### Exhaustion Rendering (exhaustedRetryError)

**Most-specific-first aggregation over attempt classes:**

1. **All auth** → 502 `provider_error` (`provider_authentication_failed`) — distinct from rate-limit, never blames client key.
2. **All context_too_large** → 413 `invalid_request_error` (`context_length_exceeded`).
3. **All model_not_found** → 404 `invalid_request_error` (`model_not_found`).
4. **Last error = degraded 400** (NVIDIA NIM) → 503 `service_unavailable` (`provider_degraded`).
5. **Last error = provider bad request** → 400 `invalid_request_error` (`provider_rejected_request`).
6. **Circuit breaker** → 503 `service_unavailable` (`upstream_unhealthy`).
7. **All UNAVAILABLE_UNTIL_KNOWN_TIME** (rate_limited, daily_quota_exhausted, out_of_credits, forbidden) → 429 `rate_limit_error` with `retryAtMs` + `Retry-After`.
8. **Mixed/other** → 502 `provider_error` (`upstream_failed`) — never 500 (our bugs).

**Synchronous exhaustion (zero attempts):** `routingExhaustionBody(routeErr)` maps diagnostics to same taxonomy:
- All config (no key, no provider) → 503 `no_providers_configured`
- All too_large (+ config) → 413 `context_length_exceeded`
- Some time_bound, rest config/too_large → 429 with `retryAtMs`
- Else → 429 `routing_exhausted`

---

## 6. Attempt Trail & Headers

### X-Fallback-Attempts

Count of failed hops before this response (on success AND exhaustion).

### X-Fallback-Trail

```
platform/model key1=class; platform/model key2=class; +N more
```

- `class` ∈ `AttemptErrorClass` (auth, out_of_credits, daily_quota_exhausted, model_not_found, forbidden, context_too_large, provider_bad_request, empty_completion, format_ignored, invalid_tool_arguments, timeout, rate_limited, upstream_error, error).
- Max 10 shown, 1024 char cap.

### X-Fallback-Detail (opt-in)

See §3 above.

---

## 7. Key Functions (degradation.ts)

| Function | Purpose |
|----------|---------|
| `computeHealthSnapshot()` | Reads `api_keys` → `{healthyProviders, totalProviders, ratio}` |
| `updateDegradationState(now)` | State machine step, called after health pass |
| `isDegraded()` | Router gate |
| `getDegradationStatus()` | Dashboard + health endpoint |
| `resetDegradationState()` | Tests / boot re-probe |

---

## 8. Key Functions (fallback-loop.ts)

| Function | Purpose |
|----------|---------|
| `runFallbackLoop(hooks)` | Main loop |
| `newFallbackState()` | Fresh `{skipKeys, skipModels, skipPlatforms}` |
| `cooldownDecisionForError(route, err)` | Ladder + Retry-After + provenance |
| `recordRetryableFailure(route, err, state, now)` | Full bookkeeping |
| `recordAuthFailure(route, state)` | 401: skip key, 5min bench, trigger revalidation |
| `recordUpstreamSuccess(route, tokens)` | Account + clear streaks + mark key healthy |
| `exhaustedRetryError(lastError, maxRetries, ctx)` | Honest terminal status + body |
| `routingExhaustionBody(routeErr)` | Zero-attempt exhaustion from diagnostics |
| `setFallbackHeaders(res, failedAttempts, trail)` | X-Fallback-Attempts + X-Fallback-Trail |
| `setExhaustionHeaders(res, body)` | Retry-After from `retryAtMs` |
| `formatAttemptTrail(attempts)` | X-Fallback-Trail value |
| `formatAttemptDetail(records)` | X-Fallback-Detail value |
| `isFallbackDetailHeaderEnabled()` | Settings → env → false |
| `getFallbackTimeBudgetMs()` | Settings → env → 45s |
| `msUntilNextUtcMidnight()` | Daily quota reset boundary |

---

## 9. Flow: Request Enters Degraded Gateway

```
request → /v1/chat/completions
  ├─ isDegraded() = true
  │   └─ router: exploration DISABLED, scored order only
  ├─ runFallbackLoop()
  │   ├─ attempt 0: route() → best healthy model
  │   ├─ dispatch() → 429 daily exhausted
  │   │   └─ recordRetryableFailure() → cooldown (authoritative, until midnight)
  │   │   └─ skipKeys.add(), skipModels.add() (daily exhausted = model-level)
  │   ├─ attempt 1: route() → next healthy (skipKeys honored)
  │   ├─ ... budget check before each retry ...
  │   ├─ budget exceeded mid-attempt 3
  │   │   └─ abortInFlight() → HedgeAbortError
  │   │   └─ loop stops, timedOut exhaustion
  │   └─ onExhausted() → 429 with X-Fallback-Detail + Retry-After
  └─ response headers: X-Fallback-Attempts, X-Fallback-Trail, X-Fallback-Detail
```