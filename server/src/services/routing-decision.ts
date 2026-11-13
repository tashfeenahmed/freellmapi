import { createHash } from 'crypto';
import type { ChatMessage, ChatContent } from '@freellmapi/shared/types.js';
import { getSetting, setSetting } from '../db/index.js';
import { setRequestRoutingStrategy } from '../lib/client-context.js';
import { DecisionError, listDecisionModels, runDecision } from './decision.js';
import { getRoutingStrategy } from './router.js';
import type { PresetStrategy } from './scoring.js';

// Decision routing (#1354). With the 'decision' strategy on, a decision model
// reads the request and picks which of the four presets (Smartest, Fastest,
// Balanced, Most reliable) this request routes with. The pick only re-weights
// the bandit for this one request: every capability gate and the keep-trying
// fallback chain stay exactly as they are, and any doubt routes as Balanced:
//   - the top probability is below the configured minimum,
//   - the decision takes longer than DECISION_TIMEOUT_MS,
//   - no decision model or key is available, or the call fails.
// One decision per user turn: the answer is cached on the text it was asked
// about, so an agent's tool-call loop inside one turn asks once.

export const DECISION_PRESETS: readonly PresetStrategy[] = ['smartest', 'fastest', 'balanced', 'reliable'];

const DECISION_MODEL_KEY = 'routing_decision_model';
const MIN_PROBABILITY_KEY = 'routing_decision_min_probability';
export const DEFAULT_MIN_PROBABILITY = 0.5;
export const DECISION_TIMEOUT_MS = 1500;
/** Logged as the decision's client so Models → Decision shows routing usage. */
export const ROUTER_CLIENT = 'freellmapi-router';
// BeatAPI's free routes allow one successful call a minute per account: fine
// for /v1/decisions, far too slow to sit in front of every chat turn.
const AUTO_SKIP_PLATFORMS: ReadonlySet<string> = new Set(['beatapi']);

const SYSTEM_CHARS = 400;
const USER_CHARS = 1600;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 500;

const QUESTION = {
  type: 'choice' as const,
  instructions:
    'You route requests for an LLM gateway. Read the request and pick the routing strategy that serves it best. ' +
    'Judge by how hard the request is and what the person needs from the answer, not by its topic.',
  criteria: {
    smartest: 'Hard or high-stakes: answer quality matters most and waiting a bit longer is fine.',
    fastest: 'Simple or short: a quick answer matters most and a smaller model will do.',
    balanced: 'Ordinary request: a sensible mix of quality and speed.',
    reliable: 'Must work first time: strict formats, structured output or an automated step that cannot be retried by hand.',
  } satisfies Record<PresetStrategy, string>,
};

export interface DecisionRoutingSettings {
  /** A decision model id, or 'auto' (first available, BeatAPI skipped). */
  model: string;
  /** 0..1: below this top probability the request routes as Balanced. */
  minProbability: number;
}

export function getDecisionRoutingSettings(): DecisionRoutingSettings {
  const model = getSetting(DECISION_MODEL_KEY)?.trim() || 'auto';
  const raw = getSetting(MIN_PROBABILITY_KEY);
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return { model, minProbability: Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MIN_PROBABILITY };
}

export function setDecisionRoutingSettings(patch: Partial<DecisionRoutingSettings>): void {
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (!model) throw new Error('decision model must be a model id or "auto"');
    setSetting(DECISION_MODEL_KEY, model);
  }
  if (patch.minProbability !== undefined) {
    if (!Number.isFinite(patch.minProbability) || patch.minProbability < 0 || patch.minProbability > 1) {
      throw new Error('minProbability must be between 0 and 1');
    }
    setSetting(MIN_PROBABILITY_KEY, String(patch.minProbability));
  }
}

export type DecisionPickSource = 'decision' | 'cache' | 'low_confidence' | 'timeout' | 'unavailable' | 'error';

export interface DecisionPick {
  strategy: PresetStrategy;
  source: DecisionPickSource;
  /** The top probability the decision model gave (absent on fallback). */
  probability?: number;
  /** The decision model that answered. */
  model?: string;
}

// ── Per-turn cache ──────────────────────────────────────────────────────────
const cache = new Map<string, { pick: DecisionPick; at: number }>();

function cacheGet(key: string): DecisionPick | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.pick;
}

function cachePut(key: string, pick: DecisionPick): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { pick, at: Date.now() });
}

export function resetDecisionRoutingCache(): void {
  cache.clear();
  stats.counts = { smartest: 0, fastest: 0, balanced: 0, reliable: 0 };
  stats.fallbacks = {};
  stats.recent = [];
}

// ── Stats for the dashboard (in-memory, since boot) ─────────────────────────
const RECENT_MAX = 20;
const stats: {
  counts: Record<PresetStrategy, number>;
  fallbacks: Partial<Record<DecisionPickSource, number>>;
  recent: Array<DecisionPick & { at: number }>;
} = { counts: { smartest: 0, fastest: 0, balanced: 0, reliable: 0 }, fallbacks: {}, recent: [] };

function record(pick: DecisionPick): void {
  stats.counts[pick.strategy]++;
  if (pick.source !== 'decision' && pick.source !== 'cache') {
    stats.fallbacks[pick.source] = (stats.fallbacks[pick.source] ?? 0) + 1;
  }
  stats.recent.unshift({ ...pick, at: Date.now() });
  if (stats.recent.length > RECENT_MAX) stats.recent.length = RECENT_MAX;
}

export function getDecisionRoutingStats() {
  return { counts: { ...stats.counts }, fallbacks: { ...stats.fallbacks }, recent: stats.recent.slice() };
}

// ── What the decision model reads ───────────────────────────────────────────
function contentText(content: ChatContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** The system prompt's opening plus the latest user message, bounded so a huge
 *  conversation never turns into a huge decision prompt. Empty when there is
 *  no user text to judge (nothing to decide on: route as Balanced). */
export function decisionStateFor(messages: readonly ChatMessage[]): string {
  const system = messages.filter(m => m.role === 'system').map(m => contentText(m.content)).join('\n').trim();
  let user = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      user = contentText(messages[i].content).trim();
      if (user) break;
    }
  }
  if (!user) return '';
  const parts: string[] = [];
  if (system) parts.push(`System prompt (start): ${system.slice(0, SYSTEM_CHARS)}`);
  parts.push(`Request: ${user.slice(0, USER_CHARS)}`);
  return parts.join('\n\n');
}

function topProbability(answer: unknown, chosen: string): number | undefined {
  const probs = (answer as { probabilities?: unknown } | null)?.probabilities;
  if (!probs || typeof probs !== 'object') return undefined;
  const p = (probs as Record<string, unknown>)[chosen];
  return typeof p === 'number' && Number.isFinite(p) ? p : undefined;
}

/** Ask the decision model which preset fits this request. Never throws: every
 *  failure is a Balanced pick with the reason in `source`. */
export async function chooseRoutingPreset(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<DecisionPick> {
  const state = decisionStateFor(messages);
  if (!state) return { strategy: 'balanced', source: 'unavailable' };

  const settings = getDecisionRoutingSettings();
  // minProbability is part of the key: a pick cached under one threshold must
  // not answer a request judged under another (a low_confidence Balanced held
  // for the TTL would silently undo a threshold lowering — the whole point of
  // which is to let the model's own pick through).
  const key = createHash('sha256')
    .update(`${settings.model}\0${settings.minProbability}\0${state}`)
    .digest('hex');
  const cached = cacheGet(key);
  if (cached) return { ...cached, source: 'cache' };

  const timeout = AbortSignal.timeout(DECISION_TIMEOUT_MS);
  try {
    const out = await runDecision(
      { state, questions: { strategy: QUESTION } },
      {
        model: settings.model,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        clientAgent: ROUTER_CLIENT,
        skipPlatforms: settings.model === 'auto' ? AUTO_SKIP_PLATFORMS : undefined,
      },
    );
    const answer = out.answers.strategy as { choice?: unknown } | undefined;
    const choice = answer?.choice;
    if (typeof choice !== 'string' || !DECISION_PRESETS.includes(choice as PresetStrategy)) {
      return { strategy: 'balanced', source: 'error', model: out.model };
    }
    const probability = topProbability(answer, choice);
    const pick: DecisionPick = (probability ?? 0) >= settings.minProbability
      ? { strategy: choice as PresetStrategy, source: 'decision', probability, model: out.model }
      : { strategy: 'balanced', source: 'low_confidence', probability, model: out.model };
    cachePut(key, pick);
    return pick;
  } catch (err) {
    if (timeout.aborted) return { strategy: 'balanced', source: 'timeout' };
    const status = err instanceof DecisionError ? err.status : undefined;
    return { strategy: 'balanced', source: status === 503 || status === 429 ? 'unavailable' : 'error' };
  }
}

/**
 * Called by the chat surfaces before routing. When the 'decision' strategy is
 * active and the request did not pin a model, picks the preset for this
 * request and stores it on the request context for the router. Returns the
 * pick (for the X-FreeLLM-Routing-Strategy header), or null when the strategy
 * is something else or the request pins a model.
 */
export async function applyDecisionRouting(
  messages: readonly ChatMessage[],
  opts: { pinned?: boolean; signal?: AbortSignal } = {},
): Promise<DecisionPick | null> {
  if (getRoutingStrategy() !== 'decision' || opts.pinned) return null;
  const pick = await chooseRoutingPreset(messages, opts.signal);
  setRequestRoutingStrategy(pick.strategy);
  record(pick);
  return pick;
}

/** Header value: the preset, plus why when it is a fallback. */
export function routingStrategyHeader(pick: DecisionPick): string {
  return pick.source === 'decision' || pick.source === 'cache' ? pick.strategy : `${pick.strategy}; fallback=${pick.source}`;
}

/** Settings + since-boot stats for the dashboard, plus what the setup guide
 *  needs. Mirrors the chain routing would use: the pinned model, or with
 *  'auto' every enabled decision model except the skipped platforms.
 *  - `ready`: one of those has a usable key (else every request is Balanced).
 *  - `hasModels`: there is at least one such model to add a key for.
 *  - `keyPlatforms`: providers whose key would make it ready, in priority order. */
export function getDecisionRoutingStatus() {
  const settings = getDecisionRoutingSettings();
  const candidates = listDecisionModels()
    .filter(m => m.enabled)
    .filter(m => settings.model === 'auto' ? !AUTO_SKIP_PLATFORMS.has(m.platform) : m.modelId === settings.model)
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  return {
    ...settings,
    ready: candidates.some(m => m.healthyKeyCount > 0),
    hasModels: candidates.length > 0,
    keyPlatforms: [...new Set(candidates.map(m => m.platform))],
    ...getDecisionRoutingStats(),
  };
}
