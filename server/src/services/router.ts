import { getDb, getSetting, setSetting } from '../db/index.js';
import { getProvider, hasProvider, resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown, canUseProvider } from './ratelimit.js';
import {
  BANDIT_PRESETS, DEFAULT_STRATEGY, type RoutingStrategy, type RoutingWeights,
  reliabilityPosterior, expectedReliability, sampleBeta,
  speedScore, intelligenceScore, headroomFactor, rateLimitFactor, combineScore,
} from './scoring.js';
import { parseBudget } from '../lib/budget.js';
import type { BaseProvider } from '../providers/base.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { Database } from 'better-sqlite3';

class RouteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
}

// Chain row joined with the model fields the bandit needs to score it.
export interface ChainRow {
  model_db_id: number;
  priority: number;
  enabled: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  size_label: string;
  monthly_token_budget: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  supports_vision: number;
  supports_tools: number;
  context_window: number | null;
  // Custom models bind to the api_keys row carrying their endpoint (#212);
  // NULL for built-in platforms.
  key_id: number | null;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  // Daily limits for this model, so a 429 handler can tell a genuine daily
  // exhaustion (escalate the cooldown) from a transient per-minute spike.
  rpdLimit: number | null;
  tpdLimit: number | null;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    const decaySteps = Math.floor((now - existing.lastHit) / DECAY_INTERVAL_MS);
    existing.penalty = Math.max(0, existing.penalty - decaySteps * DECAY_AMOUNT);
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 * Pure read — does not mutate the entry; decay is applied lazily only when
 * recording a new hit (recordRateLimitHit) so the clock isn't reset on every
 * routing call.
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  const elapsed = Date.now() - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  const decayed = Math.max(0, entry.penalty - decaySteps * DECAY_AMOUNT);
  if (decayed === 0) {
    rateLimitPenalties.delete(modelDbId);
    return 0;
  }
  return decayed;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

// ── Routing strategy (persisted) ────────────────────────────────────────────
const STRATEGY_KEY = 'routing_strategy';
const CUSTOM_WEIGHTS_KEY = 'routing_custom_weights';
const VALID_STRATEGIES: RoutingStrategy[] = ['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom'];

export function getRoutingStrategy(): RoutingStrategy {
  const raw = getSetting(STRATEGY_KEY);
  return (raw && VALID_STRATEGIES.includes(raw as RoutingStrategy))
    ? (raw as RoutingStrategy)
    : DEFAULT_STRATEGY;
}

export function setRoutingStrategy(strategy: RoutingStrategy): void {
  if (!VALID_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown routing strategy: ${strategy}`);
  }
  setSetting(STRATEGY_KEY, strategy);
}

// ── Custom weights (persisted) ──────────────────────────────────────────────
// User-tuned weight vector for the 'custom' strategy. Stored normalized (sums
// to 1) so the dashboard percentages read cleanly; combineScore would tolerate
// any non-negative vector regardless. Falls back to the balanced preset until
// the user has saved their own.
export function getCustomWeights(): RoutingWeights {
  const raw = getSetting(CUSTOM_WEIGHTS_KEY);
  if (raw) {
    try {
      const w = JSON.parse(raw) as RoutingWeights;
      if (
        [w.reliability, w.speed, w.intelligence].every(v => Number.isFinite(v) && v >= 0) &&
        w.reliability + w.speed + w.intelligence > 0
      ) {
        return { reliability: w.reliability, speed: w.speed, intelligence: w.intelligence };
      }
    } catch { /* corrupt setting → fall through to default */ }
  }
  return { ...BANDIT_PRESETS.balanced };
}

export function setCustomWeights(weights: RoutingWeights): void {
  const { reliability, speed, intelligence } = weights;
  if (![reliability, speed, intelligence].every(v => Number.isFinite(v) && v >= 0)) {
    throw new Error('Custom weights must be non-negative numbers');
  }
  const sum = reliability + speed + intelligence;
  if (sum <= 0) {
    throw new Error('Custom weights must not all be zero');
  }
  setSetting(CUSTOM_WEIGHTS_KEY, JSON.stringify({
    reliability: reliability / sum,
    speed: speed / sum,
    intelligence: intelligence / sum,
  }));
}

function weightsFor(strategy: RoutingStrategy): RoutingWeights | null {
  if (strategy === 'priority') return null;
  if (strategy === 'custom') return getCustomWeights();
  return BANDIT_PRESETS[strategy];
}

// ── Analytics stats cache (decay-weighted) ──────────────────────────────────
// Instead of the fork's flat 7-day window (where a model that degrades today
// keeps a stale week-long average), each request is weighted by an exponential
// decay so recent behavior dominates while older data still stabilizes the
// estimate. We aggregate by (model, integer day age) in SQL — at most ~7 rows
// per model — then apply the per-bucket decay weight in JS.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 2; // a 2-day-old request counts half as much as a fresh one
const CACHE_TTL_MS = 60 * 1000;

interface ModelStats {
  successes: number;   // decay-weighted pseudo-count
  failures: number;    // decay-weighted pseudo-count
  tokPerSec: number;   // from successful requests only (0 = no data)
  avgTtfbMs: number | null; // null = no first-byte timing yet
  monthlyUsedTokens: number; // calendar-month usage, for the headroom guardrail
}

let statsCache: Map<string, ModelStats> | null = null;
let statsCacheTime = 0;

function decayWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

export function refreshStatsCache(db: Database, force = false): void {
  if (!force && statsCache && Date.now() - statsCacheTime < CACHE_TTL_MS) return;

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const buckets = db.prepare(`
    SELECT platform, model_id,
      CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) AS succ_out,
      SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END) AS succ_lat,
      SUM(CASE WHEN status = 'success' AND ttfb_ms IS NOT NULL THEN ttfb_ms ELSE 0 END) AS succ_ttfb_sum,
      SUM(CASE WHEN status = 'success' AND ttfb_ms IS NOT NULL THEN 1 ELSE 0 END) AS succ_ttfb_cnt
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform, model_id, age_days
  `).all(since) as Array<{
    platform: string; model_id: string; age_days: number; total: number; successes: number;
    succ_out: number; succ_lat: number; succ_ttfb_sum: number; succ_ttfb_cnt: number;
  }>;

  // Accumulate decay-weighted sums per model.
  const acc = new Map<string, {
    wSucc: number; wFail: number; wOut: number; wLat: number; wTtfbSum: number; wTtfbCnt: number;
  }>();
  for (const b of buckets) {
    const key = `${b.platform}:${b.model_id}`;
    const w = decayWeight(b.age_days);
    const a = acc.get(key) ?? { wSucc: 0, wFail: 0, wOut: 0, wLat: 0, wTtfbSum: 0, wTtfbCnt: 0 };
    a.wSucc += w * b.successes;
    a.wFail += w * (b.total - b.successes);
    a.wOut += w * b.succ_out;
    a.wLat += w * b.succ_lat;
    a.wTtfbSum += w * b.succ_ttfb_sum;
    a.wTtfbCnt += w * b.succ_ttfb_cnt;
    acc.set(key, a);
  }

  // Calendar-month token usage per model, for the headroom guardrail.
  const usageRows = db.prepare(`
    SELECT platform, model_id, COALESCE(SUM(input_tokens + output_tokens), 0) AS used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
      AND request_type = 'chat'
    GROUP BY platform, model_id
  `).all() as Array<{ platform: string; model_id: string; used: number }>;
  const usageMap = new Map(usageRows.map(r => [`${r.platform}:${r.model_id}`, r.used]));

  const next = new Map<string, ModelStats>();
  for (const [key, a] of acc) {
    next.set(key, {
      successes: a.wSucc,
      failures: a.wFail,
      tokPerSec: a.wLat > 0 ? (a.wOut * 1000) / a.wLat : 0,
      avgTtfbMs: a.wTtfbCnt > 0 ? a.wTtfbSum / a.wTtfbCnt : null,
      monthlyUsedTokens: usageMap.get(key) ?? 0,
    });
  }
  // Models with month usage but no recent window data still need a headroom number.
  for (const [key, used] of usageMap) {
    if (!next.has(key)) {
      next.set(key, { successes: 0, failures: 0, tokPerSec: 0, avgTtfbMs: null, monthlyUsedTokens: used });
    }
  }

  statsCache = next;
  statsCacheTime = Date.now();
}

// Composite intelligence: size_label is the cross-provider capability tier
// (issue #135 — intelligence_rank is only meaningful within one provider), so
// tier dominates and intelligence_rank breaks ties inside a tier.
const TIER_VALUE: Record<string, number> = { Frontier: 4, Large: 3, Medium: 2, Small: 1 };
function intelligenceComposite(sizeLabel: string, intelligenceRank: number): number {
  const tier = TIER_VALUE[sizeLabel] ?? 0;
  // tier*1000 keeps tiers strictly separated; -rank prefers lower rank in-tier.
  return tier * 1000 - intelligenceRank;
}

// Per-model axis values + the final score. `sampled` chooses Thompson sampling
// (for routing) vs. the expected value (for a stable dashboard display).
interface ScoredEntry {
  axes: { reliability: number; speed: number; intelligence: number };
  headroom: number;
  rateLimit: number;
  score: number;
}

function scoreChainEntry(
  entry: ChainRow,
  weights: RoutingWeights,
  intelMin: number,
  intelMax: number,
  sampled: boolean,
): ScoredEntry {
  const stats = statsCache?.get(`${entry.platform}:${entry.model_id}`);
  const successes = stats?.successes ?? 0;
  const failures = stats?.failures ?? 0;

  let reliability: number;
  if (sampled) {
    const { alpha, beta } = reliabilityPosterior(successes, failures);
    reliability = sampleBeta(alpha, beta);
  } else {
    reliability = expectedReliability(successes, failures);
  }

  const speed = speedScore(stats?.tokPerSec ?? 0, stats?.avgTtfbMs ?? null);
  const intelligence = intelligenceScore(
    intelligenceComposite(entry.size_label, entry.intelligence_rank), intelMin, intelMax,
  );

  const budget = parseBudget(entry.monthly_token_budget);
  const headroom = headroomFactor(stats?.monthlyUsedTokens ?? 0, budget);
  const rl = rateLimitFactor(getPenalty(entry.model_db_id));

  const score = combineScore({ reliability, speed, intelligence, headroom, rateLimit: rl }, weights);
  return { axes: { reliability, speed, intelligence }, headroom, rateLimit: rl, score };
}

/**
 * Order the enabled fallback chain for routing.
 *  - 'priority' strategy → legacy manual order + 429 penalty (unchanged).
 *  - bandit strategy      → convex score, manual priority as the deterministic
 *                           tiebreaker for (near-)equal scores.
 *
 * `sampled` controls the bandit branch: Thompson sampling (the default) for
 * live routing, where per-call randomness is the exploration the bandit needs;
 * the deterministic expected score (`sampled = false`) for callers that want a
 * STABLE ranking under the chosen strategy — the fusion panel, which should be a
 * faithful reflection of the user's picked strategy, not a re-sampled draw each
 * request. Priority mode is deterministic either way.
 */
function orderChain(chain: ChainRow[], strategy: RoutingStrategy, sampled = true): ChainRow[] {
  const weights = weightsFor(strategy);
  if (!weights) {
    // Legacy priority mode: base priority + 429 penalty, ascending.
    return chain
      .map(e => ({ e, eff: e.priority + getPenalty(e.model_db_id) }))
      .sort((a, b) => a.eff - b.eff || a.e.priority - b.e.priority)
      .map(x => x.e);
  }

  const composites = chain.map(e => intelligenceComposite(e.size_label, e.intelligence_rank));
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;

  return chain
    .map(e => ({ e, s: scoreChainEntry(e, weights, intelMin, intelMax, sampled).score }))
    // Higher score first; manual priority breaks ties so the chain still matters.
    .sort((a, b) => b.s - a.s || a.e.priority - b.e.priority)
    .map(x => x.e);
}

/**
 * Route a request to the best available model.
 *
 * Ordering depends on the configured strategy (see orderChain). Everything
 * downstream — key round-robin, cooldowns, token pre-checks, custom base_url
 * resolution, vision filtering, sticky sessions — is strategy-independent.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 * @param requireVision - only consider models that accept image input (#118)
 * @param requireTools - only consider models that emit structured tool_calls
 */
export interface ResolvedChain {
  chain: ChainRow[];
  strategyKey: string;
}

const GLOBAL_SORT_ALIASES: Record<string, string> = {
  smart: 'smart', smartest: 'smart', intelligence: 'smart',
  fast: 'fast', fastest: 'fast', speed: 'fast',
  cheap: 'cheap', cheapest: 'cheap', price: 'cheap', budget: 'cheap',
  reliable: 'reliable', reliability: 'reliable',
  balanced: 'balanced',
};

function getActiveChain(db: Database): ChainRow[] {
  const activeProfileSetting = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (activeProfileSetting) {
    const profileId = parseInt(activeProfileSetting.value, 10);
    const chain = db.prepare(`
      SELECT pm.model_db_id, pm.priority, pm.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.size_label, m.monthly_token_budget,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
             m.supports_tools, m.context_window, m.key_id
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
      WHERE pm.profile_id = ?
      ORDER BY pm.priority ASC
    `).all(profileId) as ChainRow[];
    
    if (chain.length > 0) return chain;
  }

  return db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as ChainRow[];
}

function getChainByProfileName(db: Database, name: string): ChainRow[] | null {
  const profile = db.prepare("SELECT id FROM profiles WHERE LOWER(name) = ?").get(name.toLowerCase()) as { id: number } | undefined;
  if (!profile) return null;

  return db.prepare(`
    SELECT pm.model_db_id, pm.priority, pm.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
    WHERE pm.profile_id = ?
    ORDER BY pm.priority ASC
  `).all(profile.id) as ChainRow[];
}

function getChainByGlobalSort(db: Database, globalAxis: string): ChainRow[] {
  const allEnabled = db.prepare(`
    SELECT m.id as model_db_id, 0 as priority, 1 as enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id
    FROM models m
    WHERE m.enabled = 1
  `).all() as ChainRow[];

  const strategyMap: Record<string, RoutingStrategy> = {
    'smart': 'smartest',
    'fast': 'fastest',
    'cheap': 'balanced',
    'reliable': 'reliable',
    'balanced': 'balanced'
  };
  const strat = strategyMap[globalAxis] || 'balanced';
  
  return orderChain(allEnabled, strat);
}

export function resolveRoutingChain(modelString: string | undefined): ResolvedChain {
  const db = getDb();

  if (!modelString || modelString.toLowerCase() === 'auto') {
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  const lower = modelString.toLowerCase();
  if (!lower.startsWith('auto:')) {
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  const suffix = lower.slice('auto:'.length).trim();
  if (!suffix) {
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  const globalAxis = GLOBAL_SORT_ALIASES[suffix];
  if (globalAxis) {
    const chain = getChainByGlobalSort(db, globalAxis);
    if (chain.length === 0) {
      const err = new Error(`No enabled models available for global sort '${suffix}'`) as any;
      err.status = 400;
      throw err;
    }
    return { chain, strategyKey: `auto:${globalAxis}` };
  }

  const chain = getChainByProfileName(db, suffix);
  if (!chain) {
    const err = new Error(`Profile '${suffix}' not found. Use 'auto' for the default profile, or call /v1/models for available options.`) as any;
    err.status = 400;
    throw err;
  }

  const enabledModels = chain.filter(e => e.enabled);
  if (enabledModels.length === 0) {
    const err = new Error(`Profile '${suffix}' has no enabled models. Add models to this profile in the dashboard.`) as any;
    err.status = 400;
    throw err;
  }

  return { chain, strategyKey: `auto:${suffix}` };
}

/**
 * Pick a usable key for ONE model and build its RouteResult, or return null if
 * the model has no key that can serve the request right now (all cooled down,
 * over quota, undecryptable, or no provider). This is the per-model key
 * round-robin previously inlined in routeRequest, factored out so the fusion
 * panel can HARD-PIN a model: rotate across that model's keys without ever
 * falling through to a different model (issue #326 — soft preference collapses
 * panel diversity under rate limits). Request-level filters (vision/tools/
 * context window) stay in the caller; this only does key selection + accounting
 * pre-checks.
 */
function selectKeyForModel(entry: ChainRow, estimatedTokens: number, skipKeys?: Set<string>): RouteResult | null {
  const db = getDb();

  if (!hasProvider(entry.platform as Platform)) return null;
  const provider = getProvider(entry.platform as Platform)!;

  const keys = db.prepare(
    "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all(entry.platform) as KeyRow[];
  if (keys.length === 0) return null;

  const limits = {
    rpm: entry.rpm_limit,
    rpd: entry.rpd_limit,
    tpm: entry.tpm_limit,
    tpd: entry.tpd_limit,
  };

  const rrKey = `${entry.platform}:${entry.model_id}`;
  let idx = roundRobinIndex.get(rrKey) ?? 0;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[idx % keys.length];
    idx++;

    // A custom model belongs to exactly one endpoint (#212); legacy rows
    // (key_id NULL) keep the old any-key match.
    if (entry.platform === 'custom' && entry.key_id != null && key.id !== entry.key_id) continue;

    const skipId = `${entry.platform}:${entry.model_id}:${key.id}`;
    if (skipKeys?.has(skipId)) continue;

    if (isOnCooldown(entry.platform, entry.model_id, key.id)) continue;
    if (!canUseProvider(entry.platform, key.id)) continue;
    if (!canMakeRequest(entry.platform, entry.model_id, key.id, limits)) continue;
    if (!canUseTokens(entry.platform, entry.model_id, key.id, estimatedTokens, limits)) continue;

    let decryptedKey: string;
    try {
      decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
    } catch {
      db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
        .run(key.id);
      continue;
    }

    const resolvedProvider = entry.platform === 'custom'
      ? resolveProvider('custom', key.base_url)
      : provider;
    if (!resolvedProvider) continue;

    roundRobinIndex.set(rrKey, idx);
    return {
      provider: resolvedProvider,
      modelId: entry.model_id,
      modelDbId: entry.model_db_id,
      apiKey: decryptedKey,
      keyId: key.id,
      platform: entry.platform,
      displayName: entry.display_name,
      rpdLimit: limits.rpd,
      tpdLimit: limits.tpd,
    };
  }

  // No usable key for this model. Advance the round-robin index anyway so we
  // don't get stuck re-trying the same exhausted key first next time.
  roundRobinIndex.set(rrKey, idx);
  return null;
}

/**
 * Fetch a single enabled model's chain row by its db id.
 */
function getModelChainRow(db: Database, modelDbId: number): ChainRow | undefined {
  return db.prepare(`
    SELECT m.id as model_db_id, 0 as priority, 1 as enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id
    FROM models m
    WHERE m.id = ? AND m.enabled = 1
  `).get(modelDbId) as ChainRow | undefined;
}

/**
 * Route to ONE specific model, hard-pinned. Rotates across that model's keys
 * (cooldowns, quotas, decryption all honored) but NEVER substitutes a different
 * model — returns null if the pinned model can't serve right now. This is what
 * makes a fusion panel genuinely diverse: a rate-limited slot is dropped, not
 * silently collapsed onto whatever else is available. `skipKeys` lets a slot
 * exclude keys it already failed on this request.
 */
export function routePinnedModel(modelDbId: number, estimatedTokens = 1000, skipKeys?: Set<string>): RouteResult | null {
  const db = getDb();
  const entry = getModelChainRow(db, modelDbId);
  if (!entry) return null;
  if (entry.context_window != null && estimatedTokens > entry.context_window) return null;
  if (entry.tpm_limit != null && estimatedTokens > entry.tpm_limit) return null;
  return selectKeyForModel(entry, estimatedTokens, skipKeys);
}

// A panel candidate surfaced to the fusion layer: enough to pick a diverse set
// and resolve each to a pinned dispatch.
export interface FusionCandidate {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  sizeLabel: string;
  supportsVision: number;
  supportsTools: number;
}

/**
 * The active fallback chain ordered by the current routing strategy, surfaced
 * for fusion panel selection. Same ordering the normal auto-router would walk,
 * so the panel's auto-pick draws from the highest-scored models first and the
 * fusion layer just needs to apply provider-diversity on top.
 */
export function getOrderedFusionChain(): FusionCandidate[] {
  const db = getDb();
  const strategy = getRoutingStrategy();
  if (strategy !== 'priority') refreshStatsCache(db);
  const chain = getActiveChain(db).filter(e => e.enabled);

  // Only consider models that can ACTUALLY be served RIGHT NOW — applying the
  // same gate selectKeyForModel uses when the router walks the chain: the model
  // must have a key that is enabled + healthy, NOT on cooldown (e.g. a
  // HuggingFace key benched for a day after a 402 "Payment Required"), within
  // the provider's daily request cap, and under its per-minute/day request
  // limits. Without this, a high-strategy-ranked model whose only key is
  // currently cooled down (huggingface/Kimi-K2.6) would claim a panel slot it
  // can't fill — surfacing as "no available key" and pushing out a usable model,
  // which also makes the panel look like it's ignoring the routing strategy.
  const usableKeys = db.prepare(
    "SELECT id, platform FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all() as { id: number; platform: string }[];
  const keysByPlatform = new Map<string, number[]>();
  for (const k of usableKeys) {
    const arr = keysByPlatform.get(k.platform);
    if (arr) arr.push(k.id); else keysByPlatform.set(k.platform, [k.id]);
  }
  const servable = chain.filter(e => {
    const keyIds = keysByPlatform.get(e.platform);
    if (!keyIds) return false;
    const limits = { rpm: e.rpm_limit, rpd: e.rpd_limit, tpm: e.tpm_limit, tpd: e.tpd_limit };
    return keyIds.some(kid =>
      (e.key_id == null || kid === e.key_id) &&
      !isOnCooldown(e.platform, e.model_id, kid) &&
      canUseProvider(e.platform, kid) &&
      canMakeRequest(e.platform, e.model_id, kid, limits),
    );
  });

  // Deterministic (expected-score) ordering so the panel faithfully follows the
  // user's picked routing strategy instead of re-sampling a fresh draw each call.
  const ordered = orderChain(servable, strategy, false);
  return ordered.map(e => ({
    modelDbId: e.model_db_id,
    platform: e.platform,
    modelId: e.model_id,
    displayName: e.display_name,
    sizeLabel: e.size_label,
    supportsVision: e.supports_vision,
    supportsTools: e.supports_tools,
  }));
}

/**
 * Resolve an explicit model id (as a client would type it) to a fusion
 * candidate, or null when it isn't a known enabled model. Prefers an enabled
 * row; dedupes a model id that exists on multiple platforms by intelligence
 * rank, matching how /v1/models picks a representative row.
 */
export function resolveFusionCandidate(modelId: string): FusionCandidate | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name,
           m.size_label, m.supports_vision, m.supports_tools
    FROM models m
    WHERE m.model_id = ? AND m.enabled = 1
    ORDER BY m.intelligence_rank ASC, m.id ASC
    LIMIT 1
  `).get(modelId) as {
    model_db_id: number; platform: string; model_id: string; display_name: string;
    size_label: string; supports_vision: number; supports_tools: number;
  } | undefined;
  if (!row) return null;
  return {
    modelDbId: row.model_db_id,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name,
    sizeLabel: row.size_label,
    supportsVision: row.supports_vision,
    supportsTools: row.supports_tools,
  };
}

export function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number, requireVision = false, requireTools = false, skipModels?: Set<number>, prefetchedChain?: ChainRow[]): RouteResult {
  const db = getDb();

  const strategy = getRoutingStrategy();
  if (strategy !== 'priority') refreshStatsCache(db);

  const chain = prefetchedChain ?? getActiveChain(db).filter(e => e.enabled);

  const sortedChain = orderChain(chain, strategy);

  // Sticky session / Explicit pinning: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx >= 0) {
      if (idx > 0) {
        const [preferred] = sortedChain.splice(idx, 1);
        sortedChain.unshift(preferred);
      }
    } else {
      // The requested model is not in the current routing chain (e.g. it's a
      // custom model or not added to the active profile). We must fulfill the
      // explicit request by injecting it at the front.
      const pinnedRow = db.prepare(`
        SELECT m.id as model_db_id, 0 as priority, 1 as enabled,
               m.platform, m.model_id, m.display_name, m.intelligence_rank,
               m.size_label, m.monthly_token_budget,
               m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
               m.supports_tools, m.context_window, m.key_id
        FROM models m
        WHERE m.id = ? AND m.enabled = 1
      `).get(preferredModelDbId) as ChainRow | undefined;
      
      if (pinnedRow) {
        sortedChain.unshift(pinnedRow);
      }
    }
  }

  for (const entry of sortedChain) {
    // Models the caller has ruled out for this request — e.g. a 404
    // "model removed upstream" already seen this request: trying the same
    // model again on a different key would just burn another attempt on the
    // same dead route (PR #111, credits @barbotkonv).
    if (skipModels?.has(entry.model_db_id)) continue;

    // Vision requests skip text-only models — including a sticky/preferred one,
    // which is correct: don't pin an image turn to a model that can't see it.
    if (requireVision && !entry.supports_vision) continue;

    // Tool-bearing requests skip models that can't emit structured tool_calls.
    // A model that "answers" a tool request with the call serialized as text
    // looks successful at the transport level while the client's harness sees
    // nothing — worse than a failover. Applies to sticky models too, same
    // reasoning as vision above.
    if (requireTools && !entry.supports_tools) continue;

    // Context-aware routing: skip a model whose context window can't hold the
    // request, so a large prompt never selects a small-context model and burns
    // a failover hop on a 413 "request too large" (#167). Only enforced when we
    // know the model's window; estimatedTokens already includes the reserved
    // output (max_tokens), so this is the total-context check the model must
    // satisfy. A 413 that slips through is still retryable downstream, and the
    // failed model is put on cooldown — so this is a fast-path, not the only
    // guard. If every model is too small, the loop falls through and the caller
    // gets the normal "all models exhausted" error rather than a wasted sweep.
    if (entry.context_window != null && estimatedTokens > entry.context_window) continue;

    // Same guard for a model with a small per-minute token budget: a single
    // request that alone exceeds tpm_limit can never fit one minute of quota and
    // returns a guaranteed 413 (e.g. Groq gpt-oss-120b: 131k context but 8k TPM).
    // estimatedTokens already includes reserved output, mirroring the check above.
    if (entry.tpm_limit != null && estimatedTokens > entry.tpm_limit) continue;

    // Key selection + accounting pre-checks for this one model. Returns the
    // first usable key's RouteResult, or null when the model has no key that
    // can serve right now — in which case we fall through to the next model in
    // the sorted chain for THIS request (no explicit penalty needed).
    const route = selectKeyForModel(entry, estimatedTokens, skipKeys);
    if (route) return route;
  }

  throw new RouteError('All models exhausted. Add more API keys or wait for rate limits to reset.', 429);
}

/**
 * Per-model routing scores for the dashboard. Deterministic (expected
 * reliability, not sampled) so the table is stable between polls. Returns the
 * axis breakdown plus the final score under the active strategy's weights.
 */
export interface RoutingScore {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  reliability: number;
  speed: number;
  intelligence: number;
  headroom: number;
  rateLimit: number;
  score: number;
  totalRequests: number; // decay-weighted observations
}

export function getRoutingScores(): { strategy: RoutingStrategy; weights: RoutingWeights | null; customWeights: RoutingWeights; scores: RoutingScore[] } {
  const db = getDb();
  const strategy = getRoutingStrategy();
  refreshStatsCache(db);

  const chain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE m.enabled = 1
  `).all() as ChainRow[];

  // For display we score under 'balanced' weights when in priority mode, so the
  // table still shows a meaningful ranking even with the bandit turned off.
  const weights = weightsFor(strategy) ?? BANDIT_PRESETS.balanced;
  const composites = chain.map(e => intelligenceComposite(e.size_label, e.intelligence_rank));
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;

  const scores: RoutingScore[] = chain.map(entry => {
    const scored = scoreChainEntry(entry, weights, intelMin, intelMax, false);
    const stats = statsCache?.get(`${entry.platform}:${entry.model_id}`);
    return {
      modelDbId: entry.model_db_id,
      platform: entry.platform,
      modelId: entry.model_id,
      displayName: entry.display_name,
      enabled: entry.enabled === 1,
      reliability: scored.axes.reliability,
      speed: scored.axes.speed,
      intelligence: scored.axes.intelligence,
      headroom: scored.headroom,
      rateLimit: scored.rateLimit,
      score: scored.score,
      totalRequests: Math.round((stats?.successes ?? 0) + (stats?.failures ?? 0)),
    };
  }).sort((a, b) => b.score - a.score);

  // customWeights is always present (the saved vector, or the balanced default)
  // so the dashboard's custom-weight sliders can render even before the user
  // has saved their own — distinct from `weights`, which is null in priority
  // mode and the active preset otherwise.
  return { strategy, weights: weightsFor(strategy), customWeights: getCustomWeights(), scores };
}

// Whether at least one vision-capable model is enabled in the fallback chain.
// Used to give image requests a clear "enable a vision model" error instead of
// the generic exhaustion message when none is configured (#118, #125).
export function hasEnabledVisionModel(): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1 AND m.supports_vision = 1
  `).get() as { cnt: number };
  return row.cnt > 0;
}

// Whether at least one tool-capable model is enabled in the fallback chain.
// Same role as hasEnabledVisionModel: a clear up-front error for tool-bearing
// requests beats routing them to a model that mangles the tool call.
export function hasEnabledToolsModel(): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1 AND m.supports_tools = 1
  `).get() as { cnt: number };
  return row.cnt > 0;
}
