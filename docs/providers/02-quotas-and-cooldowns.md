# Quotas, cooldowns, and key health

Free tiers fail in specific, metered ways: per-minute and per-day request caps, token budgets, concurrency limits, and outright quota exhaustion. The gateway models all of them so the router stops spending fallback attempts on keys it already knows are spent. The machinery lives in [`server/src/services/ratelimit.ts`](../../server/src/services/ratelimit.ts), [`server/src/services/provider-quota.ts`](../../server/src/services/provider-quota.ts), [`server/src/services/cooldown-probe.ts`](../../server/src/services/cooldown-probe.ts), [`server/src/services/health.ts`](../../server/src/services/health.ts), and the shared back-off parsers in [`server/src/providers/base.ts`](../../server/src/providers/base.ts).

## Rate-limit windows (RPM/RPD)

Every catalog model row carries `rpm_limit` / `rpd_limit` columns. Before dispatching an attempt, the router checks sliding windows keyed `platform:modelId:keyId:rpm` (minute) or `...:rpd` (day):

- A request is admitted only when `recorded + in-flight < limit` — counting in-flight leases (below) closes the race where N concurrent requests all read the same counter as unspent.
- Windows exist both in memory and persisted; on DB unavailability the router falls back to summing the in-memory window keys.

## Token budgets (TPM/TPD)

`tpm_limit` / `tpd_limit` work the same way with estimated tokens: a request counts against its minute/day token window only if `used + in-flight tokens + estimate` fits under the limit. Because some providers publish a generous RPD but a tiny TPM (the code cites groq `gpt-oss-120b`: rpd 1000 yet tpm 8000), the daily token check also feeds a derived cap so one large burst cannot exhaust a day's budget in seconds.

## Platform-wide pools

Per-model windows cannot see account-level ceilings: OpenRouter meters `:free` routes as one pool, Google meters per project, NVIDIA NIM meters a credit pool (~40 req/min across all models regardless of per-model rows). UnoRouter's `:free` models share a per-minute account-wide cap (a burst of parallel requests trips a 429 on every `:free` model for several minutes). xKiro's free plan enforces a 5M token/day account-wide budget across all free models (Mistral, MiniMax, DeepSeek families). `inferPoolForPlatform` maps platforms to shared pools (`openrouter::free`, `google::project`, `groq::account`, `nvidia::credit-pool`, `unorouter::free`, `xkiro::free`, ...) and each pool gets its own aggregate gate, so `(models × rpd)` fan-out earns surprise 429s no more.

## Concurrency leases

- **Leases** make in-flight requests visible: every dispatched attempt acquires a lease and releases it after the attempt settles (idempotent release; leaked leases are pruned by age). Without leases, counters are only written *after* the awaited provider call, so parallel streams would sail through the limit and collect real 429s.
- **Opt-in concurrency caps**: most free tiers meter requests-per-minute, not parallelism, so capping by default would serialize providers for no benefit. `MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM>` (per platform) or `MAX_CONCURRENT_REQUESTS_PER_KEY` (fallback) enables a per-key cap checked against live lease counts. There is deliberately no built-in per-platform table: the providers that behave this way are not documented precisely enough to assert numbers for.

## Cooldowns

A 429 blocks that model+key pair for a period:

| Mechanism | Duration | Notes |
| --- | --- | --- |
| Transient cooldown | 90s | Per-minute-window 429; recovers within ~one window. |
| Escalation ladder | 2min → 10min → 1h → 1 day | Hits tracked over a rolling 24h window; a genuinely exhausted daily quota quarantines the key for the rest of the day instead of looping through short cooldowns. A successful request clears the hit counter. |
| Unknown-limit ceiling | capped at 10min | When exhaustion is guessed rather than measured, the bench is capped since the verdict is a guess. |
| Payment required (402) | 1 day | Out-of-credits. |
| Model forbidden (403 tier gate) | 1 day | Key valid, model gated to a higher tier. |
| Local endpoint errors | 5s | Never enters the ladder. |
| Auth failure (401) | benched until the next health cycle | ~5 minutes. |

### Provenance and probe-based early recovery

Cooldowns record why they exist (`heuristic`, `authoritative`, `credit`, `tier`). Only `heuristic` benches are guesses that often outlive the outage; provider-stated facts (explicit Retry-After expiry, daily-quota reset) and credit/tier benches are never probed because a passing key-validation probe proves nothing about them.

The cooldown-probe job scans every 60s and re-validates probe-ripe keys to clear heuristic cooldowns early:

- ripe only after half the bench has elapsed, and only if >60s remains (probing a nearly-expired bench wastes a validate call);
- a failed probe never extends the bench — it schedules the next probe further out (2min doubling, capped at 15min);
- probes are side-effect-free for health bookkeeping, staggered after restart, and budgeted per pass (`COOLDOWN_PROBE_MAX_PER_PASS`, default 3); `COOLDOWN_PROBE_DISABLED=1` kills the job;
- the probe unit is the KEY, not the model: one `validateKey` result is evidence for every heuristic cooldown that key holds.

## Back-off from headers and error bodies (#798)

Before #798, a provider that stated exactly when to come back got the same heuristic ladder as one that said nothing, because error bodies were flattened to a message string before reaching the router. Now every adapter builds errors via `providerHttpError`, which captures:

1. **The `Retry-After` header** — delta-seconds or HTTP-date, parsed once (shared parser in `providers/base.ts`) and still the winning channel when both sources are present.
2. **A delay stated inside the error body**:
   - structured fields: Gemini answers 429 with `error.details[]` carrying `google.rpc.RetryInfo` whose `retryDelay` reads `"17s"`; the body is walked depth-capped (max depth 6) looking for `retryDelay` / `retry_after` / `retryAfterSeconds` shapes, which is more durable across providers than exact paths;
   - prose: anchored phrases like "try again in 30 seconds" or "retry after 2m" — anchored so an unrelated number in an error message can never be mistaken for a back-off.
3. All parsed delays are clamped to 24h so a malformed/hostile hint cannot bench a key forever.

Only the number is kept — never the body — so nothing extra reaches logs or attempt traces. Tests: [`server/src/__tests__/providers/stated-retry.test.ts`](../../server/src/__tests__/providers/stated-retry.test.ts).

## Health checks must not burn metered quota (#882)

Health runs a scheduled pass every 5 minutes (±20% jitter, keys validated more recently than 3.5 minutes skipped, default concurrency 8, ≥1s spacing between same-provider probes). That cadence is fine for free validation endpoints but poisonous where validation itself costs quota:

- ModelScope validates keys with a paid 1-token chat completion (`GET /v1/models` does not enforce auth), spending magic-grain quota — at the default cadence roughly 288 paid probes/key/day. Fix (#882): tokens not prefixed `ms-` are rejected locally with zero network calls, and a successful validation is cached per key for `MODELSCOPE_VALIDATE_CACHE_MS` (default 24h).
- Pollinations' public `/v1/models` answers 200 even for revoked keys, so validation targets the authenticated `/account/key`; AI Horde treats any reachable endpoint as healthy rather than spending queue slots.

The rule for contributors: **if `validateKey` consumes metered quota, it needs a cache or a free probe path** — see [03-adding-a-new-provider.md](03-adding-a-new-provider.md).
