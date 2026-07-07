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
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status === 408 || status === 409 || status === 410 || status === 429 || status >= 500) return true;
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('fetch failed')    // undici transport error (proxy down, DNS, TLS, etc.)
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
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
    || msg.includes('in-band provider error')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    || msg.includes('unparseable inline tool-call dialect');
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

// Provider-side 400s are retryable because another provider may accept the same
// request shape. If every routed provider rejects it, however, the client should
// see an invalid-request error rather than a misleading rate-limit exhaustion.
export function isProviderBadRequestError(err: any): boolean {
  const status = typeof err?.status === 'number' ? err.status : 0;
  const msg = (err?.message ?? '').toLowerCase();
  return (status === 0 || status === 400) && msg.includes('api error 400');
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
  return msg.includes('403') || msg.includes('forbidden');
}
