// One shared provider retry/fallback loop for every OpenAI-, Responses- and
// Anthropic-shaped chat surface (routes/proxy.ts legacy /completions and
// /chat/completions, routes/responses.ts, routes/anthropic.ts). Each surface
// used to carry its own ~150-line copy of the attempt loop, and the copies had
// drifted (a 403 that was benched for a day on three surfaces but only 90s on
// /v1/responses; an exhaustion body that returned a 400 for a provider-invalid
// request on three surfaces but always 429 on /v1/messages; a Retry-After that
// was honored everywhere except /v1/responses). This module is the single
// source of truth for the parts that MUST behave identically — cooldown
// selection, per-key failure bookkeeping, exhaustion status — while each
// surface keeps its own request/stream translation as a thin `dispatch` adapter.
//
// Almost pure control-flow + accounting: no Express, no wire-format knowledge.
// The per-surface bytes (SSE framing, error-body shape, context handoff, group
// routing) live in the caller's hooks. The one side effect beyond bookkeeping is
// the fire-and-forget key revalidation kicked off on an upstream 401 (below).

import type { RouteResult } from '../services/router.js';
import { recordRateLimitHit, recordSuccess, hasOtherUsableKey, formatResetEta } from '../services/router.js';
import {
  recordRequest,
  recordTokens,
  setCooldown,
  getCooldownDurationForLimit,
  getSoonestCooldownExpiry,
  PAYMENT_REQUIRED_COOLDOWN_MS,
  MODEL_FORBIDDEN_COOLDOWN_MS,
  learnLimitFromError,
} from '../services/ratelimit.js';
import {
  isRetryableError,
  isKeyAuthError,
  isDailyQuotaExhaustedError,
  isPaymentRequiredError,
  isModelNotFoundError,
  isModelAccessForbiddenError,
  isProviderBadRequestError,
} from './error-classify.js';
import { sanitizeProviderErrorMessage } from './error-redaction.js';
import { checkKeyHealth } from '../services/health.js';
import { getSetting } from '../db/index.js';

// Every surface caps failover hops at the same number.
export const FALLBACK_MAX_RETRIES = 20;

// ── Wall-clock retry budget ──────────────────────────────────────────────────
// Serial failover has no time bound of its own: the observed worst case was a
// 38.8s TTFB over 11 attempts, and the theoretical worst is maxRetries x the
// per-attempt HTTP timeout. The budget is checked before STARTING each retry
// (the first attempt always runs), so one slow attempt is never aborted
// mid-flight — it just becomes the last one. 0 disables the budget entirely.
// Precedence mirrors the response cache: the settings-table value wins when
// present (runtime-tunable), then the env var, then the default.
// TODO(fallback-v2): AbortController hedging so a stalled attempt can be
// abandoned mid-flight instead of only refusing to start the next one.
export const DEFAULT_FALLBACK_TIME_BUDGET_MS = 45_000;
export const FALLBACK_TIME_BUDGET_SETTING = 'fallback_time_budget_ms';

export function getFallbackTimeBudgetMs(): number {
  let stored: string | undefined;
  try {
    stored = getSetting(FALLBACK_TIME_BUDGET_SETTING);
  } catch {
    stored = undefined; // DB not ready — never throw on the proxy hot path
  }
  const candidates = [stored, process.env.FALLBACK_TIME_BUDGET_MS];
  for (const raw of candidates) {
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_FALLBACK_TIME_BUDGET_MS;
}

// Mutable per-request skip state threaded through the loop and mutated by
// recordRetryableFailure / recordAuthFailure. skipKeys entries are
// "platform:modelId:keyId"; skipModels holds model_db_ids ruled out for the
// rest of this request.
export interface FallbackState {
  skipKeys: Set<string>;
  skipModels: Set<number>;
}

export function newFallbackState(): FallbackState {
  return { skipKeys: new Set<string>(), skipModels: new Set<number>() };
}

// Milliseconds until the next UTC midnight — when most providers' daily free
// allocations reset. Floored at one minute so a hit seconds before midnight
// still records a real bench instead of a no-op.
export function msUntilNextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(next - now, 60_000);
}

/**
 * The one true cooldown-duration selection after a retryable upstream failure:
 *   - 402 out-of-credits  → a full day (PAYMENT_REQUIRED_COOLDOWN_MS)
 *   - 403 model-not-on-tier → a full day (MODEL_FORBIDDEN_COOLDOWN_MS), because a
 *     tier/subscription gate won't clear on the next minute window (issue #256)
 *   - a 429 that says the DAILY free allocation is spent (Cloudflare "used up
 *     your daily free allocation of 10,000 neurons") → benched until the next
 *     UTC midnight, like the 402 path. The old transient 90s cooldown made the
 *     router re-pick a dead-for-the-day provider all day long. An explicit
 *     provider Retry-After wins over the midnight heuristic: rolling daily
 *     windows (Groq RPD "try again in 7m12s" with a Retry-After header) reset
 *     well before midnight, and the provider knows its own reset time best.
 *   - anything else → the transient/daily escalation ladder, honoring the
 *     provider's Retry-After as a floor (getCooldownDurationForLimit).
 */
export function cooldownForError(route: RouteResult, err: any): number {
  if (isPaymentRequiredError(err)) return PAYMENT_REQUIRED_COOLDOWN_MS;
  if (isModelAccessForbiddenError(err)) return MODEL_FORBIDDEN_COOLDOWN_MS;
  if (isDailyQuotaExhaustedError(err)) return err?.retryAfterMs ?? msUntilNextUtcMidnight();
  return getCooldownDurationForLimit(
    route.platform,
    route.modelId,
    route.keyId,
    { rpd: route.rpdLimit, tpd: route.tpdLimit },
    err?.retryAfterMs,
  );
}

/**
 * Apply the full per-key failure bookkeeping shared by every surface after a
 * retryable failure:
 *   - rule out the WHOLE model for the rest of the request on a 404 (removed
 *     upstream) or 403 (off this key's tier) — a sibling key would fail it the
 *     same way (PR #111 / issue #256);
 *   - bench this model+key via cooldownForError;
 *   - demote the model in the scorer ONLY when the failure exhausted it — i.e.
 *     no sibling key can still serve it (#454 gate). skipKeys already contains
 *     the just-failed key here, preserving #479's "count budget across keys"
 *     semantics: hasOtherUsableKey excludes both the failed key and skipKeys;
 *   - learn a provider-reported ceiling (e.g. a Groq 413 "TPM: Limit 30000")
 *     from the error body so the next pre-check fails over before the 413.
 *
 * Reasoning-truncation exemption: an error thrown with `skipBench: true` (a
 * reasoning model that spent the whole max_tokens budget on hidden reasoning,
 * finish_reason 'length') still fails over — the key is skipped for THIS
 * request — but is NOT a provider-health signal, so no cooldown, no model
 * penalty, and no limit-learning are recorded. Benching those was costing
 * healthy models a 90s cooldown + a scorer penalty per truncated turn.
 *
 * Callers add the just-failed key to skipKeys via this function (do not pre-add).
 */
export function recordRetryableFailure(route: RouteResult, err: any, state: FallbackState): void {
  if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) {
    state.skipModels.add(route.modelDbId);
  }
  state.skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
  if (err?.skipBench === true) return;
  setCooldown(route.platform, route.modelId, route.keyId, cooldownForError(route, err));
  // Model-level penalty only when no sibling key can still serve (#454).
  if (!hasOtherUsableKey(route.modelDbId, route.keyId, state.skipKeys)) {
    recordRateLimitHit(route.modelDbId);
  }
  learnLimitFromError(route.modelDbId, err);
}

// ── Upstream 401 handling (key-fatal, not request-fatal) ─────────────────────
// A 401 means THIS key is bad, not this model or this request. The old behavior
// (non-retryable → 502) stranded the provider's healthy sibling key and every
// other provider in the chain, and left the bad key in rotation failing traffic
// until the next 5-minute health cycle. Now the loop skips the key, benches the
// model+key long enough to cover the health cycle, and kicks an immediate
// targeted revalidation so a confirmed-bad key flips to status 'invalid' (and
// out of routing) within seconds instead of minutes.
export const AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

// Dedupe window for the fire-and-forget revalidation: many concurrent requests
// hitting the same bad key must not stampede the provider's validate endpoint.
const REVALIDATION_DEDUPE_MS = 30_000;
const lastRevalidation = new Map<number, number>();

function triggerKeyRevalidation(platform: string, keyId: number): void {
  const now = Date.now();
  const last = lastRevalidation.get(keyId) ?? 0;
  if (now - last < REVALIDATION_DEDUPE_MS) return;
  lastRevalidation.set(keyId, now);
  console.warn(`[FallbackLoop] Upstream 401 from ${platform} key ${keyId}; revalidating it now instead of waiting for the health cycle`);
  void checkKeyHealth(keyId).catch(err => {
    console.error(`[FallbackLoop] Immediate revalidation of key ${keyId} failed:`, err?.message);
  });
}

/**
 * Bookkeeping for an auth-fatal (401 / invalid key) attempt: skip the key for
 * this request, bench the model+key for the health-cycle window, and start an
 * immediate revalidation. Deliberately NO model penalty and NO limit-learning —
 * a bad key says nothing about the model's health.
 */
export function recordAuthFailure(route: RouteResult, state: FallbackState): void {
  state.skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
  setCooldown(route.platform, route.modelId, route.keyId, AUTH_FAILURE_COOLDOWN_MS);
  triggerKeyRevalidation(route.platform, route.keyId);
}

/**
 * The success-side accounting every surface runs after a completed attempt:
 * count the request + its tokens against the model+key's rate-limit windows and
 * clear the model's 429 penalty. `rateLimitTokens` is whatever the surface metered
 * (the provider's usage.total_tokens for non-stream, an estimate for stream).
 */
export function recordUpstreamSuccess(route: RouteResult, rateLimitTokens: number): void {
  recordRequest(route.platform, route.modelId, route.keyId);
  recordTokens(route.platform, route.modelId, route.keyId, rateLimitTokens);
  recordSuccess(route.modelDbId);
}

// ── Attempt trail ─────────────────────────────────────────────────────────────
// One record per dispatched-and-failed attempt, so the final exhaustion error
// can show the client WHAT was tried instead of only the last error. Key ids
// are internal DB integers; the trail shows a per-request ordinal (key1, key2…)
// instead, which is stable, readable, and leaks nothing.

export type AttemptErrorClass =
  | 'auth'
  | 'out_of_credits'
  | 'daily_quota_exhausted'
  | 'model_not_found'
  | 'forbidden'
  | 'provider_bad_request'
  | 'empty_completion'
  | 'timeout'
  | 'rate_limited'
  | 'upstream_error'
  | 'error';

export interface AttemptRecord {
  platform: string;
  modelId: string;
  keyOrdinal: number;
  errorClass: AttemptErrorClass;
}

export function classifyAttemptError(err: any): AttemptErrorClass {
  if (isKeyAuthError(err)) return 'auth';
  if (isPaymentRequiredError(err)) return 'out_of_credits';
  if (isDailyQuotaExhaustedError(err)) return 'daily_quota_exhausted';
  if (isModelNotFoundError(err)) return 'model_not_found';
  if (isModelAccessForbiddenError(err)) return 'forbidden';
  if (isProviderBadRequestError(err)) return 'provider_bad_request';
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('empty completion')) return 'empty_completion';
  if (msg.includes('timeout') || msg.includes('stalled') || msg.includes('etimedout') || msg.includes('aborted')) return 'timeout';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota')) return 'rate_limited';
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status >= 500 || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('unavailable') || msg.includes('internal server error')) return 'upstream_error';
  return 'error';
}

const TRAIL_MAX_SHOWN = 10;

export function formatAttemptTrail(attempts: AttemptRecord[]): string {
  const shown = attempts
    .slice(0, TRAIL_MAX_SHOWN)
    .map(a => `${a.platform}/${a.modelId} key${a.keyOrdinal}: ${a.errorClass}`);
  const extra = attempts.length - shown.length;
  return shown.join('; ') + (extra > 0 ? `; +${extra} more` : '');
}

export interface ExhaustionBody {
  status: number;
  type: string;
  message: string;
  // Coarse class of the exhaustion, for surfaces that need to remap `type` to
  // their own wire vocabulary (the Anthropic route maps 'auth' → 'api_error').
  kind: 'auth' | 'bad_request' | 'rate_limit';
}

export interface ExhaustionContext {
  attempts?: AttemptRecord[];
  // True when the wall-clock retry budget stopped the loop before maxRetries.
  timedOut?: boolean;
  budgetMs?: number;
}

/**
 * The shared exhaustion response body.
 *   - Every attempt failed auth (401/invalid key) → 502 provider_error saying the
 *     PROVIDER keys are bad — distinct from a rate-limit exhaustion, and never
 *     'authentication_error' (which would wrongly blame the CLIENT's key).
 *   - A request every routed provider rejected as invalid → 400
 *     invalid_request_error, not a misleading rate-limit exhaustion.
 *   - Otherwise → 429 rate_limit_error.
 * All bodies carry the attempt trail (what was tried, per attempt) and the
 * soonest-cooldown-reset hint that previously only reached clients when routing
 * failed before any attempt (summarizeExhaustion) — after one attempt they got a
 * terse "Last error" line with none of that context.
 */
export function exhaustedRetryError(lastError: any, maxRetries?: number, ctx?: ExhaustionContext): ExhaustionBody {
  const safeLastError = sanitizeProviderErrorMessage(lastError?.message);
  const attempts = ctx?.attempts ?? [];
  const trail = attempts.length > 0 ? ` Attempt trail: ${formatAttemptTrail(attempts)}.` : '';
  const budgetNote = ctx?.timedOut
    ? ` (stopped early: retry time budget ${Math.round((ctx.budgetMs ?? 0) / 1000)}s exceeded)`
    : '';

  if (attempts.length > 0 && attempts.every(a => a.errorClass === 'auth')) {
    return {
      kind: 'auth',
      status: 502,
      type: 'provider_error',
      message: `All ${attempts.length} attempted provider key(s) failed authentication${budgetNote}. ` +
        'The configured upstream API key(s) look invalid or expired; they are being revalidated now and will be marked invalid automatically. ' +
        `Check the provider keys in the dashboard.${trail} Last error: ${safeLastError}`,
    };
  }

  if (isProviderBadRequestError(lastError)) {
    return {
      kind: 'bad_request',
      status: 400,
      type: 'invalid_request_error',
      message: `All routed providers rejected the request as invalid${budgetNote}.${trail} Last error: ${safeLastError}`,
    };
  }

  const attemptCount = attempts.length > 0 ? attempts.length : maxRetries;
  const scope = attemptCount == null
    ? 'All models rate-limited'
    : `All models rate-limited after ${attemptCount} attempt${attemptCount === 1 ? '' : 's'}`;
  const eta = formatResetEta(getSoonestCooldownExpiry());
  const etaNote = eta ? ` Soonest cooldown reset ${eta}.` : '';
  return {
    kind: 'rate_limit',
    status: 429,
    type: 'rate_limit_error',
    message: `${scope}${budgetNote}.${etaNote}${trail} Last error: ${safeLastError}`,
  };
}

// What a surface's dispatch() returns to signal the response is finished and the
// loop must stop:
//   'done'      — the attempt succeeded and the full response was sent.
//   'committed' — a stream already flushed real bytes to the client, then hit a
//                 mid-stream error the surface surfaced honestly; no failover is
//                 possible, so stop without recording another retry.
export type DispatchOutcome = 'done' | 'committed';

// Per-request exhaustion metadata handed to the exhaustion hooks, so each
// surface can stamp X-Fallback-Attempts on error responses (previously
// success-only) without re-deriving the count.
export interface ExhaustionInfo {
  attempts: AttemptRecord[];
  timedOut: boolean;
}

export interface FallbackHooks {
  // Defaults to FALLBACK_MAX_RETRIES.
  maxRetries?: number;
  // Wall-clock retry budget override, mostly for tests. Defaults to
  // getFallbackTimeBudgetMs() (setting → env → 45s; 0 disables).
  timeBudgetMs?: number;
  // Skip state; recordRetryableFailure / recordAuthFailure (called by the loop)
  // mutate it, and the surface's route() reads it to exclude failed keys/models.
  state: FallbackState;

  /**
   * Pick a route for this attempt. Reads state.skipKeys / state.skipModels.
   * Throws the router's RouteError when the pool is exhausted before any
   * upstream is tried (caught by the loop → onRoutingExhausted).
   */
  route(attempt: number): RouteResult;

  /**
   * Run one attempt against the chosen route. Return 'done' on success or
   * 'committed' when a stream already sent bytes and handled its own mid-stream
   * error. THROW a (possibly synthetic) provider error — an upstream HTTP error,
   * or an "empty completion" / "unparseable inline tool-call dialect" Error the
   * classifier already treats as retryable — to trigger failover; a
   * non-retryable throw becomes onFatal. A pre-commit failure MUST throw (not
   * return 'committed') so the loop can fail over invisibly. The loop enforces
   * this contract: any other return value is a programming error and fails
   * loudly instead of silently swallowing the request.
   */
  dispatch(route: RouteResult, attempt: number): Promise<DispatchOutcome>;

  /** Trace + log a per-attempt failure (per-surface scope + logRequest args). */
  logFailure(route: RouteResult, err: any, attempt: number): void;

  /** Render a non-retryable provider error (per-surface body/status). `attempt`
   *  is the failing attempt's index = the number of prior fallback hops. */
  onFatal(route: RouteResult, err: any, attempt: number): void;

  /**
   * Render exhaustion when route() threw. `exhaustion` is the shared body when
   * at least one attempt ran (render it); null when routing gave up before any
   * upstream was tried (render routeErr as a routing error instead).
   */
  onRoutingExhausted(lastError: any, routeErr: any, exhaustion: ExhaustionBody | null, info: ExhaustionInfo): void;

  /** Render exhaustion after the attempt cap or the time budget was hit. */
  onExhausted(exhaustion: ExhaustionBody, info: ExhaustionInfo): void;
}

/**
 * The shared attempt loop. Owns iteration, the wall-clock retry budget, the
 * routeRequest-exhaustion path, the auth/retryable/fatal classification, the
 * per-failure bookkeeping (recordRetryableFailure / recordAuthFailure), the
 * attempt trail, and the final exhaustion body. Everything surface-specific —
 * request translation, stream framing, error-body shape, context handoff, group
 * routing — lives in the hooks.
 */
export async function runFallbackLoop(hooks: FallbackHooks): Promise<void> {
  const maxRetries = hooks.maxRetries ?? FALLBACK_MAX_RETRIES;
  const budgetMs = hooks.timeBudgetMs ?? getFallbackTimeBudgetMs();
  const startedAt = Date.now();
  const attempts: AttemptRecord[] = [];
  const keyOrdinals = new Map<string, number>();
  const keyOrdinal = (route: RouteResult): number => {
    const key = `${route.platform}:${route.keyId}`;
    let ord = keyOrdinals.get(key);
    if (ord === undefined) {
      ord = keyOrdinals.size + 1;
      keyOrdinals.set(key, ord);
    }
    return ord;
  };
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Wall-clock budget: refuse to START another retry once spent. The first
    // attempt always runs; a slow attempt is never aborted mid-flight (that is
    // the TODO(fallback-v2) hedging work), it just becomes the last one.
    if (attempt > 0 && budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
      hooks.onExhausted(
        exhaustedRetryError(lastError, maxRetries, { attempts, timedOut: true, budgetMs }),
        { attempts, timedOut: true },
      );
      return;
    }

    let route: RouteResult;
    try {
      route = hooks.route(attempt);
    } catch (routeErr) {
      const exhaustion = lastError
        ? exhaustedRetryError(lastError, undefined, { attempts })
        : null;
      hooks.onRoutingExhausted(lastError, routeErr, exhaustion, { attempts, timedOut: false });
      return;
    }

    let outcome: DispatchOutcome;
    try {
      outcome = await hooks.dispatch(route, attempt);
    } catch (err: any) {
      hooks.logFailure(route, err, attempt);
      if (isKeyAuthError(err)) {
        // KEY-fatal, not request-fatal: rotate past the bad key and revalidate
        // it immediately instead of 502-ing while healthy routes sit idle.
        recordAuthFailure(route, hooks.state);
        attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass: 'auth' });
        lastError = err;
        continue;
      }
      if (isRetryableError(err)) {
        recordRetryableFailure(route, err, hooks.state);
        attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass: classifyAttemptError(err) });
        lastError = err;
        continue;
      }
      hooks.onFatal(route, err, attempt);
      return;
    }

    // Enforce the dispatch contract: 'done'/'committed' mean the response is
    // finished. Anything else (a stray `return` in an adapter) would silently
    // swallow the request, so fail loudly. Deliberately OUTSIDE the try/catch:
    // the violation message embeds route.modelId, and a model id containing a
    // digit run like "2503" would match a retryable-error substring and make
    // the loop re-dispatch the buggy adapter until exhaustion. Routing straight
    // to onFatal renders an immediate 502 with no retryability classification.
    if (outcome !== 'done' && outcome !== 'committed') {
      const violation = new Error(
        `fallback-loop dispatch contract violation on ${route.platform}/${route.modelId}: ` +
        `expected 'done' or 'committed', got ${JSON.stringify(outcome)}`,
      );
      console.error('[FallbackLoop]', violation.message);
      hooks.logFailure(route, violation, attempt);
      hooks.onFatal(route, violation, attempt);
    }
    return;
  }

  hooks.onExhausted(
    exhaustedRetryError(lastError, maxRetries, { attempts }),
    { attempts, timedOut: false },
  );
}
