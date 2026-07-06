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
// Pure control-flow + accounting: no Express, no wire-format knowledge. The
// per-surface bytes (SSE framing, error-body shape, context handoff, group
// routing) live in the caller's hooks, so this stays reviewable as unification.

import type { RouteResult } from '../services/router.js';
import { recordRateLimitHit, recordSuccess, hasOtherUsableKey } from '../services/router.js';
import {
  recordRequest,
  recordTokens,
  setCooldown,
  getCooldownDurationForLimit,
  PAYMENT_REQUIRED_COOLDOWN_MS,
  MODEL_FORBIDDEN_COOLDOWN_MS,
  learnLimitFromError,
} from '../services/ratelimit.js';
import {
  isRetryableError,
  isPaymentRequiredError,
  isModelNotFoundError,
  isModelAccessForbiddenError,
  isProviderBadRequestError,
} from './error-classify.js';
import { sanitizeProviderErrorMessage } from './error-redaction.js';

// Every surface caps failover hops at the same number.
export const FALLBACK_MAX_RETRIES = 20;

// Mutable per-request skip state threaded through the loop and mutated by
// recordRetryableFailure. skipKeys entries are "platform:modelId:keyId";
// skipModels holds model_db_ids ruled out for the rest of this request.
export interface FallbackState {
  skipKeys: Set<string>;
  skipModels: Set<number>;
}

export function newFallbackState(): FallbackState {
  return { skipKeys: new Set<string>(), skipModels: new Set<number>() };
}

/**
 * The one true cooldown-duration selection after a retryable upstream failure:
 *   - 402 out-of-credits  → a full day (PAYMENT_REQUIRED_COOLDOWN_MS)
 *   - 403 model-not-on-tier → a full day (MODEL_FORBIDDEN_COOLDOWN_MS), because a
 *     tier/subscription gate won't clear on the next minute window (issue #256)
 *   - anything else → the transient/daily escalation ladder, honoring the
 *     provider's Retry-After as a floor (getCooldownDurationForLimit).
 *
 * Convergence: /v1/responses previously skipped BOTH the 403 day-bench (it fell
 * through to the 90s transient) AND the Retry-After floor. Now every surface
 * benches identically.
 */
export function cooldownForError(route: RouteResult, err: any): number {
  if (isPaymentRequiredError(err)) return PAYMENT_REQUIRED_COOLDOWN_MS;
  if (isModelAccessForbiddenError(err)) return MODEL_FORBIDDEN_COOLDOWN_MS;
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
 * Callers add the just-failed key to skipKeys via this function (do not pre-add).
 */
export function recordRetryableFailure(route: RouteResult, err: any, state: FallbackState): void {
  if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) {
    state.skipModels.add(route.modelDbId);
  }
  state.skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
  setCooldown(route.platform, route.modelId, route.keyId, cooldownForError(route, err));
  // Model-level penalty only when no sibling key can still serve (#454).
  if (!hasOtherUsableKey(route.modelDbId, route.keyId, state.skipKeys)) {
    recordRateLimitHit(route.modelDbId);
  }
  learnLimitFromError(route.modelDbId, err);
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

export interface ExhaustionBody {
  status: number;
  type: string;
  message: string;
}

/**
 * The shared exhaustion response body. A request every routed provider rejected
 * as invalid (isProviderBadRequestError) is a client error → 400
 * invalid_request_error, not a misleading rate-limit exhaustion; otherwise 429
 * rate_limit_error. The two `type` strings are valid error types on the OpenAI,
 * Responses AND Anthropic surfaces, so all four call sites render this directly.
 *
 * Convergence: /v1/messages used to hand-roll a fixed 429 here, losing the 400
 * branch. (Moved out of routes/proxy.ts, which re-exports it for compatibility.)
 */
export function exhaustedRetryError(lastError: any, maxRetries?: number): ExhaustionBody {
  const safeLastError = sanitizeProviderErrorMessage(lastError?.message);
  if (isProviderBadRequestError(lastError)) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: `All routed providers rejected the request as invalid. Last error: ${safeLastError}`,
    };
  }
  const scope = maxRetries == null
    ? 'All models rate-limited'
    : `All models rate-limited after ${maxRetries} attempts`;
  return {
    status: 429,
    type: 'rate_limit_error',
    message: `${scope}. Last error: ${safeLastError}`,
  };
}

// What a surface's dispatch() returns to signal the response is finished and the
// loop must stop:
//   'done'      — the attempt succeeded and the full response was sent.
//   'committed' — a stream already flushed real bytes to the client, then hit a
//                 mid-stream error the surface surfaced honestly; no failover is
//                 possible, so stop without recording another retry.
export type DispatchOutcome = 'done' | 'committed';

export interface FallbackHooks {
  // Defaults to FALLBACK_MAX_RETRIES.
  maxRetries?: number;
  // Skip state; recordRetryableFailure (called by the loop) mutates it, and the
  // surface's route() reads it to exclude failed keys/models.
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
   * return 'committed') so the loop can fail over invisibly.
   */
  dispatch(route: RouteResult, attempt: number): Promise<DispatchOutcome>;

  /** Trace + log a per-attempt failure (per-surface scope + logRequest args). */
  logFailure(route: RouteResult, err: any, attempt: number): void;

  /** Render a non-retryable provider error (per-surface body/status). */
  onFatal(route: RouteResult, err: any): void;

  /**
   * Render exhaustion when route() threw. `lastError` is the last upstream error
   * if any attempt ran, else null (routing gave up before trying anything).
   */
  onRoutingExhausted(lastError: any, routeErr: any): void;

  /** Render exhaustion after all attempts were tried and failed. */
  onExhausted(lastError: any): void;
}

/**
 * The shared attempt loop. Owns iteration, the routeRequest-exhaustion path, the
 * retryable-vs-fatal classification, the per-failure bookkeeping
 * (recordRetryableFailure), and the final exhaustion path. Everything
 * surface-specific — request translation, stream framing, error-body shape,
 * context handoff, group routing — lives in the hooks.
 */
export async function runFallbackLoop(hooks: FallbackHooks): Promise<void> {
  const maxRetries = hooks.maxRetries ?? FALLBACK_MAX_RETRIES;
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let route: RouteResult;
    try {
      route = hooks.route(attempt);
    } catch (routeErr) {
      hooks.onRoutingExhausted(lastError, routeErr);
      return;
    }

    try {
      // 'done' or 'committed' — either way the response is finished.
      await hooks.dispatch(route, attempt);
      return;
    } catch (err: any) {
      hooks.logFailure(route, err, attempt);
      if (isRetryableError(err)) {
        recordRetryableFailure(route, err, hooks.state);
        lastError = err;
        continue;
      }
      hooks.onFatal(route, err);
      return;
    }
  }

  hooks.onExhausted(lastError);
}
