// Pull a real token count out of a provider's 413 / context-length error body.
//
// The local token estimator (`text.length / 4`) undercounts tool-heavy /
// code-heavy prompts by 3-10x: a request the estimator scores at 3,700 tokens
// can be reported as 36,532 by Groq. Without this parser the `tpm_limit` and
// `context_window` pre-checks in the router pass on the wrong number, the call
// fires, and the provider 413s — burning one failover hop per model in the
// chain instead of one hop total. This module is the single source of truth for
// "what size did the provider say this request was": one regex per supported
// provider, all derived from the live error corpus.
//
// Returns null for anything it can't pin to a real REQUESTED size (not a LIMIT
// ceiling — see the github case below). Callers feed the result into the
// routing estimate so the existing size gates skip low-TPM / small-context
// models on the next attempt instead of letting them re-fail.
//
// Why github is intentionally NOT parsed: the body is
// `Request body too large for gpt-4.1 model. Max size: 8000 tokens.` The 8000
// is the LIMIT, not the rejected request's size. Returning it would cause
// every subsequent model with TPM < 8000 to be skipped for the rest of the
// request — wildly wrong, since most free models have TPM ~6000. The parser
// returns null and `learnLimitFromError` keeps doing what it already does
// (lowering `models.tpm_limit` to 8000 for github/gpt-4.1).

// Pull the first integer out of a comma-thousands-separator-aware capture.
// Anchored on the literal label the provider uses so a stray digit elsewhere
// in the body can't match. Accepts a regex with one or two capture groups
// (second group is used when the first is undefined), so cloudflare can
// choose between input-only and combined-total via two alternations.
function pullFirstInt(body: string, pattern: RegExp): number | null {
  const m = body.match(pattern);
  if (!m) return null;
  const raw = m[1] != null ? m[1] : m[2];
  if (raw == null) return null;
  // Strip thousand-separator commas before parsing: "36,532" → "36532".
  const cleaned = raw.replace(/,/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// One regex per provider. Each one is anchored on a literal token from a
// real observed error body so a provider changing its wording trips the test
// and forces a parser update — bare numbers without an anchor would happily
// match an unrelated digit anywhere in the message.
const PATTERNS: Record<string, RegExp> = {
  // "Limit 8000, Requested 36532, please reduce your message size..."
  groq: /Requested\s+([\d,]+)/i,
  // "...requested about 68982 tokens (4982 of text input, 64000 in the output)..."
  openrouter: /requested\s+about\s+([\d,]+)\s+tokens/i,
  // Prefer the INPUT-only count from a 400 ("your prompt contains at least
  // 23745 input tokens, for a total of at least 24001 tokens"). The input-only
  // count anchors on "contains at least N input tokens" so the larger
  // "total of at least 24001" that immediately follows does not win.
  // Fall back to the combined total from a 413 ("tokens (24092) exceeded
  // this model context") via the paren-anchored alternative.
  cloudflare: /(?:contains\s+at\s+least\s+([\d,]+)\s+input\s+tokens|tokens\s*\(([\d,]+)\s*\))/i,
};

export function parseProviderReportedSize(platform: string, message: string | null | undefined): number | null {
  if (typeof message !== 'string' || message === '') return null;
  const re = PATTERNS[platform];
  if (!re) return null;
  return pullFirstInt(message, re);
}
