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
//
// Keyed per model AND per endpoint (`modelStatsKey`), not per model: every
// custom relay shares platform 'custom', so a ceiling learned from relay A
// would silently clamp relay B's replies to relay A's output limit until
// restart. Same reasoning as lib/tool-capability.ts (#1230) and the
// endpoint_scope identity migration (#651): output ceilings are a property of
// the model behind ONE relay, and sibling relays do not share it.
import { modelStatsKey } from './endpoint-scope.js';
import { getDb } from '../db/index.js';

const learned = new Map<string, number>();
const loaded = new Set<string>();

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
const LEARNED_CAP_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function capKey(platform: string, modelId: string, endpointScope?: string | null): string {
  return modelStatsKey(platform, modelId, endpointScope);
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
export function learnOutputCapFromError(route: { platform: string; modelId: string; endpointScope?: string | null }, err: any): number | null {
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status !== 0 && status !== 400 && status !== 422) return null;
  const ceiling = parseMaxTokensCeiling(err?.message);
  if (ceiling == null || ceiling < MIN_LEARNED_OUTPUT_CAP) return null;
  const key = capKey(route.platform, route.modelId, route.endpointScope);
  const current = learnedOutputCap(route.platform, route.modelId, route.endpointScope);
  const effective = current == null ? ceiling : Math.min(current, ceiling);
  learned.set(key, effective);
  try {
    getDb().prepare(`
      INSERT INTO learned_output_caps (platform, model_id, endpoint_scope, max_output_tokens, learned_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET
        max_output_tokens = CASE
          WHEN learned_output_caps.learned_at_ms < ? THEN excluded.max_output_tokens
          ELSE MIN(learned_output_caps.max_output_tokens, excluded.max_output_tokens)
        END,
        learned_at_ms = excluded.learned_at_ms
    `).run(route.platform, route.modelId, route.endpointScope ?? '', effective, Date.now(), Date.now() - LEARNED_CAP_TTL_MS);
    loaded.add(key);
  } catch (dbError) {
    if (!(dbError instanceof Error && dbError.message === 'Database not initialized. Call initDb() or connectDb() first.')) {
      console.warn(`[OutputCap] Could not persist learned output limit for ${route.platform}/${route.modelId}: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
    }
  }
  return effective;
}

export function learnedOutputCap(platform: string, modelId: string, endpointScope?: string | null): number | undefined {
  const key = capKey(platform, modelId, endpointScope);
  if (!loaded.has(key)) {
    try {
      const row = getDb().prepare(`
        SELECT max_output_tokens FROM learned_output_caps
        WHERE platform = ? AND model_id = ? AND endpoint_scope = ?
          AND learned_at_ms >= ?
      `).get(platform, modelId, endpointScope ?? '', Date.now() - LEARNED_CAP_TTL_MS) as { max_output_tokens: number } | undefined;
      if (row && Number.isInteger(row.max_output_tokens) && row.max_output_tokens >= MIN_LEARNED_OUTPUT_CAP) {
        learned.set(key, row.max_output_tokens);
      }
      loaded.add(key);
    } catch (dbError) {
      if (!(dbError instanceof Error && dbError.message === 'Database not initialized. Call initDb() or connectDb() first.')) {
        throw dbError;
      }
    }
  }
  return learned.get(key);
}

/**
 * Reset the in-process cache for test isolation and to exercise persisted
 * values as a fresh process would see them.
 */
export function resetLearnedOutputCapCache(): void {
  learned.clear();
  loaded.clear();
}

export function resetLearnedOutputCaps(clearPersistent = true): void {
  resetLearnedOutputCapCache();
  if (!clearPersistent) return;
  try {
    getDb().prepare('DELETE FROM learned_output_caps').run();
  } catch (dbError) {
    if (!(dbError instanceof Error && dbError.message === 'Database not initialized. Call initDb() or connectDb() first.')) {
      throw dbError;
    }
  }
}

/** The output budget for one route: what is left of its context window after
 *  the input, lowered to any learned output ceiling. Adapters pass it to
 *  resolveMaxTokens as `contextBudget`. */
export function routeOutputBudget(
  route: { platform: string; modelId: string; contextWindow?: number | null; endpointScope?: string | null },
  estimatedInputTokens: number,
): number | undefined {
  const windowLeft = route.contextWindow != null ? route.contextWindow - estimatedInputTokens : undefined;
  const cap = learnedOutputCap(route.platform, route.modelId, route.endpointScope);
  if (cap == null) return windowLeft;
  return windowLeft == null ? cap : Math.min(windowLeft, cap);
}
