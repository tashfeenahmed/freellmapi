// Upstream-error classification shared by the proxy chat path, the responses
// path, and the fusion panel. Pure functions over an error's message/status —
// no I/O — so they live in a neutral lib module that any of those can import
// without forming an import cycle (fusion ↔ proxy in particular).

export function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  // Trust the upstream HTTP status the provider attached to the error first
  // (providerHttpError in providers/base.ts sets err.status on every adapter).
  // This structured check is the robust primary signal; the message-substring
  // rules below are the fallback for errors that carry a code in their text but
  // no numeric status. It's the fix for #337/#339: an Ollama "410 Gone", or any
  // upstream 5xx the substring allowlist never enumerated (502/504/507…), used to
  // fall through to a 502 and STRAND the healthy paid routes still queued later in
  // the chain — because the old code matched specific substrings and ignored
  // err.status for every code except 403. 408 (request timeout), 409 (conflict),
  // 410 (model pulled upstream), 429 (rate limit) and all 5xx are transient or
  // fail-over-able; 400/401 stay fatal (status 0 here, handled by the absence of a
  // matching rule) and 403 is handled by isModelAccessForbiddenError below.
  // 422 (notably Mistral's strict validation) is a provider-side request-shape
  // rejection: fail over to another provider, but if the whole chain rejects it
  // exhaustedRetryError renders a client-facing 400 via isProviderBadRequestError.
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status === 408 || status === 409 || status === 410 || status === 422 || status === 429 || status >= 500) return true;
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('fetch failed')    // undici transport error (proxy down, DNS, TLS, etc.)
    || msg.includes('503') || msg.includes('unavailable')
    // Provider marks the hosted deployment itself as sick (NVIDIA NIM's
    // "DEGRADED function cannot be invoked" arrives as a 400, #522). The
    // 'api error 400' rule below already catches the NIM shape; this keeps
    // degraded conditions retryable even when a provider words it differently.
    || msg.includes('degraded')
    || msg.includes('500') || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    // Context/prompt-too-large in all its provider wordings (Anthropic "prompt
    // is too long", Google "input token count ... exceeds", OpenAI "maximum
    // context length", …): another candidate may have a larger window, so fail
    // over; if EVERY candidate rejects it the exhaustion ladder renders an
    // honest 413 instead of a generic failure.
    || isContextTooLargeError(err)
    // 404: model deprecated/removed upstream (e.g. OpenRouter's "no endpoints found"
    // for a model that's been pulled). Rotate to the next model in the chain —
    // setCooldown + the health checker will avoid this model on subsequent requests.
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    // 410: the model/endpoint was permanently removed upstream (e.g. Ollama Cloud
    // "API error 410: Gone", #339). Like a 404 it won't return on this provider, so
    // rotate to the next route; isModelNotFoundError benches the whole model. The
    // structured status check above already catches the 410 when the provider
    // attaches err.status — this is the text fallback for errors that don't.
    || msg.includes('410') || msg.includes('gone')
    // 403: the key is valid (it passed validateKey, and the health checker
    // disables truly-forbidden keys) but this specific model is off-limits to
    // the key's tier — e.g. gpt-4o on GitHub Models' free tier, subscription-only
    // models on Cloudflare. Another model in the chain is reachable, so fail over
    // instead of 502-ing the whole request. Paired with isModelAccessForbiddenError
    // to rule the model out for this request and a day-long bench. See issue #256.
    || isModelAccessForbiddenError(err)
    // 400: one provider may reject parameters another accepts (e.g. max_tokens
    // limits, unsupported params). The matching pattern is "api error 400"
    // which comes from the OpenAI-compat provider's error formatting, not
    // a bare "400" which is deliberately non-retryable for validation errors.
    || msg.includes('api error 400')
    // 422: Mistral and other strict OpenAI-compatible endpoints use
    // Unprocessable Entity for request-shape validation. Rotate to a provider
    // that accepts the same OpenAI payload; if every provider rejects it, render
    // a clean invalid_request_error instead of a rate-limit exhaustion.
    || msg.includes('api error 422') || msg.includes('unprocessable entity')
    // 402: this provider/key is out of credits (e.g. HuggingFace Router
    // "API error 402: Payment required"). The SAME model often lives on another
    // provider (Kimi K2.6 is on HF + Cloudflare + NVIDIA), so fail over instead
    // of killing the workflow. Paired with a long cooldown (isPaymentRequiredError)
    // so we don't re-hammer the broke key every retry.
    || isPaymentRequiredError(err)
    // Dead-turn classes from the stream turn-integrity layer (#231 audit):
    // all thrown before any byte reached the client, so another model can
    // serve the request invisibly.
    || msg.includes('empty completion')
    // The model answered in prose despite a response_format request (and the
    // JSON couldn't be healed out of the text) — thrown before any byte
    // reached the client, so the next candidate can serve it invisibly.
    || msg.includes('ignored response_format')
    // The model DID emit JSON but ran out of max_tokens mid-value
    // (finish_reason 'length'). A terser model may fit the same schema in the
    // same budget, so fail over — but the thrower marks the model skipped for
    // this request: retrying the same model would truncate identically.
    || msg.includes('truncated json')
    || msg.includes('in-band provider error')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    // First-byte timeout (#584): the grace budget expired before ANY byte
    // reached the client, so the next candidate can serve it invisibly.
    || msg.includes('no first byte')
    || msg.includes('unparseable inline tool-call dialect');
}

// A genuine provider QUOTA signal: a structured 429 or rate-limit/quota wording.
// Distinct from the much broader isRetryableError: timeouts, 5xx, transport
// failures and dead-turn classes are retryable but say nothing about quotas.
// The null-limits exhaustion heuristic in getCooldownDecisionForLimit (services/
// ratelimit.ts) keys off this: only an actual quota signal may feed its
// "effectively daily-exhausted" escalation ladder. Before this split, a slow
// local Ollama route timing out twice classified retryable → recorded as a
// null-limit "429" → escalated 2m→10m→1h→24h and 429'd every request while the
// server was merely busy generating (#592).
// Mirrors the other classifiers: trust the structured status when the adapter
// attached one (providerHttpError sets err.status everywhere); fall back to
// message markers only when there is no status.
export function isRateLimitSignal(err: any): boolean {
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status !== 0) return status === 429;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted');
}

// ── Timeout wording ─────────────────────────────────────────────────────────
// The message markers that mean "this attempt ran out of time", in every
// wording the stack produces: the per-attempt HTTP deadline ("The operation was
// aborted (groq, chat, 120s)" — enrichAbort in lib/proxy.ts), the mid-stream
// inactivity watchdog ("… stream stalled: no data for 90000ms (timeout)"), the
// first-byte grace budget, and a raw socket ETIMEDOUT.
//
// A client hang-up is deliberately NOT in here: newClientAbortError's message
// ("client disconnected — upstream request canceled") carries none of these
// markers precisely so a vanished client is never read as provider slowness.
//
// Single source of truth for two consumers: the attempt-trail classifier
// (classifyAttemptError) and the analytics query that folds timeouts into the
// speed score (refreshStatsCache, #619) — so the trail and the score always
// agree about what a timeout is.
export const TIMEOUT_ERROR_MARKERS = ['timeout', 'stalled', 'etimedout', 'aborted'] as const;

/** True when an error message reads as a timeout. Expects raw text; caller need
 * not lowercase it. */
export function isTimeoutErrorText(message: unknown): boolean {
  const msg = (typeof message === 'string' ? message : String(message ?? '')).toLowerCase();
  return TIMEOUT_ERROR_MARKERS.some(marker => msg.includes(marker));
}

// ── Client-caused aborts ─────────────────────────────────────────────────────
// When the gateway's OWN client hangs up, the proxy surfaces abort the composed
// fetch signal with this marked error, and undici rejects the in-flight fetch /
// body read / stream read with the same object (fetch propagates the signal's
// abort reason). It is deliberately NOT an AbortError and its message contains
// neither "aborted" nor "timeout": enrichAbort (lib/proxy.ts) must pass it
// through untouched, and it must never classify as a retryable provider
// timeout — a vanished client says nothing about provider health, so the
// fallback loop stops without a cooldown, health penalty, or failure stats.
export function newClientAbortError(): Error {
  const err = new Error('client disconnected — upstream request canceled');
  (err as Error & { clientAbort?: boolean }).clientAbort = true;
  return err;
}

/** True when an error is (or wraps) the client-disconnect abort above. The
 * structured marker is the primary signal; `cause` is checked because some
 * transports re-wrap the abort reason, and the message substring is the last
 * resort for errors that were stringified across a boundary. */
export function isClientAbortError(err: any): boolean {
  if (err?.clientAbort === true) return true;
  if (err?.cause && (err.cause as { clientAbort?: boolean }).clientAbort === true) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('client disconnected');
}

// ── Fallback time-budget hedging (fallback-v2) ──────────────────────────────
// When the wall-clock retry budget expires MID-FLIGHT (the current attempt is
// still waiting on a stalled upstream), the fallback loop aborts the composed
// fetch signal with this marked error. Same rationale as the client abort: it
// is NOT a provider-health signal, so it must never bench/cooldown/penalize
// the model+key, and enrichAbort must pass it through untouched. The loop
// catches it, renders timedOut exhaustion (the budget is spent — nothing left
// to try), and stops without failure bookkeeping.
export function newHedgeAbortError(): Error {
  const err = new Error('fallback time budget expired — upstream request canceled');
  (err as Error & { hedgeAbort?: boolean }).hedgeAbort = true;
  return err;
}

/** True when an error is (or wraps) the time-budget hedge abort above. */
export function isHedgeAbortError(err: any): boolean {
  if (err?.hedgeAbort === true) return true;
  if (err?.cause && (err.cause as { hedgeAbort?: boolean }).hedgeAbort === true) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('fallback time budget expired');
}

/** True for any fetch-abort rejection surfacing out of a body read — the
 * per-attempt timeout ('request'-bounds deadline in fetchWithTimeout), an
 * AbortSignal.timeout, or the client disconnect above. Adapters that wrap
 * res.json() in a diagnostic catch (openai-compat's non-JSON-body split) must
 * rethrow these instead of classifying them as a malformed provider body. */
export function isAbortLikeError(err: any): boolean {
  if (isClientAbortError(err)) return true;
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError' || /\baborted\b/i.test(err?.message ?? '');
}

// A 401 / invalid-API-key error from a provider. KEY-fatal, not request-fatal:
// the same request is fine on the provider's sibling key or on another provider,
// so the fallback loop rotates past the bad key (and triggers an immediate
// health revalidation) instead of 502-ing the whole request. Deliberately NOT
// added to isRetryableError: a bad key must be skipped and revalidated, not
// blindly re-benched like a rate limit — the loop handles it as its own class.
//
// Status handling: every provider adapter attaches err.status (providerHttpError
// in providers/base.ts), so the structured status is the primary signal.
//   - 401 → always key-auth.
//   - 400 → key-auth ONLY for Google-style key-specific phrasings: Google
//     reports a bad/expired key as HTTP 400 INVALID_ARGUMENT with "API key not
//     valid" / "API key expired" / API_KEY_INVALID (#268, providers/google.ts).
//     Without this a dead Google key classified as a provider bad-request and
//     could exhaust into a client-blaming 400 "rejected the request as invalid".
//     Generic auth wording (unauthorized etc.) stays excluded on a 400 so
//     ordinary payload rejections never classify as key-auth.
//   - any other status → not key-auth (e.g. a 403 stays model-forbidden).
//   - no status at all → key-specific OR generic auth substrings.
export function isKeyAuthError(err: any): boolean {
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status === 401) return true;
  const msg = (err?.message ?? '').toLowerCase();
  const keySpecific = msg.includes('api key not valid')
    || msg.includes('api key expired')
    || msg.includes('api_key_invalid');
  if (status === 400) return keySpecific;
  if (status !== 0) return false;
  return keySpecific
    || msg.includes('401')
    || msg.includes('unauthorized')
    || msg.includes('invalid api key')
    || msg.includes('invalid_api_key')
    || msg.includes('incorrect api key')
    || msg.includes('authentication failed');
}

// A 429 whose body says the provider's DAILY free allocation is spent (observed
// live: Cloudflare "you have used up your daily free allocation of 10,000
// neurons"; OpenRouter "free-models-per-day"). A transient 90s cooldown just
// makes the router re-pick a dead-for-the-day provider all day, so the caller
// benches until the next UTC midnight instead. Requires BOTH a daily marker and
// a quota/allocation marker so an ordinary per-minute 429 never matches.
export function isDailyQuotaExhaustedError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  if (!/daily|per[ -_]?day|\btoday\b/.test(msg)) return false;
  return /allocation|quota|limit|exhaust|used up/.test(msg);
}

// A provider-side "this hosted model is temporarily degraded" condition dressed
// up as a 400. Observed live on NVIDIA NIM (issue #522): a degraded function
// returns `400 {"detail":"Function id '...': DEGRADED function cannot be
// invoked"}` — the request is fine; the deployment is sick. Must NOT classify
// as a provider bad-request: exhausting on it would render a client-blaming
// 400 invalid_request_error for what is capacity/health, not request shape.
export function isProviderDegradedError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('degraded');
}

// Provider-side 400s are retryable because another provider may accept the same
// request shape. If every routed provider rejects it, however, the client should
// see an invalid-request error rather than a misleading rate-limit exhaustion.
export function isProviderBadRequestError(err: any): boolean {
  if (isProviderDegradedError(err)) return false;
  const status = typeof err?.status === 'number' ? err.status : 0;
  const msg = (err?.message ?? '').toLowerCase();
  if (status === 400) return msg.includes('api error 400');
  if (status === 422) return msg.includes('api error 422') || msg.includes('unprocessable entity');
  if (status !== 0) return false;
  return msg.includes('api error 400') || msg.includes('api error 422') || msg.includes('unprocessable entity');
}

// A "this request/prompt is too large" rejection. Providers word it very
// differently and even disagree on the HTTP status:
//   - OpenAI-compat: 400 with code `context_length_exceeded` — "This model's
//     maximum context length is 8192 tokens. However, your messages resulted
//     in 10001 tokens. Please reduce the length of the messages."
//   - Anthropic: 400 invalid_request_error — "prompt is too long: 210000
//     tokens > 200000 maximum" (Bedrock words it "Input is too long for
//     requested model.")
//   - Google/Gemini: 400 INVALID_ARGUMENT — "The input token count (1200000)
//     exceeds the maximum number of tokens allowed (1048576)."
//   - Groq: a literal HTTP 413 — "Request too large for model `x` ... on
//     tokens per minute (TPM): Limit 30000, Requested 33476". Requested >
//     Limit can never fit that candidate's window, so it belongs here (too
//     large for the candidate), not with transient per-minute 429s.
//   - Reverse proxies / gateways: 413 "Payload Too Large" / "request entity
//     too large" / "content too large".
// Structured status first (providerHttpError attaches err.status on every
// adapter), then the code field, then message markers — mirroring how the
// other classifiers in this file work. Retryable (a sibling candidate may have
// a larger window), but when EVERY attempt dies this way the exhaustion ladder
// renders an honest 413 instead of a generic failure.
export function isContextTooLargeError(err: any): boolean {
  if (err?.status === 413) return true;
  if (typeof err?.code === 'string' && err.code.toLowerCase() === 'context_length_exceeded') return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('context_length_exceeded')
    || msg.includes('maximum context length')
    || msg.includes('context length exceeded')
    || /exceeds[^.]*context (length|window|size)/.test(msg)
    || msg.includes('prompt is too long')
    || msg.includes('input is too long')
    || /input token count[^.]*exceeds/.test(msg)
    || msg.includes('exceeds the maximum number of tokens')
    || msg.includes('request too large')
    || msg.includes('payload too large')
    || msg.includes('request entity too large')
    || msg.includes('request body too large')
    || msg.includes('content too large')
    || msg.includes('api error 413');
}

// A 402 Payment Required / out-of-credits error. Distinct from a transient 429:
// it won't recover on the next window, so the caller benches the model+key with
// PAYMENT_REQUIRED_COOLDOWN_MS (a full day) rather than the 90s transient cooldown.
export function isPaymentRequiredError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('402') || msg.includes('payment required')
    || msg.includes('insufficient_quota') || msg.includes('insufficient credit')
    || msg.includes('insufficient balance');
}

// A 404 "model removed/deprecated upstream" error. It's a MODEL-level failure,
// not a key-level one: every key for the platform will 404 the same way, so the
// retry loop skips the entire model for the rest of the request instead of
// burning one fallback attempt per key on the same dead route.
// (PR #111, credits @barbotkonv.)
export function isModelNotFoundError(err: any): boolean {
  // 404 (removed/deprecated) and 410 (permanently Gone) are both MODEL-level: every
  // key for the platform fails the same way, so skip the whole model for the rest
  // of the request instead of burning one fallback attempt per sibling key. 410
  // added for #339 (Ollama Cloud "Gone"); prefer the structured status when present.
  if (err?.status === 404 || err?.status === 410) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    || msg.includes('410') || msg.includes('gone');
}

// A 403 Forbidden returned for a specific model behind an otherwise-valid key.
// Drives the same whole-model skip as a 404: every key on this platform's tier
// would be forbidden the same model, so rule it out for the rest of the request
// rather than trying it again with a sibling key. Distinct from a dead key —
// validateKey returns false on 401/403, so the health checker disables genuinely
// forbidden keys; a 403 reaching here is model-not-on-this-tier. See issue #256.
export function isModelAccessForbiddenError(err: any): boolean {
  if (err?.status === 403) return true;
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('403') || msg.includes('forbidden')) return true;
  // Not every provider spells "this key may not use this model" as a 403 (issue
  // #618): observed live as a 400 whose body reads "user is not allowed to
  // access model kat-coder-pro-v2.5", and as plan-gate wordings like "action
  // plan limited". Classified transient, those took the 90s bench — and the
  // auto-router re-picked the same permanently-unreachable model the moment it
  // expired, failing and re-benching forever with an ever-growing penalty.
  // Deliberately narrow: only 400/401 (or a status-less error), and only for
  // phrasings that name access/permission to the MODEL. A bare "Bad Request",
  // a generic "Unauthorized" (which isKeyAuthError owns), or a parameter
  // rejection must keep their current classification.
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status !== 0 && status !== 400 && status !== 401) return false;
  return MODEL_ACCESS_DENIED_PHRASES.some(phrase => msg.includes(phrase));
}

const MODEL_ACCESS_DENIED_PHRASES = [
  'not allowed to access',
  'not allowed to use',
  'not authorized to access',
  'not authorized to use',
  'unauthorized to access',
  'not permitted to access',
  'not permitted to use',
  'do not have access to',
  'does not have access to',
  'no access to model',
  'no access to this model',
  'model access denied',
  'access to this model is restricted',
  // Plan/subscription gates the provider words as a limit rather than a denial.
  'action plan limited',
];

// ── Permanent upstream retirement (issue #634) ───────────────────────────────
// isModelNotFoundError above rules a 404/410 model out for ONE request. That is
// right for a load balancer hiccup and wrong for a model the provider RETIRED:
// NVIDIA's "The model 'minimaxai/minimax-m2.7' has reached its end of life on
// 2026-07-27T00:00:00Z and is no longer available" is true forever, yet nothing
// persisted it, so the corpse burned a fallback slot on every later request.
//
// This classifier says how much a failure should be TRUSTED as permanent:
//   - 'definitive' — an explicit 410 Gone, or unmistakable end-of-life wording.
//     Acting on one response is safe.
//   - 'probable'   — a 404 whose body says the model is gone in so many words.
//     Real, but a provider can also word a transient outage this way, so the
//     caller corroborates across distinct requests before acting.
//   - null         — everything else, including every bare 404 ("Not found",
//     "Provider returned error", OpenRouter's "No endpoints found", NVIDIA's
//     per-account "Function '<uuid>': Not found for account '<id>'"). A
//     transient 404 must NEVER retire a healthy model.
// Note the 410 test is deliberately stricter than isModelNotFoundError's bare
// `msg.includes('410')`: a digit run inside a token count must not read as Gone.
export type ModelRetirementConfidence = 'definitive' | 'probable';

const END_OF_LIFE_PHRASES = [
  'end of life',
  'end-of-life',
  'has been retired',
  'has been decommissioned',
  'has been sunset',
];

const MODEL_GONE_PHRASES = [
  'no longer available',
  'no longer offered',
  'no longer supported',
  'has been removed',
  'was removed',
  'has been discontinued',
  'has been deprecated',
  'is deprecated',
];

export function modelRetirementSignal(err: any): ModelRetirementConfidence | null {
  const msg = (err?.message ?? '').toLowerCase();
  const status = typeof err?.status === 'number' ? err.status : 0;
  const gone = status === 410 || /\berror 410\b/.test(msg) || /\b410 gone\b/.test(msg);
  if (gone || END_OF_LIFE_PHRASES.some(phrase => msg.includes(phrase))) return 'definitive';
  if (!isModelNotFoundError(err)) return null;
  return MODEL_GONE_PHRASES.some(phrase => msg.includes(phrase)) ? 'probable' : null;
}
