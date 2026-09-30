// Per-model output-token ceilings learned from provider rejections.
//
// Clients size max_tokens for the model they think they are talking to:
// Claude Code asks for 128000, Open WebUI for 65536. Several free models stop
// lower and reject the request outright instead of clamping it, observed live:
//   - Ollama Cloud: "max_tokens (128000) exceeds model's maximum output tokens
//     (65536) for model nemotron-3-ultra"
//   - Groq: "`max_tokens` must be less than or equal to `65536`, the maximum
//     value for `max_tokens` is less than the `context_window` for this model"
// The catalog has no output-limit column, so the ceiling is learned from the
// first rejection and applied to every later request on that model through the
// per-route output budget (resolveMaxTokens clamps max_tokens to it). A
// restart forgets the ceilings; the first request after it pays one failover
// hop to relearn each one.

const learned = new Map<string, number>();

const MAX_TOKENS_PARAM = /\b(max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|max_new_tokens)\b/;
// The number that follows a ceiling phrase: "less than or equal to `65536`",
// "maximum output tokens (65536)", "at most 32768", "no more than 8192",
// "exceeds the maximum allowed value of 4096" (OpenRouter), "greater than the
// maximum 16384" (Fireworks), "must be less than 8192" (DeepInfra). No bare
// "exceeds N" or "less than N": those read any number in the message ("input
// tokens exceeds 200", "exceeds 30000 TPM").
const CEILING_PHRASE = '(?:less than or equal to|must be less than|at most|no (?:more|greater) than|(?:cannot|must not|can not) exceed|greater than the maximum|maximum output tokens|maximum allowed value|max output tokens|maximum value|output limit|maximum is)\\W{0,4}(?:of\\s+)?\\W{0,2}(\\d{3,7})';
// The ceiling phrase must follow the parameter name within the same clause
// (60 characters, no '.' or ';' in between), so a number that belongs to some
// other limit in a message that merely mentions max_tokens is never learned.
const CEILING = new RegExp(`\\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxoutputtokens|max_new_tokens)\\b[^.;]{0,60}?${CEILING_PHRASE}`);
// A learned ceiling below this is almost certainly a misread (a real output
// limit this small is not something a client would hit by accident), and a
// wrong low cap would truncate every reply on the model until restart.
export const MIN_LEARNED_OUTPUT_CAP = 1024;

function capKey(platform: string, modelId: string): string {
  return `${platform}:${modelId}`;
}

/** The output ceiling a provider names when it rejects max_tokens as too
 *  large, or null when the error is anything else. Both the parameter name and
 *  a ceiling phrase must appear, so a context-window rejection that merely
 *  mentions "maximum output tokens" (Cloudflare) never matches. */
export function parseMaxTokensCeiling(message: unknown): number | null {
  const msg = String(message ?? '').toLowerCase();
  if (!MAX_TOKENS_PARAM.test(msg)) return null;
  const match = CEILING.exec(msg);
  if (!match) return null;
  const ceiling = Number(match[1]);
  return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null;
}

/** Learn the ceiling from a max_tokens rejection. Returns it, or null when the
 *  error is not one, or when the reading is below MIN_LEARNED_OUTPUT_CAP. The
 *  lowest reading wins. */
export function learnOutputCapFromError(route: { platform: string; modelId: string }, err: any): number | null {
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status !== 0 && status !== 400 && status !== 422) return null;
  const ceiling = parseMaxTokensCeiling(err?.message);
  if (ceiling == null || ceiling < MIN_LEARNED_OUTPUT_CAP) return null;
  const key = capKey(route.platform, route.modelId);
  const current = learned.get(key);
  learned.set(key, current == null ? ceiling : Math.min(current, ceiling));
  return ceiling;
}

export function learnedOutputCap(platform: string, modelId: string): number | undefined {
  return learned.get(capKey(platform, modelId));
}

/** The output budget for one route: what is left of its context window after
 *  the input, lowered to any learned output ceiling. Adapters pass it to
 *  resolveMaxTokens as `contextBudget`. */
export function routeOutputBudget(
  route: { platform: string; modelId: string; contextWindow?: number | null },
  estimatedInputTokens: number,
): number | undefined {
  const windowLeft = route.contextWindow != null ? route.contextWindow - estimatedInputTokens : undefined;
  const cap = learnedOutputCap(route.platform, route.modelId);
  if (cap == null) return windowLeft;
  return windowLeft == null ? cap : Math.min(windowLeft, cap);
}

export function resetLearnedOutputCaps(): void {
  learned.clear();
}
