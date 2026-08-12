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
import { recordRateLimitHit, recordModelFailure, recordSuccess, hasOtherUsableKey, routableKeyIdsForModel, formatResetEta } from '../services/router.js';
import { safeHeaderValue } from './header-value.js';
import {
  recordRequest,
  recordTokens,
  setCooldown,
  getActiveCooldownsForKeys,
  getCooldownDecisionForLimit,
  getSoonestCooldownExpiry,
  PAYMENT_REQUIRED_COOLDOWN_MS,
  MODEL_FORBIDDEN_COOLDOWN_MS,
  learnLimitFromError,
  type CooldownDecision,
} from '../services/ratelimit.js';
import {
  isRetryableError,
  isRateLimitSignal,
  isKeyAuthError,
  isClientAbortError,
  isHedgeAbortError,
  isDailyQuotaExhaustedError,
  isPaymentRequiredError,
  isModelNotFoundError,
  isModelAccessForbiddenError,
  isProviderBadRequestError,
  isProviderDegradedError,
  isProviderLevelError,
  isContextTooLargeError,
  isTimeoutErrorText,
} from './error-classify.js';
import { sanitizeProviderErrorMessage, summarizeAttemptError } from './error-redaction.js';
import { checkKeyHealth, markKeyHealthyFromRequest } from '../services/health.js';
import { noteModelRetirementSignal } from '../services/model-retirement.js';
import { getSetting } from '../db/index.js';
import { newBreaker, recordBreakerFailure } from './guardrails.js';
import { getRequestTrace, newRequestTrace, runWithRequestTrace, type AttemptOutcome, type AttemptTraceRecord, type RequestTrace } from './attempt-trace.js';
import { logRequest, persistRequestAttempts } from './request-log.js';
import { withKeyProxy } from './proxy.js';

// Every surface caps failover hops at the same number.
export const FALLBACK_MAX_RETRIES = 20;

// ── Model-level failure benching ─────────────────────────────────────────────
// A model that keeps failing upstream (401/429/5xx/empty-stream/timeout) must
// not keep being picked by auto-routing: every dead-end attempt wastes seconds
// of user-visible latency. The per-key cooldown above benches the *key*; this
// is the model-level counterpart — a sliding window of failures *across keys*
// that benches the whole MODEL once the streak is convincing. The window counts
// across keys, so the bench must span keys too: benching only the key that
// happened to fail last leaves every sibling key serving the same sick model
// until each one trips its own streak. Recovery stays automatic: the bench is
// 'heuristic', the only source the cooldown-probe job may clear early, and it
// re-validates each benched key once half the bench has been served (the probe
// exercises the credential, not the model, so a model still sick behind a good
// key simply re-trips the streak). Client-cancels never reach
// recordRetryableFailure (the loop returns on isClientAbortError before this
// bookkeeping), so they don't count.
export const MODEL_FAILURE_WINDOW_MS = 15 * 60 * 1000;   // sliding window: 15 min
export const MODEL_FAILURE_THRESHOLD = 3;         // failures within window
export const MODEL_FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // bench duration: 10 min
const modelFailureTimestamps = new Map<number, number[]>(); // model_db_id → times

/** Record one retryable upstream failure for a model. Once the sliding window
 *  holds ≥ MODEL_FAILURE_THRESHOLD failures, bench the model on EVERY key that
 *  can route to it so the model sinks out of routing until upstream heals, then
 *  reset the counter (one bench per streak). */
function noteModelFailure(route: RouteResult, now: number): void {
  const window = (modelFailureTimestamps.get(route.modelDbId) ?? [])
    .filter(t => now - t < MODEL_FAILURE_WINDOW_MS);
  window.push(now);
  modelFailureTimestamps.set(route.modelDbId, window);
  if (window.length < MODEL_FAILURE_THRESHOLD) return;
  // Fall back to the failing key alone when the model's key set can't be read
  // (model row gone, DB unavailable) — a narrower bench beats none.
  const keyIds = routableKeyIdsForModel(route.modelDbId);
  const targets = keyIds.length > 0 ? keyIds : [route.keyId];
  const benchUntil = now + MODEL_FAILURE_COOLDOWN_MS;
  const active = getActiveCooldownsForKeys(targets, now);
  for (const keyId of targets) {
    // Never SHORTEN an existing bench: a provider-stated reset or an escalated
    // ladder step outlasting this window knows more than this heuristic does,
    // and overwriting it would also drop its non-probeable provenance.
    const current = active.get(keyId)
      ?.find(c => c.platform === route.platform && c.modelId === route.modelId);
    if (current && current.expiresAtMs >= benchUntil) continue;
    setCooldown(route.platform, route.modelId, keyId, MODEL_FAILURE_COOLDOWN_MS, 'heuristic');
  }
  modelFailureTimestamps.delete(route.modelDbId);
}

/** A served request is the strongest counter-evidence: clear the failure
 *  window so a recovered model is not benched for a stale streak. */
function clearModelFailure(route: RouteResult): void {
  modelFailureTimestamps.delete(route.modelDbId);
}

// ── Wall-clock retry budget ──────────────────────────────────────────────────
// Serial failover has no time bound of its own: the observed worst case was a
// 38.8s TTFB over 11 attempts, and the theoretical worst is maxRetries x the
// per-attempt HTTP timeout. The budget is checked before STARTING each retry,
// so one slow attempt is never aborted mid-flight — it just becomes the last
// one. The first attempt always runs, and so does the FIRST retry: when
// attempt 0 alone consumes the whole budget (a slow-failing model), refusing
// attempt 1 would make failover structurally impossible for exactly the
// requests that need it (#751). The budget stops attempts >= 2 only.
// 0 disables the budget entirely.
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
// rest of this request; skipPlatforms holds platforms ruled out wholesale
// (#788) — every model and every key of them — for the rest of this request.
// All three are request-scoped only: nothing here outlives the response, so a
// provider that blipped once is a fresh candidate on the very next request.
export interface FallbackState {
  skipKeys: Set<string>;
  skipModels: Set<number>;
  skipPlatforms: Set<string>;
}

export function newFallbackState(): FallbackState {
  return { skipKeys: new Set<string>(), skipModels: new Set<number>(), skipPlatforms: new Set<string>() };
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
  return cooldownDecisionForError(route, err).durationMs;
}

/**
 * cooldownForError plus the provenance tag the cooldown-probe recovery job
 * keys off (see CooldownSource in services/ratelimit.ts): 402 → 'credit' and
 * 403 → 'tier' (a key-validation probe passing proves nothing about credits or
 * tier, so those are never probed); a daily-quota bench → 'authoritative' (the
 * expiry is the provider's own reset time, whether from Retry-After or the
 * UTC-midnight convention — a fact, not a guess); everything else defers to
 * getCooldownDecisionForLimit, which tags 'authoritative' only when an explicit
 * Retry-After actually determined the expiry.
 */
export function cooldownDecisionForError(route: RouteResult, err: any): CooldownDecision {
  if (isPaymentRequiredError(err)) return { durationMs: PAYMENT_REQUIRED_COOLDOWN_MS, source: 'credit' };
  if (isModelAccessForbiddenError(err)) return { durationMs: MODEL_FORBIDDEN_COOLDOWN_MS, source: 'tier' };
  if (isDailyQuotaExhaustedError(err)) {
    return { durationMs: err?.retryAfterMs ?? msUntilNextUtcMidnight(), source: 'authoritative' };
  }
  return getCooldownDecisionForLimit(
    route.platform,
    route.modelId,
    route.keyId,
    { rpd: route.rpdLimit, tpd: route.tpdLimit },
    err?.retryAfterMs,
    // Only a real 429/rate-limit error may feed the null-limits exhaustion
    // heuristic; a timeout or 5xx is retryable but says nothing about quota,
    // so it stays on the short transient bench instead of the ladder (#592).
    { quotaSignal: isRateLimitSignal(err) },
  );
}

// ── Empty-completion streak (issue #751) ─────────────────────────────────────
// The skipBench exemption below assumes an empty 'length' completion is
// REQUEST behavior (this turn's max_tokens spent on hidden reasoning). A
// model+key that produces them consecutively is broken, not unlucky — with an
// unconditional exemption it stayed penalty-free forever while failing every
// request routed to it. At the streak limit the exemption lifts and the
// failure takes the normal cooldown/penalty/limit-learning path (and counts
// toward the breaker). Format violations (skipModelForRequest) never accrue:
// they are model behavior for THIS request's response_format, not key health.
export const EMPTY_COMPLETION_STREAK_LIMIT = 3;
const emptyCompletionStreaks = new Map<string, number>(); // "platform:modelId:keyId"

export function resetEmptyCompletionStreaks(): void {
  emptyCompletionStreaks.clear();
}

/** Drop every model's sliding failure window. Module state outlives a test
 *  case, so without this a case inherits the previous one's failure counts and
 *  trips the threshold early — clearing `rate_limit_cooldowns` alone does not
 *  reach it. */
export function resetModelFailureWindows(): void {
  modelFailureTimestamps.clear();
}

// Advance (or break) the streak for this failure and report whether the
// skipBench exemption still holds. Called exactly once per retryable failure,
// from recordRetryableFailure; the loop reuses its returned decision for the
// breaker so the two consumers can never disagree.
function consumeSkipBenchExemption(route: RouteResult, err: any): boolean {
  const key = `${route.platform}:${route.modelId}:${route.keyId}`;
  if (err?.skipBench !== true) {
    // A normally-penalized failure breaks the streak: the cooldown ladder is
    // already handling whatever is wrong with this model+key.
    emptyCompletionStreaks.delete(key);
    return false;
  }
  if (err?.skipModelForRequest === true) return true;
  const streak = (emptyCompletionStreaks.get(key) ?? 0) + 1;
  emptyCompletionStreaks.set(key, streak);
  return streak < EMPTY_COMPLETION_STREAK_LIMIT;
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
 * healthy models a 90s cooldown + a scorer penalty per truncated turn. The
 * exemption is streak-bounded (#751): from the EMPTY_COMPLETION_STREAK_LIMITth
 * consecutive empty completion on the same model+key it stops applying, until
 * a success (or a normally-penalized failure) resets the streak.
 *
 * Returns whether the skipBench exemption held for this failure, so the loop
 * can keep the breaker in lockstep with the bench decision.
 *
 * Callers add the just-failed key to skipKeys via this function (do not pre-add).
 */
export function recordRetryableFailure(route: RouteResult, err: any, state: FallbackState, now: number = Date.now()): boolean {
  // `skipModelForRequest: true` = the failure is MODEL behavior, not key
  // state (ignored response_format, JSON truncated at max_tokens): a sibling
  // key would reproduce it exactly, so rule out the whole model for this
  // request instead of burning one failover hop per key.
  // Context-too-large is MODEL-level too: a sibling key serves the same model
  // with the same context window (and, for Groq-style per-key TPM 413s, the
  // same tier ceiling), so it would reject the same request identically.
  if (isModelNotFoundError(err) || isModelAccessForbiddenError(err) || isContextTooLargeError(err) || err?.skipModelForRequest === true) {
    state.skipModels.add(route.modelDbId);
  }
  // A model-level 404/410 that says the model is GONE (not merely missing right
  // now) outlives this request: persist it once the evidence is strong enough,
  // or the retired model burns a fallback slot on every request forever (#634).
  // The trace object identifies the request, so one request's failover across
  // sibling keys counts as the single observation it is.
  noteModelRetirementSignal(route, err, getRequestTrace());
  state.skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
  // #788: provider-level failures (5xx / timeout / transport / degraded) mean
  // the PROVIDER is sick, not this key — every key AND every model of that
  // platform would fail identically. Rule out the whole platform for this
  // request so the loop moves to the NEXT provider instead of burning one
  // failover hop per key. Key-scoped failures (auth/quota) stay on the
  // single-key path, and the per-key cooldown below is still the only thing
  // that outlives the request.
  if (isProviderLevelError(err)) {
    state.skipPlatforms.add(route.platform);
  }
  if (consumeSkipBenchExemption(route, err)) return true;
  const decision = cooldownDecisionForError(route, err);
  setCooldown(route.platform, route.modelId, route.keyId, decision.durationMs, decision.source);
  // Model-level failure benching: a model failing across keys (or repeatedly on
  // one key) must sink out of routing instead of being re-picked every request.
  noteModelFailure(route, now);
  // Model-level penalty only when no sibling key can still serve (#454).
  if (!hasOtherUsableKey(route.modelDbId, route.keyId, state.skipKeys)) {
    // Hard limit signals (429/402) carry the heavier demotion; ordinary
    // upstream failures (5xx/timeout/empty stream) get a lighter one so the
    // model sinks gradually instead of being banished on a single blip.
    if (isRateLimitSignal(err)) {
      recordRateLimitHit(route.modelDbId);
    } else {
      recordModelFailure(route.modelDbId);
    }
  }
  learnLimitFromError(route.modelDbId, err);
  return false;
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
  // A served request proves the model+key can complete: the empty-completion
  // streak (#751) starts over.
  emptyCompletionStreaks.delete(`${route.platform}:${route.modelId}:${route.keyId}`);
  // A served request is the strongest possible evidence the model works, so
  // clear any model-level failure streak that could bench it later.
  clearModelFailure(route);
  // A served request is the strongest possible evidence the key works, so clear
  // any stale 'error' status left by an earlier transport blip instead of waiting
  // for the next health pass to make the key routable again.
  markKeyHealthyFromRequest(route.keyId);
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
  | 'context_too_large'
  | 'provider_bad_request'
  | 'empty_completion'
  | 'format_ignored'
  | 'invalid_tool_arguments'
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
  // Before the bad-request check: OpenAI-compat context errors arrive as
  // "API error 400: This model's maximum context length is …", which the
  // generic provider_bad_request rule would otherwise swallow.
  if (isContextTooLargeError(err)) return 'context_too_large';
  // A DEGRADED-function 400 (NVIDIA NIM, #522) is provider health, not request
  // shape — keep it out of provider_bad_request so the trail reads honestly.
  if (isProviderDegradedError(err)) return 'upstream_error';
  if (isProviderBadRequestError(err)) return 'provider_bad_request';
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('empty completion')) return 'empty_completion';
  if (msg.includes('ignored response_format') || msg.includes('truncated json')) return 'format_ignored';
  // Before the generic classes so the trail names the real cause rather than
  // booking a schema violation as a bare 'error'.
  if (msg.includes('invalid tool arguments')) return 'invalid_tool_arguments';
  if (isTimeoutErrorText(msg)) return 'timeout';
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota')) return 'rate_limited';
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status >= 500 || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('unavailable') || msg.includes('internal server error')) return 'upstream_error';
  return 'error';
}

const TRAIL_MAX_SHOWN = 10;
const TRAIL_HEADER_MAX_LENGTH = 1024;

// ── Detailed failover trace header (opt-in) ──────────────────────────────────
// X-Fallback-Trail already tells a caller WHICH hops burned and WHY, but not
// how long they cost. That is the part an agent cannot reconstruct: a request
// answered in 40s reads identically whether one provider stalled for 39s or
// four failed fast. The per-hop timings and the redacted provider message are
// already collected for the request_attempts table; this exposes them on the
// response so the caller sees them without a dashboard round trip.
//
// Off by default. It widens what an already-loopback-ish surface reveals —
// hop timings plus provider error text — so it is opt-in like the discovery
// aliases, not something a default install starts emitting. Precedence matches
// the failover budget above: settings-table value, then env var, then off.
export const EXPOSE_FALLBACK_DETAIL_SETTING = 'expose_fallback_detail_header';

// Ten hops of "platform/model keyN=class t=…+…ms msg=…" with a capped message
// each. Kept well under the 8 KB total header budget that proxies commonly
// enforce, since this rides alongside X-Fallback-Trail's own 1 KB.
const DETAIL_HEADER_MAX_LENGTH = 2048;
// summarizeAttemptError caps at 200; the header wants a tighter budget so ten
// hops still fit. The full text remains in request_attempts either way.
const DETAIL_SUMMARY_MAX_LENGTH = 120;

export function isFallbackDetailHeaderEnabled(): boolean {
  let stored: string | undefined;
  try {
    stored = getSetting(EXPOSE_FALLBACK_DETAIL_SETTING);
  } catch {
    stored = undefined; // DB not ready — never throw on the proxy hot path
  }
  for (const raw of [stored, process.env.FALLBACK_DETAIL_HEADER]) {
    if (raw === undefined || raw.trim() === '') continue;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true';
  }
  return false;
}

/**
 * One `platform/model keyN=outcome t=<start>+<duration>ms msg=<summary>` segment
 * per hop, `; `-joined — the same leading shape as X-Fallback-Trail so the two
 * headers line up when read together.
 *
 * The summary is the already-redacted `errorSummary`, never `err.message`. Its
 * semicolons become commas because `; ` is the record separator; nothing else
 * is escaped, which keeps the value readable, and `safeHeaderValue` handles any
 * non-ASCII on the way out.
 */
export function formatAttemptDetail(records: AttemptTraceRecord[]): string {
  const shown = records.slice(0, TRAIL_MAX_SHOWN).map(r => {
    const parts = [
      `${r.platform}/${r.modelId}`,
      `key${r.keyOrdinal}=${r.outcome}`,
      `t=${r.startOffsetMs}+${r.durationMs}ms`,
    ];
    if (r.errorSummary) {
      parts.push(`msg=${r.errorSummary.slice(0, DETAIL_SUMMARY_MAX_LENGTH).replace(/;/g, ',')}`);
    }
    return parts.join(' ');
  });
  const extra = records.length - shown.length;
  return shown.join('; ') + (extra > 0 ? `; +${extra} more` : '');
}

export function formatAttemptTrail(attempts: AttemptRecord[]): string {
  const shown = attempts
    .slice(0, TRAIL_MAX_SHOWN)
    .map(a => `${a.platform}/${a.modelId} key${a.keyOrdinal}: ${a.errorClass}`);
  const extra = attempts.length - shown.length;
  return shown.join('; ') + (extra > 0 ? `; +${extra} more` : '');
}

/**
 * Set the failover diagnostics headers every surface stamps on its responses:
 * X-Fallback-Attempts (how many hops failed before this response) and
 * X-Fallback-Trail (what each hop was and why it failed). Until now the trail
 * only reached clients inside exhaustion error MESSAGES — a request that
 * eventually succeeded gave no hint that it burned five hops first, which is
 * exactly the case an operator wants to notice. Values go through
 * safeHeaderValue so a non-ASCII or control-laden model id can neither inject
 * header lines nor make Node reject the response outright (#619).
 *
 * When EXPOSE_FALLBACK_DETAIL_SETTING is on, X-Fallback-Detail joins them with
 * per-hop timings and the redacted provider message. Every caller runs inside
 * the request's AsyncLocalStorage scope, so the trace is readable here without
 * threading it through all five surfaces.
 *
 * Note what the detail header can and cannot contain: at flush time the trace
 * holds exactly the hops that already FAILED, each with final timings. The hop
 * currently being served is recorded only after dispatch returns — after
 * res.json(), or after the whole stream has finished — so its duration is not
 * knowable while headers are still open, on either path.
 */
export function setFallbackHeaders(
  res: { setHeader(name: string, value: string): void },
  failedAttempts: number,
  trail: AttemptRecord[] | undefined,
): void {
  if (failedAttempts > 0) res.setHeader('X-Fallback-Attempts', String(failedAttempts));
  if (trail && trail.length > 0) {
    const value = trail
      .slice(0, TRAIL_MAX_SHOWN)
      .map(a => `${a.platform}/${a.modelId} key${a.keyOrdinal}=${a.errorClass}`)
      .join('; ') + (trail.length > TRAIL_MAX_SHOWN ? `; +${trail.length - TRAIL_MAX_SHOWN} more` : '');
    // Ten hops of "platform/model keyN=class" outgrow the default cap, so the
    // trail gets its own budget.
    res.setHeader('X-Fallback-Trail', safeHeaderValue(value, TRAIL_HEADER_MAX_LENGTH));
  }

  // Checked before the setting so the overwhelmingly common no-failover request
  // never pays for a settings read.
  const records = getRequestTrace()?.records;
  if (records && records.length > 0 && isFallbackDetailHeaderEnabled()) {
    res.setHeader('X-Fallback-Detail', safeHeaderValue(formatAttemptDetail(records), DETAIL_HEADER_MAX_LENGTH));
  }
}

export interface ExhaustionBody {
  status: number;
  type: string;
  message: string;
  // Coarse class of the exhaustion, for surfaces that need to remap `type` to
  // their own wire vocabulary (the Anthropic route maps 'auth' → 'api_error',
  // 'unavailable' → 'overloaded_error', 'context_too_large' →
  // 'request_too_large', 'model_not_found' → 'not_found_error', 'upstream' →
  // 'api_error').
  kind: 'auth' | 'bad_request' | 'rate_limit' | 'unavailable' | 'context_too_large' | 'model_not_found' | 'upstream';
  // Machine-readable code for the OpenAI-compatible error object.
  code?: string;
  // 429 exhaustions only: epoch ms of the earliest moment any benched candidate
  // becomes available again (soonest cooldown expiry). Rendered in the error
  // body and as a Retry-After header (seconds, ceil) by setExhaustionHeaders.
  retryAtMs?: number;
}

/**
 * The OpenAI-compatible `error` object for an exhaustion body — shared by every
 * OpenAI-shaped surface so the wire shape (message/type/code/retryAtMs) cannot
 * drift between them.
 */
export function exhaustionErrorPayload(body: ExhaustionBody): { message: string; type: string; code?: string; retryAtMs?: number } {
  const payload: { message: string; type: string; code?: string; retryAtMs?: number } = {
    message: body.message,
    type: body.type,
  };
  if (body.code) payload.code = body.code;
  if (body.retryAtMs != null) payload.retryAtMs = body.retryAtMs;
  return payload;
}

/**
 * Stamp the standard retry headers for an exhaustion body: a Retry-After of
 * ceil((retryAtMs - now) / 1000) seconds when the body carries a concrete
 * retry time. Callers must only invoke this before headers are flushed (i.e.
 * never on a committed SSE stream).
 */
export function setExhaustionHeaders(
  res: { setHeader(name: string, value: string): void },
  body: ExhaustionBody,
  now = Date.now(),
): void {
  if (body.retryAtMs == null) return;
  res.setHeader('Retry-After', String(Math.max(0, Math.ceil((body.retryAtMs - now) / 1000))));
}

export interface ExhaustionContext {
  attempts?: AttemptRecord[];
  // True when the wall-clock retry budget stopped the loop before maxRetries.
  timedOut?: boolean;
  budgetMs?: number;
  // Set (to the failure count) when the circuit-breaker guardrail stopped the
  // loop; renders as a 503 instead of a rate-limit exhaustion.
  breakerFails?: number;
}

// Attempt classes that mean "this candidate is unavailable until a KNOWN time"
// — a rate-limit window, a benched daily allocation, an out-of-credits key
// (day bench), or a tier-forbidden model (day bench). When EVERY attempt is in
// this family the pool recovers by itself, so the honest exhaustion is a 429
// with a concrete retry time. Anything else in the mix (a 5xx, a timeout, a
// vanished model) means waiting is not a promise, so the mixed case renders a
// 502 instead.
const UNAVAILABLE_UNTIL_KNOWN_TIME: ReadonlySet<AttemptErrorClass> = new Set([
  'rate_limited',
  'daily_quota_exhausted',
  'out_of_credits',
  'forbidden',
]);

/**
 * The shared exhaustion response body — the single failure-kind → terminal-
 * status ladder every surface renders. Aggregated over the per-attempt failure
 * classes (most-specific first):
 *   - Every attempt failed auth (401/invalid key) → 502 provider_error saying the
 *     PROVIDER keys are bad — distinct from a rate-limit exhaustion, and never
 *     'authentication_error' (which would wrongly blame the CLIENT's key).
 *   - Every attempt died on a context/prompt-too-large rejection → 413: no
 *     candidate can fit this request; retrying cannot help, shrinking it can.
 *   - Every attempt got a model-not-found/gone from its provider → 404: the
 *     model has been removed upstream everywhere we route it. (No 410 — the
 *     catalog keeps no removal tombstones, so "verifiably existed before" is
 *     not determinable here.)
 *   - A chain that died on a DEGRADED-function 400 (NVIDIA NIM, #522) → 503:
 *     provider capacity, not a bad request.
 *   - A request every routed provider rejected as invalid → 400
 *     invalid_request_error, not a misleading rate-limit exhaustion.
 *   - Circuit-breaker stop → 503 (the pool looks unhealthy; retry later).
 *   - Every attempt unavailable-until-known-time (rate limits, benched
 *     quotas/credits/tiers) → 429 rate_limit_error with `retryAtMs` (soonest
 *     cooldown expiry) for a matching Retry-After header.
 *   - Mixed/other upstream failures (5xx, timeouts, transport errors) → 502
 *     provider_error: the UPSTREAMS failed. Never 500 — that status is
 *     reserved for our own bugs.
 * All bodies carry the attempt trail (what was tried, per attempt) and, where
 * meaningful, the soonest-cooldown-reset hint.
 */
export function exhaustedRetryError(lastError: any, maxRetries?: number, ctx?: ExhaustionContext): ExhaustionBody {
  const safeLastError = sanitizeProviderErrorMessage(lastError?.message);
  const attempts = ctx?.attempts ?? [];
  const trail = attempts.length > 0 ? ` Attempt trail: ${formatAttemptTrail(attempts)}.` : '';
  const budgetNote = ctx?.timedOut
    ? ` (stopped early: retry time budget ${Math.round((ctx.budgetMs ?? 0) / 1000)}s exceeded — one failover hop is always allowed, and past that the budget stops starting further retries and cancels an attempt still waiting on its first byte; raise FALLBACK_TIME_BUDGET_MS or the fallback_time_budget_ms setting to allow a longer failover chain)`
    : '';
  const everyAttempt = (cls: AttemptErrorClass | ReadonlySet<AttemptErrorClass>): boolean =>
    attempts.length > 0 && attempts.every(a => (cls instanceof Set ? cls.has(a.errorClass) : a.errorClass === cls));

  if (everyAttempt('auth')) {
    return {
      kind: 'auth',
      status: 502,
      type: 'provider_error',
      code: 'provider_authentication_failed',
      message: `All ${attempts.length} attempted provider key(s) failed authentication${budgetNote}. ` +
        'The configured upstream API key(s) look invalid or expired; they are being revalidated now and will be marked invalid automatically. ' +
        `Check the provider keys in the dashboard.${trail} Last error: ${safeLastError}`,
    };
  }

  // Aggregate diagnoses before the lastError-shape ones below: when EVERY
  // attempt failed the same way, that unanimity is stronger evidence than the
  // shape of whichever error happened to come last.
  if (everyAttempt('context_too_large')) {
    return {
      kind: 'context_too_large',
      status: 413,
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: `The request is too large for every routed candidate: all ${attempts.length} attempt(s) were rejected as ` +
        `over the model's context/size limit${budgetNote}. Retrying will not help — reduce the prompt/history size or ` +
        `enable a larger-context model.${trail} Last error: ${safeLastError}`,
    };
  }

  if (everyAttempt('model_not_found')) {
    return {
      kind: 'model_not_found',
      status: 404,
      type: 'invalid_request_error',
      code: 'model_not_found',
      message: `Every routed provider reports the model as not found or removed upstream (${attempts.length} attempt(s))` +
        `${budgetNote}. The catalog entry looks stale; pick another model or call /v1/models for the available list.` +
        `${trail} Last error: ${safeLastError}`,
    };
  }

  // A chain that died on a DEGRADED-function 400 (NVIDIA NIM, #522) is a
  // provider-capacity outage, not a bad request: render 503 so clients retry
  // later instead of "fixing" a request that was never broken.
  if (isProviderDegradedError(lastError)) {
    return {
      kind: 'unavailable',
      status: 503,
      type: 'service_unavailable',
      code: 'provider_degraded',
      message: `The routed provider reported the model's hosted deployment as temporarily degraded${budgetNote}. ` +
        `This is a provider-side condition; retry later or route to another provider.${trail} Last error: ${safeLastError}`,
    };
  }

  if (isProviderBadRequestError(lastError)) {
    return {
      kind: 'bad_request',
      status: 400,
      type: 'invalid_request_error',
      code: 'provider_rejected_request',
      message: `All routed providers rejected the request as invalid${budgetNote}.${trail} Last error: ${safeLastError}`,
    };
  }

  // Circuit-breaker guardrail stop. Checked after the aggregate and bad-request
  // diagnoses, which are more specific about WHY the pool is failing.
  if (ctx?.breakerFails) {
    const breakerEta = formatResetEta(getSoonestCooldownExpiry());
    const breakerEtaNote = breakerEta ? ` Soonest cooldown reset ${breakerEta}.` : '';
    return {
      kind: 'unavailable',
      status: 503,
      type: 'service_unavailable',
      code: 'upstream_unhealthy',
      message: `Failover stopped early by the circuit-breaker guardrail: ${ctx.breakerFails} consecutive upstream ` +
        `failure${ctx.breakerFails === 1 ? '' : 's'} (max_consecutive_upstream_fails). The enabled pool looks ` +
        `unhealthy right now, so the remaining candidates were skipped instead of burning quota on them.` +
        `${breakerEtaNote}${trail} Last error: ${safeLastError}`,
    };
  }

  // 429 only when EVERY candidate is unavailable until a known time (or the
  // caller gave us no per-attempt classes to aggregate — the legacy shape).
  if (attempts.length === 0 || everyAttempt(UNAVAILABLE_UNTIL_KNOWN_TIME)) {
    const attemptCount = attempts.length > 0 ? attempts.length : maxRetries;
    const scope = attemptCount == null
      ? 'All models rate-limited'
      : `All models rate-limited after ${attemptCount} attempt${attemptCount === 1 ? '' : 's'}`;
    const retryAtMs = getSoonestCooldownExpiry() ?? undefined;
    const eta = formatResetEta(retryAtMs);
    const etaNote = eta ? ` Soonest cooldown reset ${eta}.` : '';
    return {
      kind: 'rate_limit',
      status: 429,
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      ...(retryAtMs != null ? { retryAtMs } : {}),
      message: `${scope}${budgetNote}.${etaNote}${trail} Last error: ${safeLastError}`,
    };
  }

  // Mixed/other upstream failures (5xx, timeouts, transport errors, or a mix of
  // those with rate limits): the upstream pool failed us, so say 502 — not 429
  // (which would promise recovery-by-waiting the attempts don't support) and
  // not 500 (which would blame our own code).
  return {
    kind: 'upstream',
    status: 502,
    type: 'provider_error',
    code: 'upstream_failed',
    message: `All ${attempts.length} routed attempt(s) failed with upstream provider errors${budgetNote}. ` +
      `This is a provider-side failure, not a problem with your request; retry, or check provider status.` +
      `${trail} Last error: ${safeLastError}`,
  };
}

// ── Routing exhaustion (zero attempts ran) ───────────────────────────────────
// When routeRequest gives up before ANY upstream was tried, the only evidence
// is its per-candidate diagnostics. Map them onto the same honest-terminal-
// status taxonomy the attempt ladder uses:
//   - nothing configured at all (empty chain, or every candidate lacks a
//     provider/usable key) → 503: no amount of waiting or request-shrinking
//     helps; the operator must add keys.
//   - every candidate rejected the request as too big for its context/TPM
//     window → 413.
//   - at least one candidate is merely rate-limited/on cooldown (and the rest
//     are at worst unconfigured/too-small) → 429 with the soonest cooldown
//     expiry as retryAtMs.
//   - anything else (capability filters like vision/tools, mixed reasons) →
//     the router's status (429) with a generic routing_exhausted code.
type RoutingDiagClass = 'config' | 'too_large' | 'time_bound' | 'other';

function classifyRoutingDiagLine(line: string): RoutingDiagClass {
  const l = line.toLowerCase();
  // "< estimated" first: the tpm_limit-too-small line also contains 'tpm',
  // which would otherwise misread as a transient window.
  if (l.includes('< estimated')) return 'too_large';
  if (/no provider registered|no enabled\+healthy key|no usable key|decrypt-error|no-resolved-provider|custom-key-mismatch/.test(l)) return 'config';
  if (/cooldown|rpm|rpd|tpm|tpd|provider-daily-cap|provider-minute-cap|provider-daily-token-cap|key-concurrency/.test(l)) return 'time_bound';
  return 'other';
}

export function routingExhaustionBody(routeErr: any): ExhaustionBody {
  const diag: string[] = Array.isArray(routeErr?.diagnostics) ? routeErr.diagnostics : [];
  const message: string = routeErr?.message ?? 'No model available to route this request';
  const classes = diag.map(classifyRoutingDiagLine);

  if (diag.length === 0 || classes.every(c => c === 'config')) {
    return {
      kind: 'unavailable',
      status: 503,
      type: 'service_unavailable',
      code: 'no_providers_configured',
      message: diag.length === 0
        ? `No models are enabled/configured to serve this request. Add provider API keys and enable models in the dashboard. ${message}`
        : `No candidate model has a configured, usable provider key. Add provider API keys in the dashboard. ${message}`,
    };
  }

  if (classes.every(c => c === 'too_large' || c === 'config') && classes.includes('too_large')) {
    return {
      kind: 'context_too_large',
      status: 413,
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: `The request is too large for every available candidate's context/token window. ` +
        `Reduce the prompt/history size or enable a larger-context model. ${message}`,
    };
  }

  if (classes.some(c => c === 'time_bound') && classes.every(c => c !== 'other')) {
    const retryAtMs = getSoonestCooldownExpiry() ?? undefined;
    return {
      kind: 'rate_limit',
      status: 429,
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      ...(retryAtMs != null ? { retryAtMs } : {}),
      message,
    };
  }

  // Capability filters or mixed reasons: keep the router's verdict (429) but
  // stamp a machine-readable code so clients can tell it from a plain
  // rate-limit exhaustion.
  return {
    kind: 'rate_limit',
    status: typeof routeErr?.status === 'number' ? routeErr.status : 429,
    type: 'rate_limit_error',
    code: 'routing_exhausted',
    message,
  };
}

// What a surface's dispatch() returns to signal the response is finished and the
// loop must stop:
//   'done'      — the attempt succeeded and the full response was sent.
//   'committed' — a stream already flushed real bytes to the client, then hit a
//                 mid-stream error the surface surfaced honestly; no failover is
//                 possible, so stop without recording another retry.
export type DispatchOutcome = 'done' | 'committed';

/** Per-attempt handles the loop hands to dispatch. */
export interface DispatchContext {
  /**
   * Cancel this attempt's time-budget hedge. Idempotent and always safe to
   * call, including when hedging is not armed at all. See FallbackHooks.dispatch.
   */
  disarmHedge(): void;
}

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
  // Circuit-breaker threshold override, mostly for tests. Defaults to
  // getMaxConsecutiveUpstreamFails() (setting → env → 0 = disabled).
  breakerLimit?: number;
  // When provided, the loop records every failed attempt into THIS array (it
  // is the same array used for exhaustion bodies), so the surface can stamp
  // X-Fallback-Trail on successful responses too.
  attemptLog?: AttemptRecord[];
  // Returns true once the client has hung up. Checked before STARTING each
  // retry: a chain nobody is waiting for must not keep burning provider
  // quota. Surfaces additionally thread a client-disconnect AbortSignal into
  // the provider options (CompletionOptions.signal), so the in-flight
  // attempt's fetch/body/stream is canceled the moment the client goes; the
  // resulting client-abort throw stops the loop without any failure
  // bookkeeping (see the isClientAbortError branch below).
  clientGone?: () => boolean;
  // Fallback-v2 hedging: when provided, the loop starts a per-attempt timer
  // (remaining wall-clock budget) and calls this to ABORT the in-flight
  // upstream instead of just refusing to start the next retry behind a
  // stalled attempt. The surface aborts its composed fetch signal with
  // newHedgeAbortError() — a non-provider-health signal, so the loop renders
  // timedOut exhaustion without benching the model+key (see the
  // isHedgeAbortError branch below). Absent = pre-v2 behavior.
  abortInFlight?: () => void;
  // Skip state; recordRetryableFailure / recordAuthFailure (called by the loop)
  // mutate it, and the surface's route() reads it to exclude failed keys/models.
  state: FallbackState;

  /**
   * Pick a route for this attempt. Reads state.skipKeys / state.skipModels /
   * state.skipPlatforms.
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
   *
   * `ctx.disarmHedge()` cancels the time-budget hedge for THIS attempt. Call it
   * the moment the attempt proves it is alive (first byte / headers flushed):
   * past that point the budget must not cancel it, because the answer is
   * already on its way and killing it would truncate a healthy response for no
   * failover benefit. Streaming surfaces are expected to call it; a
   * non-streaming attempt has nothing to disarm until it returns.
   */
  dispatch(route: RouteResult, attempt: number, ctx: DispatchContext): Promise<DispatchOutcome>;

  /** Trace + log a per-attempt failure (per-surface scope + logRequest args). */
  logFailure(route: RouteResult, err: any, attempt: number): void;

  /** Render a non-retryable provider error (per-surface body/status). `attempt`
   *  is the failing attempt's index = the number of prior fallback hops. */
  onFatal(route: RouteResult, err: any, attempt: number): void;

  /**
   * Render exhaustion when route() threw. `exhaustion` is always the shared
   * honest-status body: built from the attempt trail when at least one attempt
   * ran, or from routeErr's routing diagnostics (routingExhaustionBody) when
   * routing gave up before any upstream was tried. `lastError` is null in the
   * zero-attempt case; `routeErr` is passed for logging/diagnostics.
   */
  onRoutingExhausted(lastError: any, routeErr: any, exhaustion: ExhaustionBody, info: ExhaustionInfo): void;

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
  // Durable per-attempt trace (P2 #15): every dispatched attempt — including
  // the successful final one — is recorded with timing and outcome, then
  // persisted as one insert batch into `request_attempts`, keyed to the
  // terminal `requests` row of this ladder. The trace rides AsyncLocalStorage
  // so logRequest() (called deep inside the surfaces' dispatch closures) can
  // report back the row ids it writes without any surface changing. The flush
  // runs after the loop returns — i.e. after the response is finished — so it
  // never sits on the client's latency path, and it is a no-op when no
  // `requests` row was written (a pure abort writes its own 'canceled' row,
  // so its trace persists too).
  const trace = newRequestTrace();
  try {
    await runWithRequestTrace(trace, () => runFallbackLoopAttempts(hooks, trace));
  } finally {
    persistRequestAttempts(trace);
  }
}

async function runFallbackLoopAttempts(hooks: FallbackHooks, trace: RequestTrace): Promise<void> {
  const maxRetries = hooks.maxRetries ?? FALLBACK_MAX_RETRIES;
  const budgetMs = hooks.timeBudgetMs ?? getFallbackTimeBudgetMs();
  const startedAt = Date.now();
  const attempts: AttemptRecord[] = hooks.attemptLog ?? [];
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

  // Circuit-breaker guardrail (default off): the Nth consecutive upstream
  // failure aborts the chain with a 503 instead of grinding the remaining
  // candidates of a pool that is failing across the board. Auth failures count
  // too — a wall of dead keys is exactly the "stop early" case. Within one
  // request every recorded failure is consecutive by construction (a success
  // ends the loop), so this is "max upstream failures per request".
  const breaker = newBreaker(hooks.breakerLimit);
  const stopIfBreakerTripped = (): boolean => {
    if (!recordBreakerFailure(breaker)) return false;
    // Tripped after the client already hung up: stop the chain, but there is
    // no socket to render an exhaustion body to (mirrors the loop-top
    // clientGone check).
    if (hooks.clientGone?.()) {
      console.log(`[FallbackLoop] breaker tripped after client disconnect — stopping without rendering (${attempts.length} failed attempt(s))`);
      return true;
    }
    hooks.onExhausted(
      exhaustedRetryError(lastError, maxRetries, { attempts, breakerFails: breaker.consecutive }),
      { attempts, timedOut: false },
    );
    return true;
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Client disconnect: nobody is waiting for this chain anymore, so stop
    // burning provider quota on retries. Nothing to render — the socket is
    // gone — so return without calling any exhaustion hook.
    if (attempt > 0 && hooks.clientGone?.()) {
      console.log(`[FallbackLoop] client disconnected — stopping failover after ${attempts.length} failed attempt(s)`);
      return;
    }

    // Wall-clock budget: refuse to START another retry once spent. The first
    // attempt always runs, and so does the first RETRY — when attempt 0 alone
    // consumed the budget, refusing attempt 1 would make failover impossible
    // for exactly the slow-failing models that need it (#751). A slow attempt
    // is never aborted mid-flight (that is the TODO(fallback-v2) hedging
    // work), it just becomes the last one.
    if (attempt > 1 && budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
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
        : routingExhaustionBody(routeErr);
      hooks.onRoutingExhausted(lastError, routeErr, exhaustion, { attempts, timedOut: false });
      return;
    }

    // Per-attempt trace record: pushed exactly once per dispatched attempt, on
    // whichever exit the attempt takes. startOffsetMs/durationMs bracket the
    // dispatch (for a successful stream, durationMs runs until the response
    // finished — that IS the attempt). When the attempt ended on an error, a
    // short REDACTED summary of it rides along — the outcome class alone loses
    // the provider's actual words, which is exactly what the dashboard's
    // drill-down needs to answer "why did this hop fail".
    const attemptStartedAt = Date.now();
    const traceAttempt = (outcome: AttemptOutcome, err?: any): void => {
      trace.records.push({
        ordinal: trace.records.length,
        platform: route.platform,
        modelId: route.modelId,
        keyOrdinal: keyOrdinal(route),
        keyLabel: route.keyLabel ?? null,
        outcome,
        startOffsetMs: attemptStartedAt - startedAt,
        durationMs: Date.now() - attemptStartedAt,
        errorSummary: err != null ? summarizeAttemptError(err?.message) : null,
      });
    };

    // Everything from here to the end of the iteration runs inside a finally that
    // frees the route's in-flight lease. Every exit — success, auth rotation,
    // retryable continue, fatal, breaker trip, contract violation — passes through
    // it, so no path can leak a lease and leave the key's concurrency budget short.
    // Success accounting happens inside dispatch, so the persisted counters are
    // already written by the time the provisional lease goes away.
    // Fallback-v2 hedging: arm a timer for the remaining wall-clock budget so a
    // STALLED attempt is aborted mid-flight (abortInFlight) instead of only
    // refusing to start the next retry behind it. Mirrors the loop-top budget
    // check — attempt 0 and the first retry always run (#751).
    //
    // The timer only covers the silent window. dispatch calls ctx.disarmHedge()
    // as soon as the attempt proves it is alive (first byte / headers flushed),
    // because past that point cancelling would truncate a healthy response and
    // buy nothing: a committed stream can no longer fail over anyway. Slow is
    // not the same as stalled, and only stalled is worth killing.
    let hedgeTimer: NodeJS.Timeout | undefined;
    const disarmHedge = () => {
      if (hedgeTimer) {
        clearTimeout(hedgeTimer);
        hedgeTimer = undefined;
      }
    };
    if (attempt > 1 && budgetMs > 0 && hooks.abortInFlight) {
      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining > 0) {
        hedgeTimer = setTimeout(() => {
          console.log(`[FallbackLoop] retry time budget (${budgetMs}ms) expired with no first byte on ${route.platform}/${route.modelId} — aborting stalled upstream`);
          hooks.abortInFlight?.();
        }, remaining);
      }
    }
    try {
    let outcome: DispatchOutcome;
    try {
      // #590 (per-key proxy): if THIS key carries its own proxy URL, route the
      // attempt through it (withKeyProxy → proxyFetch reads the ALS store);
      // otherwise the global proxy / direct path applies as before. The URL
      // arrives already decrypted on the route (services/router.ts), so an
      // attempt costs nothing extra — no query, no decrypt.
      outcome = await withKeyProxy(route.proxyUrl, () => hooks.dispatch(route, attempt, { disarmHedge }));
    } catch (err: any) {
      // Client-caused abort: the composed fetch signal fired because OUR
      // client hung up mid-attempt (see newClientAbortError). Not a
      // provider-health signal — no cooldown, no penalty, no failure stats,
      // no logFailure 'error' row — and no further attempts either: nobody is
      // waiting, and there is no socket to render anything to. The finally
      // below still frees the in-flight lease.
      if (isClientAbortError(err)) {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[FallbackLoop] client disconnected mid-attempt on ${route.platform}/${route.modelId} — upstream canceled, stopping without benching`);
        // Visibility row (#752): a pure abort used to leave NOTHING in the
        // requests table, so the dashboard showed no trace of the request.
        // Status 'canceled' is neither success nor failure — every stats/
        // scoring query excludes it — and this row is also the parent the
        // attempt-trace batch below keys to.
        logRequest(route.platform, route.modelId, route.keyId, 'canceled', 0, 0, elapsedMs,
          `client disconnected after ${(elapsedMs / 1000).toFixed(1)}s; upstream request canceled`);
        traceAttempt('client_abort');
        return;
      }
      // Time-budget hedge abort: the wall-clock retry budget expired while this
      // attempt was still in flight, and the surface aborted the composed fetch
      // signal (see newHedgeAbortError). Not a provider-health signal — no
      // cooldown, no penalty, no failure stats — and the budget is spent, so
      // render timedOut exhaustion exactly like the loop-top budget check does.
      if (isHedgeAbortError(err)) {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[FallbackLoop] retry time budget expired mid-attempt on ${route.platform}/${route.modelId} after ${(elapsedMs / 1000).toFixed(1)}s — rendering timedOut exhaustion without benching`);
        hooks.onExhausted(
          exhaustedRetryError(lastError, maxRetries, { attempts, timedOut: true, budgetMs }),
          { attempts, timedOut: true },
        );
        traceAttempt('timeout', err);
        return;
      }
      hooks.logFailure(route, err, attempt);
      if (isKeyAuthError(err)) {
        // KEY-fatal, not request-fatal: rotate past the bad key and revalidate
        // it immediately instead of 502-ing while healthy routes sit idle.
        recordAuthFailure(route, hooks.state);
        attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass: 'auth' });
        traceAttempt('auth', err);
        lastError = err;
        if (stopIfBreakerTripped()) return;
        continue;
      }
      if (isRetryableError(err)) {
        const exempt = recordRetryableFailure(route, err, hooks.state);
        const errorClass = classifyAttemptError(err);
        attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass });
        traceAttempt(errorClass, err);
        lastError = err;
        // A still-exempt skipBench failure (format ignored, hidden-reasoning
        // truncation under the streak limit) is model behavior, not provider
        // health — recordRetryableFailure skipped the cooldown/penalty for it,
        // and it must not count toward the "pool looks unhealthy" breaker
        // either: three prose answers to a json_schema request say nothing
        // about whether candidate four is up. Once the empty-completion streak
        // lifts the exemption (#751), the failure counts everywhere.
        if (!exempt && stopIfBreakerTripped()) return;
        continue;
      }
      traceAttempt(classifyAttemptError(err), err);
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
      traceAttempt('error', violation);
      hooks.onFatal(route, violation, attempt);
      return;
    }
    // Terminal attempt: 'done' produced the response; 'committed' means the
    // stream had already flushed bytes when the attempt ended (mid-stream
    // error or pre-commit disconnect) — the parent row carries the specifics.
    traceAttempt(outcome === 'done' ? 'ok' : 'committed');
    return;
    } finally {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      route.release?.();
    }
  }

  hooks.onExhausted(
    exhaustedRetryError(lastError, maxRetries, { attempts }),
    { attempts, timedOut: false },
  );
}
