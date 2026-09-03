# Quota & Cooldown Engine — Deep Dive

> **Source:** `server/src/services/ratelimit.ts`, `server/src/services/cooldown-probe.ts`, `server/src/services/provider-quota.ts`

## 1. Overview

The quota engine is the **gatekeeper** between the router and upstream providers. It tracks four sliding windows per `(platform, model, key)` plus provider-wide pools, persists to SQLite, and learns real limits from provider error bodies. Cooldowns bench failing keys/models with an escalating ladder, and a background probe job recovers heuristic cooldowns early.

---

## 2. Four-Dimensional Quota Accounting

### Per-(Platform, Model, Key) Windows

| Window | Width | Persisted Column | In-Memory Fallback |
|--------|-------|------------------|-------------------|
| RPM    | 60 s  | `rpm_limit`      | `timestamps[]`    |
| RPD    | 24 h (UTC midnight) | `rpd_limit` | `timestamps[]` |
| TPM    | 60 s  | `tpm_limit`      | `{ts, tokens}[]`  |
| TPD    | 24 h (UTC midnight) | `tpd_limit` | `{ts, tokens}[]` |

- **Sliding minute** for RPM/TPM; **UTC-day boundary** for RPD/TPD (providers reset at midnight, not 24h rolling).
- `rate_limit_usage` table: one row per request/token event with `kind = 'request' | 'tokens'`, `created_at_ms`.
- Retention: 1 day (pruned on insert, throttled to 1/min).
- **Degraded mode**: when DB write fails, counts go to in-memory windows only (pruned on push so a long outage can't grow unbounded).

### Provisional Usage (In-Flight Leases)

> **The check-then-act closer.** Between key selection and the post-success `recordRequest/recordTokens` write, N concurrent requests would all read the same pre-check and collectively blow through the limit. **Leases make in-flight requests visible to the next caller.**

```typescript
acquireLease(platform, modelId, keyId, estimatedTokens) → leaseId
releaseLease(leaseId)  // in finally block, idempotent
```

- Leases count against **both minute and day windows** (a request in flight belongs to this minute and today).
- Max lease age: 2 min (backstop for leaked leases).
- Per-key concurrency cap (opt-in via `MAX_CONCURRENT_REQUESTS_PER_KEY[_PLATFORM]`).

### Provider-Wide Pools

Some providers enforce **one quota across the whole account**, not per model:

| Pool | Providers | Config |
|------|-----------|--------|
| Daily requests | OpenRouter (1000/day free, 50/day <10 credits), ModelScope (2000→1800 margin) | `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` |
| Daily tokens | NavyAI (150K/day shared, model multipliers) | `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` |
| Minute requests | NVIDIA NIM (40 RPM account-wide) | `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` |

- Counted by summing per-model windows for the same `platform + keyId`.
- NavyAI token multiplier parsed from `monthly_token_budget` label (e.g. `2x`) or derived from `tpd_limit`.

### Provider Quota Keys (pooling across models)

`inferQuotaPoolKey(platform, modelId)` → string like `openrouter::free`, `google::project`, `nvidia::account`. Used by analytics and routing to attribute usage to the correct shared bucket.

- Per-platform `inferPoolForPlatform()` maps each platform to its pool key shape. Aggregators with a single shared free pool (`routeway`, `bazaarlink`, `unorouter`, `orcarouter`, `xkiro`, `anyapi`, `navy`, `nara`, `sealion`, `aion`, `requesty`) get one pool; `openrouter` distinguishes `:free` from `:account`; others default to `::account` or `::<modelId>`.
- `isSharedPool(platform)` returns the list of platforms that enforce one quota across the whole account — used by analytics and the `least-remaining` key selection (which skips `::account` pools since every key reports the same number).
- `provider-quota.ts` also exposes `getKeyQuotaHeadroom(platform)` → a cached, platform-filtered read of `provider_quota_state` (5s TTL, confidence ≥ 0.7 floor, expired windows treated as full) that the router's `least-remaining` strategy reads to rank keys by remaining budget.

---

## 3. Window Utilization Snapshot (for the routing guardrail, #899)

The hard gates (`canMakeRequest` / `canUseTokens`) answer a yes/no question on the hot path. The router also needs a **graded** signal — "how much of its window quota has this model already burned" — so it can steer traffic away from a model at 95% of its daily cap before that cap actually rejects anything. This is the input to `rateWindowHeadroomFactor` in `scoring.ts`.

### 5-Second Snapshot (`modelWindowUsedFraction`)

Cost is the whole design constraint: this runs per chain entry per request, and the naive shape is four counts per model × key. So it is:

- **One grouped scan** of `rate_limit_usage` (replaces four counts per model × key) plus one read of `api_keys`, **memoised for 5 seconds** (`WINDOW_USAGE_TTL_MS = 5000`) and shared by every entry of every chain.
- Per-entry work is then pure in-memory arithmetic over the model's own limit columns (which the router already has in hand).
- The hard gates above are **unaffected** — they still read live counts, so nothing here can let a request through a real limit.

### Key Selection

The chosen key is the **eligible key with the most headroom** (the one the router would pick NEXT), not the worst key on the account — a platform with one exhausted key and one idle key routes perfectly well (#921). In-flight leases are deliberately **not** counted: they close the check-then-act race on the hard gates; this is a steering signal averaged over a whole window, and folding a per-request quantity into a cached snapshot would buy noise, not accuracy.

### Pressure Calculation

A key metered on several windows takes the **worst** of them (the binding constraint is what 429s). Returns `null` (no opinion) when the model declares no window limits, has no routable key to measure, or the database is unreachable.

---

## 4. Cooldown Ladder & Provenance

### Sources (CooldownSource)

| Source | Meaning | Probe-Eligible? |
|--------|---------|-----------------|
| `heuristic` | Our own guess (transient 90s, escalation ladder, auth-failure bench, empty-completion) | **Yes** |
| `authoritative` | Backed by explicit provider Retry-After or daily-quota reset (a fact) | No |
| `credit` | 402 out-of-credits — key validation proves nothing about top-up | No |
| `tier` | 403 model-not-on-tier — key validates but model stays gated | No |

### Escalation Ladder (per model+key, rolling 24h)

| Hit # | Duration | Notes |
|-------|----------|-------|
| 1 | 2 min | |
| 2 | 10 min | |
| 3 | 1 h | |
| 4+ | 24 h | |

- **Transient RPM/TPM 429** with healthy daily counters → short 90s cooldown, **does not count** toward ladder.
- **Daily exhaustion** (RPD/TPD counter ≥ cap) → takes ladder step (up to 24h).
- **Unknown limits** (NULL RPD/TPD): heuristic — 2+ 429s in 1h → "effectively daily exhausted" → escalate **but capped at 10 min** (`UNKNOWN_LIMIT_MAX_COOLDOWN_MS`). Prevents Ollama/Cloudflare/etc. from looping 90s forever when every request is a 429.
- **Local endpoints** (loopback/RFC1918 `base_url`): capped at **5 s**, never escalates (#592).

### Retry-After Handling

```
if (retryAfterMs > ourBench) → bench = min(retryAfterMs, 24h), source = 'authoritative'
else → our bench stands, source = 'heuristic'
```

Provider-stated reset wins; everything past it is our guess.

### Special Cooldowns

| Trigger | Duration | Source |
|---------|----------|--------|
| 402 Payment Required | 24 h | `credit` |
| 403 Model Forbidden | 24 h | `tier` |
| Daily quota exhausted (explicit) | until UTC midnight / Retry-After | `authoritative` |
| Auth failure (401) | 5 min (health cycle) | `heuristic` |
| Empty completion streak (≥3) | normal ladder | `heuristic` |

---

## 5. Learning Real Limits from Error Bodies (#798)

When a provider rejects with its real limit in the body, we **persist it** so pre-checks stop us before the next 413/429.

```typescript
// Groq 413: "...on tokens per minute (TPM): Limit 30000, Requested 33476"
parseProviderLimit(message) → { kind: 'tpm', limit: 30000 }
learnLimitFromError(modelDbId, err) → writes to models.tpm_limit if NULL or lower
```

- **Only tightens**: fills NULL or **lowers** an existing limit. Never raises — hitting a ceiling means our pre-check already let too much through.
- Axis priority: TPD → TPM → RPD → RPM (day before minute, tokens before requests).
- Requires BOTH "Limit N" and a confident axis match — no guessing.

---

## 6. Cooldown-Probe Early Recovery (`cooldown-probe.ts`)

### Goal

Heuristic cooldowns are pessimistic. When the provider recovers sooner (minute window rolled over, incident ended), capacity sits idle until the timer expires. The probe job **validates the key** and clears heuristic cooldowns early.

### Algorithm

- **Scan interval**: 60 s (cheap indexed SELECT on `rate_limit_cooldowns` where `source = 'heuristic'`).
- **Ripeness**: cooldown must have served ≥50% of its bench **AND** have ≥60 s remaining.
- **Per-key backoff**: 2m → 4m → 8m → 15m cap (failed probe = back off, bench unchanged).
- **First-sighting stagger**: on restart, all persisted cooldowns are sighted at once. First probe scheduled at `now + jitter(0..45s)` to avoid thundering herd.
- **Budget**: `COOLDOWN_PROBE_MAX_PER_PASS` (default 3, env-tunable).
- **On valid probe**: clear **all** heuristic cooldowns for that key (across models), log `cooldown_recovered` event.
- **Never probes**: authoritative/credit/tier cooldowns (filtered at query).

### Kill Switch

`COOLDOWN_PROBE_DISABLED=1`

---

## 7. Key Functions (ratelimit.ts)

| Function | Purpose |
|----------|---------|
| `canMakeRequest(platform, modelId, keyId, limits)` | Pre-check RPM+RPD + in-flight leases |
| `canUseTokens(platform, modelId, keyId, estTokens, limits)` | Pre-check TPM+TPD + in-flight leases |
| `canUseProvider(platform, keyId)` | Provider-wide daily request cap |
| `canUseProviderMinute(platform, keyId)` | Provider-wide minute request cap |
| `canUseProviderTokens(platform, keyId, modelId, estTokens)` | Provider-wide daily token cap |
| `recordRequest/recordTokens` | Post-success accounting (DB + in-flight release) |
| `acquireLease/releaseLease` | In-flight concurrency + provisional usage |
| `getCooldownDecisionForLimit(...)` | Full ladder + Retry-After + provenance |
| `setCooldown(platform, modelId, keyId, durationMs, source)` | Persist + memory |
| `isOnCooldown(platform, modelId, keyId)` | Check memory → DB → expiry |
| `getProbeableCooldowns()` | Heuristic-only, for probe job |
| `clearCooldownEarly(platform, modelId, keyId)` | Probe recovery (keeps escalation history) |
| `parseProviderLimit(message)` | Extract `{kind, limit}` from error body |
| `learnLimitFromError(modelDbId, err)` | Persist if tightens |
| `getSoonestCooldownExpiry()` | For `Retry-After` header + exhaustion message |
| `modelWindowUsedFraction(model, limits, now)` | 0..1 binding-window utilization (5s snapshot) |
| `invalidateWindowUsage()` | Drop the memoised window snapshot (tests) |

---

## 8. Key Functions (cooldown-probe.ts)

| Function | Purpose |
|----------|---------|
| `runCooldownProbePass(opts?)` | One scan → probe ripe keys → clear on valid |
| `isRipe(cooldown, now)` | ≥50% served + ≥60s remaining |
| `startCooldownProbe(scheduler)` | Registers 60s interval job |
| `resetCooldownProbeState()` | Test seam |

---

## 9. Persistence Schema (relevant tables)

```sql
-- Per-(platform,model,key) usage events
CREATE TABLE rate_limit_usage (
  platform TEXT, model_id TEXT, key_id INTEGER,
  kind TEXT CHECK(kind IN ('request','tokens')),
  tokens INTEGER, created_at_ms INTEGER
);
CREATE INDEX idx_rate_limit_usage_lookup
  ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);

-- Cooldowns with provenance
CREATE TABLE rate_limit_cooldowns (
  platform TEXT, model_id TEXT, key_id INTEGER,
  expires_at_ms INTEGER, source TEXT CHECK(source IN ('heuristic','authoritative','credit','tier')),
  set_at_ms INTEGER,
  PRIMARY KEY (platform, model_id, key_id)
);

-- Server logs (warn/error only)
CREATE TABLE server_logs (
  id INTEGER PRIMARY KEY, level TEXT, source TEXT, provider TEXT,
  model TEXT, event TEXT, request_id TEXT, message TEXT, created_at_ms INTEGER
);
```

---

## 10. Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_CONCURRENT_REQUESTS_PER_KEY` | null (unlimited) | Global per-key concurrency cap |
| `MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM>` | null | Platform-specific override |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` | see table | Provider-wide daily request cap (0 = disable) |
| `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` | see table | Provider-wide daily token cap |
| `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` | see table | Provider-wide minute request cap |
| `COOLDOWN_PROBE_DISABLED` | 0 | Kill switch for probe job |
| `COOLDOWN_PROBE_MAX_PER_PASS` | 3 | Probes per 60s scan |
| `DEGRADED_HEALTHY_RATIO` | 0.5 | Degraded mode threshold (see 04-degraded-mode) |
| `DEGRADED_MIN_PROVIDERS` | 3 | Min providers for degraded eval |
| `DEGRADED_ENTRY_GRACE_MS` | 60000 | Time below threshold before entry |
| `DEGRADED_EXIT_GRACE_MS` | 120000 | Time above threshold before exit |

---

## 11. Flow Diagram: Request → Quota Check → Dispatch → Account

```
routeRequest()
  ├─ canMakeRequest()        → RPM + RPD + in-flight leases
  ├─ canUseTokens()          → TPM + TPD + in-flight leases
  ├─ canUseProvider()        → provider daily request cap
  ├─ canUseProviderMinute()  → provider minute request cap
  ├─ canUseProviderTokens()  → provider daily token cap
  ├─ canUseKeyConcurrency()  → per-key concurrency cap
  └─ isOnCooldown()          → heuristic/authoritative bench
        ↓
acquireLease()  (provisional usage now visible to next caller)
        ↓
dispatch to provider
        ↓
success:
  recordRequest()  → DB + releaseLease()
  recordTokens()   → DB + releaseLease()
  clear cooldown hits / null-limit hits
failure (retryable):
  recordRetryableFailure() → cooldownDecisionForError() → setCooldown()
  recordRateLimitHit() / recordModelFailure() (model penalty)
  learnLimitFromError()    (if provider reported ceiling)
  skipKeys.add(platform:modelId:keyId)
  skipModels.add(modelDbId) on 403/404/context-too-large
  skipPlatforms.add(platform) on 5xx/timeout (#788)
```