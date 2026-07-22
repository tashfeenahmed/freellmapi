# Test Plan: Rate Limiter Delay Feature

## Context

The rate limiter delay feature (`applyThrottle` in `services/throttler.ts`) applies
per-model RPM/TPM delays AFTER route resolution so the throttler sees the actual
resolved model, not the client-sent model name. It is called from:

- `routes/proxy.ts` — POST `/chat/completions`, POST `/completions`
- `routes/responses.ts` — POST `/responses`
- `routes/anthropic.ts` — POST `/messages`

**How it works:**
- `checkThrottle(ctx)` reads model's rate limits from the DB, checks live RPM/TPM usage,
  computes a delay if usage exceeds a per-provider threshold (default 0.8 = 80%), and logs
  the decision.
- `applyThrottle(ctx)` calls `checkThrottle` and awaits the delay via `setTimeout`.
- Delay formula: `(ratio - threshold) * 60_000` ms, minimum 100ms floor.
  E.g. with rpmLimit=1000, rpmUsed=502, threshold=0.5: overThreshold=0.002, delay=120ms.
- Per-provider thresholds in `server/config/provider-limits.json` (default delayThreshold=0.5).

## What exists

- `server/src/services/throttler.ts` — the throttler service (no tests yet)
- `server/src/services/ratelimit.ts` — sliding-window usage tracker, mocked by tests
- `server/src/services/provider-limits.ts` — per-provider thresholds, mocked by tests
- `server/src/__tests__/services/ratelimit.test.ts` — existing rate limiter tests (vitest)
- `server/dist/middleware/throttler.test.js` — compiled test for an OLD middleware-based
  throttler that no longer exists in source (the old `middleware/throttler.ts` was replaced
  by `services/throttler.ts`). This file is stale/compiled artifact only.
- Log format: `[Throttler] HH:MM:SS delay <id> <platform> <modelId> rpm=<used>/<limit>(<pct>) tpm=<used>/<limit>(<pct>) thresh=<pct> delay=<ms>ms`
  or `[Throttler] HH:MM:SS pass <id> ...`.

## Plan

### Step 1: Create unit tests for `throttler.ts`

Create `server/src/__tests__/services/throttler.test.ts` covering:

1. **`calculateDelay` (via `checkThrottle`)**:
   - Below threshold → 0 delay
   - At threshold (50%) → minimum 100ms delay
   - Above threshold (60%) → proportional delay
   - Above threshold via TPM axis → TPM delay
   - Both RPM and TPM above threshold → returns max(rpmDelay, tpmDelay)
   - Null limit → no delay contribution from that axis
   - RPM at exactly threshold, TPM below → RPM minimum 100ms
   - TPM at exactly threshold, RPM below → TPM minimum 100ms

2. **`checkThrottle`**:
   - Model with no DB record → returns 0 (no delay)
   - Logs "pass" when below threshold
   - Logs "delay" when above threshold
   - Includes the correct ratio percentages in log output

3. **`applyThrottle`**:
   - Applies zero delay when checkThrottle returns 0 (no setTimeout)
   - Applies non-zero delay via fake timers and resolves after delay

4. **Delay threshold variation**:
   - Per-provider threshold (mock `getPlatformDelayThreshold`): threshold=0.8 needs ~80%+ usage
   - Threshold=1.0 → delay only when at or above 100%
   - Threshold=0.99 → almost at limit before delay kicks in

5. **DB unavailable**: `getDb` throws → graceful fallback to 0 delay, no crash

Mock strategy (matching existing test patterns):
- `vi.mock('../db/index.js')` — mock `getDb().prepare().get()` to return rate limit columns
- `vi.mock('../services/ratelimit.js')` — mock `getRateLimitStatus`
- `vi.mock('../services/provider-limits.js')` — mock `getPlatformDelayThreshold`
- Use `vi.useFakeTimers()` for delay timing tests

### Step 2: Create integration tests for end-to-end delay enforcement

Create `server/src/__tests__/routes/throttler-integration.test.ts` testing that the
delay actually affects request timing:

1. **`POST /chat/completions` with throttle** — send requests until the in-memory
   RPM counter exceeds the threshold for the resolved model, measure total request time,
   verify a delay was introduced (use fake timers).

2. **`POST /v1/responses` with throttle** — same pattern for the Responses endpoint.

3. **`POST /v1/messages` with throttle** — same pattern for the Anthropic endpoint.

4. **Auto model resolution** — confirm the delay applies based on the RESOLVED model,
   not the client-sent model name.

5. **No throttle when not needed** — below threshold, no artificial delay added.

For integration tests, follow the pattern of existing route tests (e.g.,
`server/src/__tests__/routes/proxy-rate-limit.test.ts`): create an Express app, make
HTTP requests, use fake timers, and inspect the timing or log output.

### Step 3: Run all tests

```bash
cd server && pnpm vitest run src/__tests__/services/throttler.test.ts
cd server && pnpm vitest run src/__tests__/routes/throttler-integration.test.ts
```

Verify the unit tests pass first, then integration tests.

## Output files

- `server/src/__tests__/services/throttler.test.ts` (new)
- `server/src/__tests__/routes/throttler-integration.test.ts` (new)

## Verification

The test plan is complete. Running the tests will confirm:
- Delay calculation is correct across all axes (RPM, TPM)
- Delay thresholds per provider work as configured
- Delays are actually applied (not just calculated)
- All three endpoints (proxy, responses, anthropic) apply throttling
- The feature works with auto-routed requests (resolved model, not sent model)