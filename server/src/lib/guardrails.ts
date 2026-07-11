// Request-level guardrails: two hard limits, both OFF by default so an
// unconfigured install behaves exactly as before.
//
//  1. request_max_tokens_budget — a per-request token-cost ceiling. Pre-flight:
//     estimated input (plus the flat per-image estimate) plus the requested
//     max_tokens must fit the budget, else the request is rejected with a 413
//     before any provider is tried. A request that sent NO max_tokens has its
//     output capped to the budget remainder instead of being rejected — with
//     the cap forwarded upstream, the provider's own max_tokens enforcement
//     bounds the spend, so no mid-stream truncation machinery is needed.
//
//  2. max_consecutive_upstream_fails — a per-request circuit breaker. When the
//     Nth consecutive upstream attempt fails, the whole failover chain stops
//     with a 503 instead of grinding through the remaining candidates of a
//     pool that is failing across the board (the observed worst case for a
//     doomed chain was 38.8s of serial retries; the wall-clock budget bounds
//     the time, this bounds the wasted attempts/quota).
//
// Ported from @coffcoe's fork (coffcoe/freellmapi@e5024d53) and adapted to the
// unified fallback loop: the original patched each surface's copy of the retry
// loop; here the breaker is wired once in runFallbackLoop and the budget is a
// shared pre-flight helper each surface renders in its own wire format.
//
// Precedence mirrors the response cache and the fallback time budget: the
// settings-table value wins when present (runtime-tunable, no restart), then
// the env var, then the default (0 = disabled).

import { getSetting } from '../db/index.js';

export const REQUEST_MAX_TOKENS_BUDGET_SETTING = 'request_max_tokens_budget';
export const MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING = 'max_consecutive_upstream_fails';

function readGuardrailValue(settingKey: string, envKey: string): number {
  let stored: string | undefined;
  try {
    stored = getSetting(settingKey);
  } catch {
    stored = undefined; // DB not ready — never throw on the proxy hot path
  }
  for (const raw of [stored, process.env[envKey]]) {
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return 0;
}

/** Per-request token budget ceiling; 0 = disabled. */
export function getRequestMaxTokensBudget(): number {
  return readGuardrailValue(REQUEST_MAX_TOKENS_BUDGET_SETTING, 'REQUEST_MAX_TOKENS_BUDGET');
}

/** Consecutive-upstream-failure breaker threshold; 0 = disabled. */
export function getMaxConsecutiveUpstreamFails(): number {
  return readGuardrailValue(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, 'MAX_CONSECUTIVE_UPSTREAM_FAILS');
}

// ── Token budget (pre-flight) ────────────────────────────────────────────────

export interface TokenBudgetRejection {
  budget: number;
  estimatedTotal: number;
}

export interface TokenBudgetResult {
  rejection: TokenBudgetRejection | null;
  /** The max_tokens to forward upstream: unchanged when the client set one,
   *  capped to the budget remainder when it didn't. */
  maxTokens: number | undefined;
}

/**
 * Apply the per-request token budget to one request. `estimatedInputTokens`
 * is the surface's existing input estimate (~4 chars/token, images at the
 * flat per-image estimate); `maxTokens` is the client-requested output cap,
 * possibly undefined on the OpenAI-shaped surfaces.
 */
export function applyTokenBudget(estimatedInputTokens: number, maxTokens: number | undefined): TokenBudgetResult {
  const budget = getRequestMaxTokensBudget();
  if (budget <= 0) return { rejection: null, maxTokens };
  const estimatedTotal = estimatedInputTokens + (maxTokens ?? 0);
  if (estimatedTotal > budget) return { rejection: { budget, estimatedTotal }, maxTokens };
  if (maxTokens == null) {
    const remaining = budget - estimatedInputTokens;
    // Input alone fills the whole budget: nothing left for output.
    if (remaining < 1) return { rejection: { budget, estimatedTotal }, maxTokens };
    return { rejection: null, maxTokens: remaining };
  }
  return { rejection: null, maxTokens };
}

export function tokenBudgetMessage(r: TokenBudgetRejection): string {
  return `Request exceeds the per-request token budget guardrail: ~${r.estimatedTotal} tokens ` +
    `(estimated input + requested output) over a budget of ${r.budget}. Trim the prompt or lower ` +
    `max_tokens, or raise the ${REQUEST_MAX_TOKENS_BUDGET_SETTING} setting (0 disables it).`;
}

// ── Circuit breaker (one per request, threaded through the fallback loop) ────

export interface BreakerState {
  limit: number;
  consecutive: number;
}

export function newBreaker(limit: number = getMaxConsecutiveUpstreamFails()): BreakerState {
  return { limit, consecutive: 0 };
}

/**
 * Record one failed upstream attempt. Returns true when the breaker trips
 * (the recorded failure reached the limit). No-op returning false when the
 * guardrail is disabled (limit <= 0).
 */
export function recordBreakerFailure(state: BreakerState): boolean {
  if (state.limit <= 0) return false;
  state.consecutive += 1;
  return state.consecutive >= state.limit;
}
