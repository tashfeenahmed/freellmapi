// Parse a provider's error message for the real size of the rejected request.
//
// Some providers (Groq, OpenRouter, Cloudflare) include an authoritative token
// count in their 4xx error bodies when a request is rejected as too large. That
// number comes from the provider's own tokenizer, so it is the ground truth for
// *this* request's size. The local `text.length / 4` estimator undercounts
// tool-heavy / code-heavy prompts by 3-10x (verified: a prompt that the local
// estimator scores at 3,700 tokens is reported as 36,532 by Groq), so once one
// provider rejects with a real size, propagating that size to skip the rest of
// the fallback chain saves every subsequent doomed attempt.
//
// Returns null when the provider's error body doesn't carry a parseable
// number (GitHub Models, the bare Groq "Request Entity Too Large" body, or
// upstream 5xx without a size payload). Callers must handle null as
// "no information" and fall through to the local estimator.
//
// Pure function — no DB, no I/O, no AsyncLocalStorage. Cheap enough to call
// on every retryable upstream error in the fallback loop.

export type Platform =
  | 'groq'
  | 'openrouter'
  | 'cloudflare'
  | 'github'
  | 'ollama'
  | 'nvidia'
  | 'opencode'
  | 'llm7'
  | 'cerebras'
  | 'anthropic'
  | 'google'
  | 'custom';

/**
 * Pull the request's token count out of a provider error message. Returns
 * null when the body is opaque or the provider is unknown.
 *
 * Patterns verified against the live `requests` table (30-day window):
 *   - groq      "tokens per minute (TPM): Limit N, Requested M"   → M
 *                2,385 occurrences; 1,759 had parseable "Requested N".
 *   - openrouter "requested about N tokens (K text input, J output)" → N
 *                51 occurrences; all parseable.
 *   - cloudflare 400: "prompt contains at least N input tokens"
 *                413: "tokens (N) exceeded this model context window"
 *                23 + 2 occurrences; 18 parseable.
 *   - github     "Max size: N tokens" — limit only, NOT a request size.
 *                Parser returns null so the caller doesn't poison other
 *                models with GitHub's limit value as if it were a request size.
 *
 * Other providers: the function returns null; the local estimator stays in
 * charge for the rest of the fallback chain.
 */
export function parseProviderReportedSize(platform: string, message: string | undefined | null): number | null {
  if (!message) return null;

  switch (platform) {
    case 'groq': {
      // "Limit 8000, Requested 36532, please reduce..."
      // Only fires when the body carries the structured "Requested N" clause
      // (the bare "Request Entity Too Large" variant is opaque → null).
      const m = message.match(/Requested\s+([\d,]+)/i);
      if (!m) return null;
      return parsePositiveInt(m[1]);
    }

    case 'openrouter': {
      // "you requested about 68982 tokens (4982 of text input, 64000 in the
      // output)" — total is the first number, after "about".
      const m = message.match(/requested about\s+([\d,]+)\s+tokens/i);
      if (!m) return null;
      return parsePositiveInt(m[1]);
    }

    case 'cloudflare': {
      // Cloudflare uses two shapes. Prefer the input-only number when
      // present (smaller, more comparable to the local input estimator).
      // Pattern A (400): "...your prompt contains at least 23745 input tokens..."
      const inputMatch = message.match(/prompt contains at least\s+([\d,]+)\s+input tokens/i);
      if (inputMatch) return parsePositiveInt(inputMatch[1]);
      // Pattern B (413): "tokens (24092) exceeded this model context window"
      // — gives the combined input+output total; fall back to it when the
      // 400-shape isn't present.
      const totalMatch = message.match(/tokens\s+\(([\d,]+)\)\s+exceeded/i);
      if (totalMatch) return parsePositiveInt(totalMatch[1]);
      return null;
    }

    // GitHub Models reports "Max size: 8000 tokens" — that is the LIMIT
    // ceiling, not the rejected request's size. Returning it would cause
    // every subsequent model with TPM < 8000 to be skipped for the rest of
    // the request, which is wildly wrong (most free models have TPM ~6000).
    // Intentionally returns null.
    case 'github':
      return null;

    default:
      return null;
  }
}

function parsePositiveInt(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}