# Routing & Bandit Scoring — Deep Dive

> **Source:** `server/src/services/router.ts`, `server/src/services/scoring.ts`

## 1. Overview

The router picks one `(platform, model, key)` tuple per request. It is **not** a round-robin load balancer — it is a contextual bandit that continuously learns from live traffic and composes a score from five normalized axes:

```
base = w_rel·reliability + w_speed·speed + w_intel·intelligence   (convex, weights sum to 1)
effective = base × headroomFactor × rateLimitFactor               (guardrail multipliers ∈ [floor, 1])
```

The **weights** come from a selectable strategy (`balanced` / `smartest` / `fastest` / `reliable` / `custom` / `priority`). The default is `balanced` (0.5 / 0.25 / 0.25). Operators can switch strategies from the dashboard or via `PUT /api/fallback/routing`.

Key selection within a model is driven by a separate `KeySelectionStrategy` (`auto` / `least-remaining`), independent of the model-ranking bandit so the two concerns don't interfere (#919, #930).

---

## 2. Chain Construction

The enabled fallback chain is sourced from (in priority order):

1. **Active profile** (`profile_models` table) — named chains like "coding", "long-context"
2. **Global fallback_config** — the legacy single chain
3. **Global sort alias** — `auto:smart`, `auto:fast`, `auto:cheap`, `auto:reliable`, `auto:balanced`
4. **Profile by name** — `auto:my-profile`

Each chain row (`ChainRow`) carries the model's static metadata (`intelligence_rank`, `size_label`, `monthly_token_budget`, rate limits, capabilities) plus the **endpoint scope** (`''` for catalog models, `'custom:<base_url_hash>'` for relay models) so two relays serving the same `model_id` are scored and rate-limited independently.

### Match Tier

`match_tier` (default 0) is an **outer sort key** that dominates score. It is set only when a unified group resolves a slug (e.g. `glm-4.7`) to a provider-specific model (`z-ai/glm-4.5`) — the matched member gets `match_tier = 1` so it never outranks a direct `model_id` request, no matter how good its live numbers are.

---

## 3. Reliability — Thompson Sampling with Beta Posteriors

### Decay-Weighted Samples

Reliability is not a raw success rate. The analytics window is 7 days with a **2-day half-life** exponential decay:

```
weight(age_days) = 0.5^(age_days / 2)
```

Each request bucket (grouped by `platform, model_id, key_id, age_days`) contributes decay-weighted pseudo-counts to `successes` and `failures`. Timeouts count as **failures for reliability** but **contribute to speed** (wall-clock latency, zero tokens).

### Posterior & Sampling

```
α = successes + community_successes + 1   (Beta(1,1) uniform prior)
β = failures  + community_failures  + 1
```

- **Routing (live)**: `reliability = sampleBeta(α, β)` — Thompson sampling. Exploration is automatic and proportional to uncertainty.
- **Dashboard (display)**: `reliability = α / (α + β)` — expected value, stable for sorting.

### Community Prior (opt-in)

When `routing_community_prior_enabled = 1`, de-poisoned aggregated counts from other self-hosted instances are folded into the posterior as a starting balance. Each prior is capped at **50 effective samples** so local evidence (decay-weighted, ~hundreds of samples on a busy install) always dominates within a few hundred requests.

### Exploration Floor (10%)

When `routing_explore_enabled = 1` (off by default), an unmeasured model (decay-weighted `successes + failures < 5`) gets a **guaranteed 10% chance** to be tried first, preventing starvation by prior-heavy rivals. The bandit's Thompson sampling already explores; this is a hard floor.

---

## 4. Speed Axis — Throughput + TTFB Blended

```
throughputScore(tok/s) = 1 - exp(-tok/s / 60)          # saturating, 60 tok/s ≈ 0.63
ttfbScore(ms)          = linear ramp 300ms→1.0 … 5000ms→0.0
speedScore             = 0.6·throughput + 0.4·ttfb       # when both present
```

- No successful samples → returns `SPEED_PRIOR = 0.6` (optimistic, so unmeasured models get explored on speed too).
- Throughput-only (no TTFB) → throughput alone.
- TTFB-only (no throughput) → TTFB alone.

**Timeouts feed speed** (#619): a timeout contributes its capped wall-clock latency (max 120s) to the throughput denominator with **zero output tokens**, and the same latency as a TTFB sample (which lands past `TTFB_WORST_MS`, earning no latency credit). A model that hangs constantly can no longer keep a stellar speed number.

### Observed Speed Rank Writeback

Every 10 minutes, models with ≥20 decay-weighted speed-bearing samples (successes + timeouts) and no user-set `speed_rank` override have their observed speed projected back onto the catalog's 1..10 `speed_rank` scale (1 = fastest). This keeps the dashboard's sort-by-speed preset honest for relay models.

---

## 5. Intelligence Axis — Tier-First, √-Compressed Rank

```
tierValue: Frontier=4, Large=3, Medium=2, Small=1, unknown=0
intelligenceComposite = tierValue * 1000 - sqrt(rank) * 31
```

- **Tier dominates strictly**: worst rank in a tier (√1000·31 ≈ 980) still beats best rank of tier below (1000).
- **Rank edits are visible**: √ compression makes a change from rank 1→3→10 move the axis noticeably, unlike the old linear rank which was drowned by the tier multiplier.
- Min-max normalized across the enabled chain to [0,1].

Custom models are seeded at the catalog median tier ("unknown" = no opinion, not "worst").

---

## 6. Guardrails — Multiplicative, Never Reordering Good Models

### Headroom Factor (quota protection)

```
remaining = 1 - usedTokens / budgetTokens
if remaining >= rampStart:  factor = 1.0
else:                       factor = floor + (1 - floor) * (remaining / rampStart)
```

- `budgetTokens` = `monthly_token_budget` × `usableKeyCount(platform)` — pools N keys' free tiers.
- Unknown budget (0 or NULL) → factor = 1 (no opinion).

### Tunable Headroom Thresholds (env / settings: `routing_headroom_ramp_start`, `routing_headroom_floor`)

The ramp is now operator-tunable via `GET/PUT /api/settings/headroom` (#989, #899). The thresholds are read **once per chain** instead of per model:

| Setting | Default | Purpose |
|---------|---------|---------|
| `rampStart` (`HEADROOM_RAMP_START`) | 0.2 (20% remaining) | Fraction at which demotion begins |
| `floor` (`HEADROOM_FLOOR`) | 0.1 (10% of score) | Score floor at 0 remaining budget |

Out-of-range / non-finite operator input falls back to the default rather than silently clamping to a legal-but-unintended value. The **same** ramp and thresholds also drive the rate-window headroom guardrail (see #8) — a single pair of operator-tuned thresholds governs both.

### Rate-Limit Factor (live penalty)

```
penalty ∈ [0, 10]   (from 429 escalation ladder, decays 1 per 2 min)
factor = 1 - (penalty / 10) * 0.6   # at max penalty, keeps 40% of score
```

- Demotes hard but never excludes — model recovers as penalty decays.

### Rate-Window Headroom Factor (RPD/TPD/RPM/TPM demotion, #899)

The monthly-budget guardrail only has an opinion about models that declare a `monthly_token_budget`. The far more common free-tier shape is a per-day request or token cap (RPD/TPD plus per-minute RPM/TPM), which was previously **binary**: the hard gates reject at 100% and the router happily keeps a model pinned at #1 until the very request that exhausts it, then eats a 429 and falls through.

The fix: the same tunable ramp, driven by **live window utilization** instead of monthly tokens:

```
usedFraction = consumed / limit   (0 = idle, 1 = exhausted)  — worst of the four windows
factor = headroomRamp(1 - usedFraction, opts)                — same tunable thresholds
```

- `usedFraction` is memoized inside `ratelimit.ts` as a **5-second snapshot** (`WINDOW_USAGE_TTL_MS = 5000`) — one grouped scan of `rate_limit_usage` plus one read of `api_keys`, shared by every entry of every chain. The hard gates are unaffected — they still read live counts.
- `null` means the model declares no window limits, or has no routable key to measure — factor = 1 (no opinion).
- **Combined headroom**: the router takes `Math.min(monthlyHeadroom, windowHeadroom)` — the **worse** of the two, never their product (which would push a model low on both to floor², below the operator-configured floor).

The chosen key is the **eligible key with the most headroom** (the one the router would pick NEXT), not the worst key — a platform with one exhausted key and one idle key routes perfectly well (#921).

### Peak-Hours Adjustment (opt-in, #760, #909)

During an operator-declared peak window, free relays are congested, so a model's raw throughput is a weaker signal than its reliability: part of the speed weight is moved onto reliability.

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `enabled` | `false` | Opt-in by design — routing that silently changes with the wall clock is impossible to reason about |
| `startHour` / `endHour` | 18 / 6 (spans midnight) | Window in the operator's IANA timezone |
| `timezone` | `UTC` | IANA name; read via `Intl` (never `Date#getHours`, since the host is frequently UTC while the traffic it serves is not) |

- **Shift amount**: `PEAK_SPEED_TO_RELIABILITY = 0.6` (60% of the speed weight moves onto reliability).
- **Exempt strategies** (`PEAK_EXEMPT_STRATEGIES`): `fastest` and `reliable` are **exempt** — they are the two ends of the speed↔reliability axis, and an operator who picked one has already decided which end they want. `priority` and `custom` are also never rewritten (the operator's explicit choice).
- The adjustment applies only to the mixed presets (`balanced`, `smartest`), where trading some speed for reliability stays inside the span the presets already describe.
- `peakAdjustedWeights()` returns `{ weights, adjusted }` — the dashboard labels the weight summary from the `adjusted` flag.
- `startHour === endHour` is an **empty** window (not 24-hour) — an operator who drags both ends to the same value means "nothing".

---

## 7. Per-Model Weight Overrides (env: `MODEL_ROUTING_OVERRIDES`)

```
MODEL_ROUTING_OVERRIDES='{"gpt-4o": {"weight": 0.5}, "llama-3.3-70b": {"weight": 1.5}}'
```

Scales the **final effective score** (after guardrails) so a slow/poor model is demoted without being disabled. A manual `priority` chain can still select it.

---

## 8. In-Model Key Selection (Bandit per Key)

When a model has multiple keys, keys are ordered by a **per-key Thompson score**:

```
keyReliability = sampleBeta(α_key + community_α, β_key + community_β)
keySpeed       = speedScore(keyStats.tokPerSec, keyStats.avgTtfbMs)
keyScore       = 0.75·keyReliability + 0.25·keySpeed
```

Returns `null` (fall back to round-robin) when <2 keys have recorded data. Catches expired/drained/region-blocked keys that the rolled-up model bucket cannot see.

---

## 9. Fallback Loop & Exhaustion Diagnostics

The shared loop (`lib/fallback-loop.ts`) drives every surface (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, legacy `/completions`):

- **Max 20 retries** (configurable).
- **Wall-clock retry budget** (default 45s, setting `fallback_time_budget_ms`). Stops starting new attempts after budget; first retry always allowed.
- **Hedging** (1d2226a): when budget expires mid-attempt, `abortInFlight()` cancels the upstream fetch instead of waiting for a stall.
- **Circuit breaker**: `max_consecutive_upstream_fails` (default 0 = off) stops the loop with 503 when the pool looks unhealthy.
- **Per-attempt trail**: `X-Fallback-Trail` header + `X-Fallback-Detail` (opt-in) with timings and redacted error summaries.
- **Synchronous exhaustion** (zero upstream calls): `RouteError.diagnostics` carries one line per considered model with the reason it could not serve (no key, cooldown, provider cap, rpm/rpd, tpm/tpd, context too small, …). `summarizeExhaustion()` rolls this into a client-safe bucketed message (e.g. "All models exhausted: 5 routes checked (3 rate-limited or on cooldown, 2 no usable key configured). Add more API keys or wait for rate limits to reset. Soonest reset ~2m.").

### Failure Classification & Bookkeeping

| Error | Skip | Cooldown | Model Penalty | Limit Learning |
|-------|------|----------|---------------|----------------|
| 401 invalid key | key only | 5 min (health cycle) | no | no |
| 402 payment required | key only | 24h | no | no |
| 403 model forbidden | model | 24h | no | no |
| 429 daily exhausted | model+key | until UTC midnight / Retry-After | heavy (3) | yes |
| 429 transient (rpm/tpm) | key only | 90s / escalation ladder | light (1) | yes |
| 5xx / timeout / transport | **platform** (#788) | 90s / ladder | light (1) | no |
| empty completion (reasoning) | key only | **exempt** (streak ≤3) | no | no |
| context too large | model | — | no | no |
| response_format ignored | model | — | no | no |

- **Model-level failure benching** (#806): 3 retryable failures across keys within 15 min → bench model on **all its keys** for 10 min (heuristic, probe-eligible).
- **Empty-completion streak limit** (#751): 3 consecutive reasoning-truncated completions on same model+key lifts the exemption.

---

## 10. Sticky Sessions

- Key = SHA-1(first user message [:: strategyKey]), TTL 30 min.
- Prevents mid-conversation model switches → hallucination spike.
- Session-affine reasoning trace memory (#797): restores `reasoning_content` stripped by clients on replay, scoped to the model that produced it.

---

## 11. Unified Model Groups (Unify)

When enabled, logical models (e.g. `glm-4.7`) collapse multiple providers into one `/v1/models` entry. Routing **strictly fails over within the group** — never to a different model. `match_tier = 1` on slug-resolved members prevents silent substitution.

---

## 12. Strategy Presets

| Strategy | Reliability | Speed | Intelligence |
|----------|-------------|-------|--------------|
| balanced | 0.50 | 0.25 | 0.25 |
| smartest | 0.35 | 0.10 | 0.55 |
| fastest  | 0.35 | 0.55 | 0.10 |
| reliable | 0.70 | 0.15 | 0.15 |
| custom   | user-tuned (normalized) | | |
| priority | manual order + 429 penalty (dense rank + penalty) | | |

### Key Selection Strategy (#919, #930)

Independent of the routing strategy on purpose — model ranking and key selection are independent choices, and folding this into the strategy enum would make switching key policy also switch (or disable) the model bandit.

| Strategy | Behavior |
|----------|----------|
| `auto` (default) | Per-key bandit score when ≥2 keys have recorded data, else round-robin |
| `least-remaining` | Additionally rank by observed remaining quota — roomiest key first, so the key nearest its cap is held back instead of being the next to 429 |

- `least-remaining` layers **on top** of the existing order (bandit ranking when there's data, else the round-robin rotation) — ties fall back to that order instead of rowid.
- Account-scoped pools (`<platform>::account`) are **skipped** for remaining-quota weighting, since every key reports the same shared number and reordering would only churn the rotation (#919).
- Reads quota headroom through the cached platform-filtered `getKeyQuotaHeadroom()` query.
- A key the quota tracker has never seen gets a neutral `UNKNOWN_QUOTA_HEADROOM = 0.5` — no opinion, not a reason to prefer or avoid.

---

## 13. Key Functions (router.ts)

| Function | Purpose |
|----------|---------|
| `routeRequest(...)` | Main entry: picks route, applies all filters (vision, tools, sticky, group, response_format) |
| `orderChain(chain, strategy, sampled)` | Orders chain by strategy; `sampled=true` for live routing, `false` for stable dashboard |
| `scoreChainEntry(...)` | Computes five axes + guardrails → final score |
| `orderKeysByScore(entry, keys)` | Per-key Thompson ordering |
| `orderKeysByRemainingQuota(entry, ordered)` | Re-sorts by observed remaining quota (roomiest first) |
| `quotaWeightingApplies(entry)` | Whether remaining-quota weighting is meaningful for this chain entry |
| `resolveRoutingChain(modelString)` | Parses `auto`, `auto:smart`, `auto:profile-name` |
| `getKeySelectionStrategy()` / `setKeySelectionStrategy(s)` | Read/write the `key_selection_strategy` setting |
| `getHeadroomThresholds()` / `setHeadroomThresholds(rampStart, floor)` | Read/write tunable headroom thresholds |
| `getPeakHoursConfig()` / `setPeakHoursConfig(patch)` | Read/write peak-hours settings |
| `getActiveRoutingWeights()` | Active weight vector + whether peak adjustment moved it |
| `recordRateLimitHit/recordModelFailure/recordSuccess` | Penalty mutations |
| `summarizeExhaustion(diag, soonestResetMs)` | Client-safe exhaustion message |

---

## 14. Key Functions (scoring.ts)

| Function | Purpose |
|----------|---------|
| `reliabilityPosterior(s, f, community?)` | Returns `{alpha, beta}` |
| `expectedReliability(s, f, community?)` | Deterministic α/(α+β) |
| `sampleBeta(α, β)` | Marsaglia & Tsang via two Gamma draws |
| `speedScore(tok/s, ttfbMs)` | Blended [0,1] speed |
| `intelligenceComposite(sizeLabel, rank)` | Tier-first composite |
| `intelligenceScore(composite, min, max)` | Min-max normalize |
| `headroomFactor(used, budget, opts?)` | Quota guardrail multiplier (tunable thresholds) |
| `rateWindowHeadroomFactor(usedFraction, opts?)` | Live window-utilization guardrail |
| `rateLimitFactor(penalty)` | Penalty guardrail multiplier |
| `combineScore(inputs, weights)` | Convex base × guardrails |
| `peakAdjustedWeights(base, strategy, config, now)` | Peak-hours reweighting + whether it fired |
| `isPeakHours(config, now)` | Whether `now` falls inside the configured window |

---

## 15. Cache Key v4 (#901)

The exact-match response cache key is now at **version 4**. Default-valued sampling params (`top_p: 1`, `n: 1`, `presence_penalty: 0`, `frequency_penalty: 0`) are normalized down to `undefined` so a client that always serializes the full param set shares a cache entry with one that omits the defaults. `reasoning_effort` and `compression` were also added to the key. Bump version when changing the key shape — `v: 4` is embedded in the canonical JSON.