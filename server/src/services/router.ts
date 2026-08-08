import { getDb, getSetting, setSetting } from '../db/index.js';
import { getProvider, hasProvider, resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import {
  canMakeRequest,
  canUseTokens,
  isOnCooldown,
  canUseProvider,
  canUseProviderMinute,
  canUseProviderTokens,
  canUseKeyConcurrency,
  acquireLease,
  releaseLease,
  getSoonestCooldownExpiry,
} from './ratelimit.js';
import {
  BANDIT_PRESETS, DEFAULT_STRATEGY, type RoutingStrategy, type RoutingWeights,
  reliabilityPosterior, expectedReliability, sampleBeta,
  speedScore, intelligenceScore, intelligenceComposite, headroomFactor, rateLimitFactor, combineScore,
  observedSpeedRank, TIMEOUT_LATENCY_CAP_MS,
} from './scoring.js';
import { TIMEOUT_ERROR_MARKERS } from '../lib/error-classify.js';
import { modelsWithOverriddenField } from './model-state.js';
import { parseBudget } from '../lib/budget.js';
import { platformDropsResponseFormat } from '../lib/sampling-params.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdForDispatch } from './model-groups.js';
import { getActiveProfileId } from './profile-models.js';
import { customEndpointKeyIds } from './custom-endpoint.js';
import { modelStatsKey, endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import type { BaseProvider } from '../providers/base.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { Db } from '../db/types.js';

class RouteError extends Error {
  status: number;
  // Per-model disposition of the chain at the moment routing gave up: one line
  // per considered model with the reason it could not serve (no key, cooldown,
  // provider cap, rpm/rpd, tpm/tpd, context too small, …). Populated only on the
  // synchronous "all exhausted" throw, where NO upstream was tried and nothing
  // else logs WHY the pool was empty (issue _1: opaque routing_error 429).
  diagnostics?: string[];
  constructor(message: string, status: number, diagnostics?: string[]) {
    super(message);
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

// Human-readable retry ETA from a cooldown expiry timestamp (#423). Null when
// nothing is cooling down or it already lapsed.
export function formatResetEta(soonestResetMs: number | null | undefined, now = Date.now()): string | null {
  if (soonestResetMs == null) return null;
  const deltaMs = soonestResetMs - now;
  if (deltaMs <= 0) return null;
  const secs = Math.round(deltaMs / 1000);
  if (secs < 90) return `~${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `~${mins}m`;
  return `~${Math.round(mins / 60)}h`;
}

const EXHAUSTION_ADVICE = 'Add more API keys or wait for rate limits to reset.';

// Roll the per-model diagnostics (see RouteError.diagnostics) up into a short,
// client-safe summary so an exhausted caller learns WHY the pool was empty
// instead of a bare "All models exhausted" (#423). Buckets are aggregate
// counts only — no key material, no per-key detail. Classifies off the whole
// line (model ids can contain ':' so splitting label from reason is unsafe).
export function summarizeExhaustion(
  diag: string[] | undefined,
  soonestResetMs?: number | null,
  now = Date.now(),
): string {
  const eta = formatResetEta(soonestResetMs, now);
  const etaSuffix = eta ? ` Soonest reset ${eta}.` : '';
  if (!diag || diag.length === 0) {
    return `All models exhausted. ${EXHAUSTION_ADVICE}${etaSuffix}`;
  }

  const counts: Record<string, number> = {};
  const bump = (bucket: string) => { counts[bucket] = (counts[bucket] ?? 0) + 1; };
  for (const line of diag) {
    const l = line.toLowerCase();
    if (l.includes('no provider registered')) bump('unsupported provider');
    else if (/no enabled\+healthy key|no usable key|decrypt-error/.test(l)) bump('no usable key configured');
    else if (l.includes('< estimated')) bump('prompt too large for the model');
    else if (l.includes('no vision support')) bump('model lacks vision');
    else if (l.includes('no tool-calling support')) bump('model lacks tool-calling');
    else if (l.includes('drops response_format')) bump('platform cannot honor response_format');
    else if (/ruled out|already-failed/.test(l)) bump('failed earlier this request');
    else if (/cooldown|rpm|rpd|tpm|tpd|provider-daily-cap/.test(l)) bump('rate-limited or on cooldown');
    else bump('unavailable');
  }
  // Most actionable buckets first.
  const order = [
    'rate-limited or on cooldown',
    'no usable key configured',
    'prompt too large for the model',
    'model lacks vision',
    'model lacks tool-calling',
    'platform cannot honor response_format',
    'failed earlier this request',
    'unsupported provider',
    'unavailable',
  ];
  const parts = order.filter(b => counts[b]).map(b => `${counts[b]} ${b}`);
  const total = diag.length;
  return `All models exhausted: ${total} route${total === 1 ? '' : 's'} checked (${parts.join(', ')}). ${EXHAUSTION_ADVICE}${etaSuffix}`;
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
  // Optional JSON array of model_id strings this key may serve; NULL = every
  // model of its platform (#657).
  model_scope_json: string | null;
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
  // The endpoint this row belongs to ('' for catalog platforms). Two relays can
  // each hold a row for the same model_id, and everything scored or rate-limited
  // per model has to tell them apart (#651).
  endpoint_scope: string;
  /**
   * Ordering TIER, ahead of score. 0 (the default, and what every other chain
   * builder produces) is a normal candidate. A higher number is a fallback that
   * may only serve once every lower tier is exhausted, however good its live
   * numbers are — currently set only for a member reached through a group's
   * auto-derived slug rather than the model id the client actually wrote, where
   * answering on score alone would be a silent substitution (#651).
   */
  match_tier?: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  /**
   * The custom endpoint this route belongs to, '' for catalog platforms (#651).
   * Carried on the route so the failure path can attribute a retirement signal
   * to ONE relay instead of every relay serving the same model id.
   */
  endpointScope: string;
  // Daily limits for this model, so a 429 handler can tell a genuine daily
  // exhaustion (escalate the cooldown) from a transient per-minute spike.
  rpdLimit: number | null;
  tpdLimit: number | null;
  /**
   * Frees the in-flight lease taken when this route was selected. Idempotent.
   *
   * Callers should invoke it once the attempt is finished, however it finished —
   * the shared fallback loop does so from a `finally` so no exit path can leak.
   *
   * Optional, and every call site uses `release?.()`, for a specific reason: the
   * invocation sits in a `finally`, and a TypeError thrown there would *replace*
   * the in-flight provider exception with a useless one, turning a diagnosable
   * 429 into a mystery 500. A route that arrives without it (a test double, a
   * future construction path) should quietly fall back to the lease ageing out
   * rather than destroy the error being propagated.
   */
  release?: () => void;
}

// ── Routing token estimate: cap the reserved OUTPUT, not the full max_tokens ──
// A client can request a huge max_tokens (e.g. 32000) it will never actually
// emit. Reserving that full amount against every model's context window and TPM
// budget falsely excludes the entire free pool (TPM 6k-30k) and returns a bogus
// "all models exhausted" 429 with ZERO upstream calls (#470). Providers meter
// ACTUAL tokens, so under-reserving only risks an upstream 429/413 the retry
// loop already handles, whereas over-reserving starves routing. For routing and
// the context-window / TPM filters we therefore reserve at most this many output
// tokens; the INPUT estimate is still counted in full so a genuinely large
// prompt still (correctly) skips a too-small model.
export const OUTPUT_RESERVE_CAP = 2000;

/**
 * Output tokens to reserve for routing/filter purposes: the requested max_tokens
 * clamped to OUTPUT_RESERVE_CAP (default 1000 when the client omitted it, matching
 * the historical fallback). Callers add this to their INPUT estimate before
 * calling routeRequest / routePinnedModel.
 */
export function routingReserveTokens(requestedMaxTokens: number | null | undefined): number {
  const requested = requestedMaxTokens != null && requestedMaxTokens > 0 ? requestedMaxTokens : 1000;
  return Math.min(requested, OUTPUT_RESERVE_CAP);
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
const EXPLORE_KEY = 'routing_explore_enabled';
const COMMUNITY_PRIOR_KEY = 'routing_community_prior';
const COMMUNITY_PRIOR_ENABLED_KEY = 'routing_community_prior_enabled';

/** Chance per request that an unmeasured model gets tried first when the
 *  exploration toggle is on. The bandit's Thompson sampling already explores
 *  automatically; this guarantees a floor so models with no reliability/speed
 *  data still get sampled instead of being starved by prior-heavy rivals. */
export const EXPLORE_CHANCE = 0.1;
/** A model counts as "has data" once its decay-weighted success+failure
 *  pseudo-count reaches this many samples. */
export const EXPLORE_MIN_SAMPLES = 5;
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

// ── Exploration toggle (persisted) ─────────────────────────────────────────
// Off by default: existing routing behavior unchanged. When on, routeRequest
// gives unmeasured models a guaranteed chance to be tried (EXPLORE_CHANCE) so
// they acquire reliability/speed samples instead of losing every bandit draw.
export function getExploreEnabled(): boolean {
  return getSetting(EXPLORE_KEY) === '1';
}

export function setExploreEnabled(enabled: boolean): void {
  setSetting(EXPLORE_KEY, enabled ? '1' : '0');
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

// ── Community reliability prior (persisted) ────────────────────────────────
// Aggregated, de-poisoned counts from other self-hosted instances, folded into
// the Beta posterior as a starting balance so a brand-new model isn't blind
// (#685 follow-up). Keyed "platform:model_id" (endpoint-scoped keys use the
// same modelStatsKey form). Local samples dilute it automatically.
//
// Opt-in: priors only reach the posterior when routing_community_prior_enabled
// is on (default off). Server-side only for now — there is deliberately no
// ingestion path yet, so the flag pins the opt-in semantics before one lands.
type CommunityPriorMap = Record<string, { successes: number; failures: number }>;

/** Ceiling on a single prior's effective sample size. Local counts are
 *  decay-weighted (2-day half-life — a busy install still only carries on the
 *  order of a hundred effective samples), so an unbounded, undecayed community
 *  count would drown local evidence forever and collapse the Thompson-sampling
 *  variance to zero. Capping at ~50 pseudo-observations keeps a prior worth
 *  roughly half the local evidence at most: enough to seed a brand-new model,
 *  cheap for real local traffic to override. */
export const COMMUNITY_PRIOR_MAX_SAMPLES = 50;

/** Validate a raw prior map and cap each entry's effective sample size.
 *  Shared by the read path and the write path so a value is bounded no matter
 *  how it entered (fresh set, legacy stored blob, hand-edited settings row).
 *  Invalid entries (negative, all-zero, no ':') are dropped; oversized ones
 *  are rescaled preserving the success/failure ratio (980/20 → 49/1). */
function sanitizeCommunityPriors(priors: unknown): CommunityPriorMap {
  const clean: CommunityPriorMap = {};
  if (!priors || typeof priors !== 'object') return clean;
  for (const [key, v] of Object.entries(priors as Record<string, { successes: number; failures: number }>)) {
    if (
      key.includes(':') &&
      v && typeof v === 'object' &&
      Number.isFinite(v.successes) && v.successes >= 0 &&
      Number.isFinite(v.failures) && v.failures >= 0 &&
      v.successes + v.failures > 0
    ) {
      const total = v.successes + v.failures;
      const scale = total > COMMUNITY_PRIOR_MAX_SAMPLES ? COMMUNITY_PRIOR_MAX_SAMPLES / total : 1;
      const entry = { successes: Math.round(v.successes * scale), failures: Math.round(v.failures * scale) };
      if (entry.successes + entry.failures > 0) clean[key] = entry;
    }
  }
  return clean;
}

// Parsed-prior cache, same 60s shape as the stats cache: routing reads the map
// once per chain entry (and once per key in orderKeysByScore), so hitting
// sqlite + JSON.parse on every lookup is pure waste. Invalidated by the two
// setters and by refreshStatsCache, so tests and future ingestion see writes
// immediately.
let communityPriorCache: { map: CommunityPriorMap; enabled: boolean } | null = null;
let communityPriorCacheTime = 0;

function communityPriorState(): { map: CommunityPriorMap; enabled: boolean } {
  const now = Date.now();
  if (communityPriorCache && now - communityPriorCacheTime < CACHE_TTL_MS) return communityPriorCache;
  let map: CommunityPriorMap = {};
  const raw = getSetting(COMMUNITY_PRIOR_KEY);
  if (raw) {
    try {
      map = sanitizeCommunityPriors(JSON.parse(raw));
    } catch { /* corrupt setting → no priors */ }
  }
  communityPriorCache = { map, enabled: getSetting(COMMUNITY_PRIOR_ENABLED_KEY) === '1' };
  communityPriorCacheTime = now;
  return communityPriorCache;
}

function invalidateCommunityPriorCache(): void {
  communityPriorCache = null;
}

/** Whether stored community priors are folded into the posterior. Default off. */
export function getCommunityPriorEnabled(): boolean {
  return communityPriorState().enabled;
}

export function setCommunityPriorEnabled(enabled: boolean): void {
  setSetting(COMMUNITY_PRIOR_ENABLED_KEY, enabled ? '1' : '0');
  invalidateCommunityPriorCache();
}

/** Community prior for one model, or undefined when none is stored.
 *  Raw read — ignores the enabled flag; routing goes through
 *  activeCommunityPrior, which honors it. */
export function getCommunityPrior(platform: string, modelId: string, endpointScope?: string):
  { successes: number; failures: number } | undefined {
  return communityPriorState().map[modelStatsKey(platform, modelId, endpointScope)];
}

/** Gated read for routing: undefined unless the opt-in flag is on. */
function activeCommunityPrior(platform: string, modelId: string, endpointScope?: string):
  { successes: number; failures: number } | undefined {
  const state = communityPriorState();
  return state.enabled ? state.map[modelStatsKey(platform, modelId, endpointScope)] : undefined;
}

/** Replace the whole community-prior map (e.g. after an aggregation fetch).
 *  Invalid entries are dropped and oversized ones capped, never stored raw. */
export function setCommunityPriors(priors: CommunityPriorMap): number {
  const clean = sanitizeCommunityPriors(priors);
  setSetting(COMMUNITY_PRIOR_KEY, JSON.stringify(clean));
  invalidateCommunityPriorCache();
  return Object.keys(clean).length;
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
  // Output tokens from successes over the time spent on successes AND timeouts
  // (#619 — see the accumulator below); 0 = no data.
  tokPerSec: number;
  avgTtfbMs: number | null; // null = no first-byte timing yet
  monthlyUsedTokens: number; // calendar-month usage, for the headroom guardrail
  // Decay-weighted requests that actually SAY something about speed: successes
  // plus timeouts. A model can have hundreds of 401s and still no speed signal,
  // so this — not successes + failures — is what gates the observed speed_rank
  // writeback.
  speedSamples: number;
}

// Per-key slice of the same window (#580): reliability/speed observed through
// ONE credential of a model. With unified groups, a model's traffic can span
// several keys whose real quality diverges (expired, quota-drained, region-
// blocked keys fail while siblings are fine) — the rolled-up model bucket
// can't see that, so key selection needs its own buckets.
interface KeyStats {
  successes: number;   // decay-weighted pseudo-count
  failures: number;    // decay-weighted pseudo-count
  tokPerSec: number;   // from successful requests only (0 = no data)
  avgTtfbMs: number | null;
}

// Keyed by modelStatsKey(): "platform:model_id" for catalog models, and
// "custom:model_id@base_url" for a relay model that carries an endpoint scope
// (#651). A single-endpoint install produces the same keys it always did.
let statsCache: Map<string, ModelStats> | null = null;
let keyStatsCache: Map<string, KeyStats> | null = null; // "platform:model_id:key_id"
let statsCacheTime = 0;

function decayWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

// SQL predicate for "this row is a timed-out request" (#619). A timeout is an
// error row whose text carries one of the shared timeout markers
// (lib/error-classify.ts), which is also what the failover attempt trail
// classifies on. 'canceled' rows (#752 — client hung up) never reach this
// predicate: the stats query below filters them out entirely, because a
// vanished client says nothing about the model's reliability or speed. The
// markers are hard-coded lowercase identifiers from our own source, never
// user input, so interpolating them into the LIKE list is safe.
const IS_TIMEOUT_SQL = `(status != 'success' AND (${
  TIMEOUT_ERROR_MARKERS.map(m => `LOWER(COALESCE(error, '')) LIKE '%${m}%'`).join(' OR ')
}))`;

/** api_keys.id → endpoint scope, for every custom credential on record (#651). */
function customEndpointScopes(db: Db): Map<number, string> {
  const rows = db.prepare("SELECT id, base_url FROM api_keys WHERE platform = 'custom'")
    .all() as { id: number; base_url: string | null }[];
  return new Map(rows.map(r => [r.id, endpointScopeForBaseUrl(r.base_url)]));
}

export function refreshStatsCache(db: Db, force = false): void {
  if (!force && statsCache && Date.now() - statsCacheTime < CACHE_TTL_MS) return;

  // Re-read the community priors alongside the stats they season, so a forced
  // refresh (tests, admin actions) never routes on a stale prior snapshot.
  invalidateCommunityPriorCache();

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  // Grouped by (model, key, day age): still a handful of rows per model — key
  // count × ≤7 day buckets — so the finer grain keeps the same one-query,
  // 60s-cached shape. Aggregated two ways below: rolled up per model (ordering)
  // and per key (in-model key selection, #580).
  const buckets = db.prepare(`
    SELECT platform, model_id, key_id,
      CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) AS succ_out,
      SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END) AS succ_lat,
      SUM(CASE WHEN status = 'success' AND ttfb_ms IS NOT NULL THEN ttfb_ms ELSE 0 END) AS succ_ttfb_sum,
      SUM(CASE WHEN status = 'success' AND ttfb_ms IS NOT NULL THEN 1 ELSE 0 END) AS succ_ttfb_cnt,
      SUM(CASE WHEN ${IS_TIMEOUT_SQL} THEN 1 ELSE 0 END) AS timeouts,
      SUM(CASE WHEN ${IS_TIMEOUT_SQL} THEN MIN(MAX(latency_ms, 0), ${TIMEOUT_LATENCY_CAP_MS}) ELSE 0 END) AS timeout_lat
    FROM requests
    WHERE created_at >= ? AND status <> 'canceled'
    GROUP BY platform, model_id, key_id, age_days
  `).all(since) as Array<{
    platform: string; model_id: string; key_id: number | null; age_days: number; total: number; successes: number;
    succ_out: number; succ_lat: number; succ_ttfb_sum: number; succ_ttfb_cnt: number;
    timeouts: number; timeout_lat: number;
  }>;

  // Accumulate decay-weighted sums per model AND per key.
  //
  // Timeouts (#619) land in the SAME latency/TTFB accumulators as successes,
  // because that is what they are: time spent, nothing produced. Each one adds
  // its capped wall-clock latency to the throughput denominator with zero
  // output tokens, and that same figure as a first-byte sample — which is past
  // TTFB_WORST_MS, so it scores no latency credit. Net effect: a model that
  // times out constantly can no longer keep a stellar speed number just because
  // its handful of successes were quick.
  interface Acc { wSucc: number; wFail: number; wOut: number; wLat: number; wTtfbSum: number; wTtfbCnt: number; wTimeouts: number }
  const emptyAcc = (): Acc => ({ wSucc: 0, wFail: 0, wOut: 0, wLat: 0, wTtfbSum: 0, wTtfbCnt: 0, wTimeouts: 0 });
  const addBucket = (a: Acc, w: number, b: (typeof buckets)[number]): void => {
    a.wSucc += w * b.successes;
    a.wFail += w * (b.total - b.successes);
    a.wOut += w * b.succ_out;
    a.wLat += w * (b.succ_lat + b.timeout_lat);
    a.wTtfbSum += w * (b.succ_ttfb_sum + b.timeout_lat);
    a.wTtfbCnt += w * (b.succ_ttfb_cnt + b.timeouts);
    a.wTimeouts += w * b.timeouts;
  };
  // Which endpoint each custom credential belongs to, so a request logged
  // against relay A's key lands in relay A's bucket and nowhere else (#651).
  // `requests` has always recorded key_id, so pre-migration history splits
  // correctly too; rows whose key is gone (or that never had one) fall into the
  // un-scoped bucket, which only un-scoped rows read.
  const scopeByKeyId = customEndpointScopes(db);
  const scopeOf = (platform: string, keyId: number | null): string =>
    platform === 'custom' && keyId != null ? (scopeByKeyId.get(keyId) ?? '') : '';

  const acc = new Map<string, Acc>();
  const keyAcc = new Map<string, Acc>();
  for (const b of buckets) {
    const key = modelStatsKey(b.platform, b.model_id, scopeOf(b.platform, b.key_id));
    const w = decayWeight(b.age_days);
    let a = acc.get(key);
    if (!a) acc.set(key, a = emptyAcc());
    addBucket(a, w, b);
    if (b.key_id != null) {
      const kk = `${key}:${b.key_id}`;
      let ka = keyAcc.get(kk);
      if (!ka) keyAcc.set(kk, ka = emptyAcc());
      addBucket(ka, w, b);
    }
  }

  // Calendar-month token usage per model, for the headroom guardrail.
  const usageRows = db.prepare(`
    SELECT platform, model_id, key_id, COALESCE(SUM(input_tokens + output_tokens), 0) AS used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
      AND request_type = 'chat'
    GROUP BY platform, model_id, key_id
  `).all() as Array<{ platform: string; model_id: string; key_id: number | null; used: number }>;
  const usageMap = new Map<string, number>();
  for (const r of usageRows) {
    const key = modelStatsKey(r.platform, r.model_id, scopeOf(r.platform, r.key_id));
    usageMap.set(key, (usageMap.get(key) ?? 0) + r.used);
  }

  const next = new Map<string, ModelStats>();
  for (const [key, a] of acc) {
    next.set(key, {
      successes: a.wSucc,
      failures: a.wFail,
      tokPerSec: a.wLat > 0 ? (a.wOut * 1000) / a.wLat : 0,
      avgTtfbMs: a.wTtfbCnt > 0 ? a.wTtfbSum / a.wTtfbCnt : null,
      monthlyUsedTokens: usageMap.get(key) ?? 0,
      speedSamples: a.wSucc + a.wTimeouts,
    });
  }
  // Models with month usage but no recent window data still need a headroom number.
  for (const [key, used] of usageMap) {
    if (!next.has(key)) {
      next.set(key, { successes: 0, failures: 0, tokPerSec: 0, avgTtfbMs: null, monthlyUsedTokens: used, speedSamples: 0 });
    }
  }

  const nextKeys = new Map<string, KeyStats>();
  for (const [kk, a] of keyAcc) {
    nextKeys.set(kk, {
      successes: a.wSucc,
      failures: a.wFail,
      tokPerSec: a.wLat > 0 ? (a.wOut * 1000) / a.wLat : 0,
      avgTtfbMs: a.wTtfbCnt > 0 ? a.wTtfbSum / a.wTtfbCnt : null,
    });
  }

  statsCache = next;
  keyStatsCache = nextKeys;
  statsCacheTime = Date.now();

  // Natural tail of a recompute: fold what we just measured back into
  // models.speed_rank (#619). Never allowed to break routing — the caches above
  // are already published, and a failed write just means the column keeps its
  // previous value until the next pass.
  if (Date.now() - speedRankWriteTime >= SPEED_RANK_WRITE_INTERVAL_MS) {
    speedRankWriteTime = Date.now();
    try {
      writeObservedSpeedRanks(db);
    } catch (e) {
      console.error('Failed to write observed speed ranks:', e);
    }
  }
}

// ── Observed speed_rank writeback (#619) ────────────────────────────────────
// models.speed_rank is the catalog's hand-assigned speed ordering and drives
// the dashboard's sort-by-speed preset. It was only ever WRITTEN by the seed
// migrations, catalog sync, and an explicit user override — never by anything
// that had actually watched the model run, so a relay model that hangs on half
// its calls kept whatever rank the catalog guessed for it forever.
//
// This folds the live speed axis back into the column, under three rules:
//   - a model needs SPEED_RANK_MIN_SAMPLES decay-weighted speed-bearing
//     requests (successes + timeouts) before we claim to know anything; below
//     that it keeps its catalog value;
//   - a user-set speed_rank override always wins — we skip those models
//     entirely rather than fight applyModelOverrides for the column;
//   - the UPDATE is guarded on the value actually changing, so a steady system
//     writes nothing at all.
//
// A catalog sync re-stamps speed_rank from the catalog; the next pass simply
// re-derives the observed value, which is why this is a periodic write rather
// than a one-shot migration.
export const SPEED_RANK_MIN_SAMPLES = 20;
const SPEED_RANK_WRITE_INTERVAL_MS = 10 * 60 * 1000;
let speedRankWriteTime = 0;

/** Test hook: forget when the last writeback ran so the next refresh does one. */
export function resetSpeedRankWriteback(): void {
  speedRankWriteTime = 0;
}

/**
 * Write an observed speed rank for every model with enough recent samples and
 * no user-set speed_rank override. Returns how many rows actually changed.
 * Reads the stats cache as-is — callers refresh it first (refreshStatsCache
 * calls this from its own tail).
 */
export function writeObservedSpeedRanks(db: Db): number {
  if (!statsCache || statsCache.size === 0) return 0;

  const pinned = modelsWithOverriddenField(db, 'speedRank');
  const rows = db.prepare('SELECT id, platform, model_id, speed_rank, endpoint_scope FROM models')
    .all() as { id: number; platform: string; model_id: string; speed_rank: number; endpoint_scope: string }[];

  const update = db.prepare('UPDATE models SET speed_rank = ? WHERE id = ?');
  let written = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      // Overrides are keyed (platform, model_id) — they only exist for
      // catalog-managed rows, which are never endpoint-scoped — while the
      // measured stats are per endpoint, so each relay's copy gets its own
      // observed rank instead of one shared number (#651).
      if (pinned.has(`${row.platform}:${row.model_id}`)) continue;
      const stats = statsCache!.get(modelStatsKey(row.platform, row.model_id, row.endpoint_scope));
      if (!stats || stats.speedSamples < SPEED_RANK_MIN_SAMPLES) continue;
      const rank = observedSpeedRank(speedScore(stats.tokPerSec, stats.avgTtfbMs));
      if (rank === row.speed_rank) continue;
      update.run(rank, row.id);
      written++;
    }
  });
  tx();
  return written;
}

// Composite intelligence (tier-first, rank-as-tiebreaker) lives in scoring.ts
// so the seeding path can reason about the same tier ladder the router scores
// on — see intelligenceComposite there.

// Per-model axis values + the final score. `sampled` chooses Thompson sampling
// (for routing) vs. the expected value (for a stable dashboard display).
interface ScoredEntry {
  axes: { reliability: number; speed: number; intelligence: number };
  headroom: number;
  rateLimit: number;
  score: number;
}

// Enabled + healthy/unknown key count per platform, for pooled-budget scaling.
// This is the SAME filter both /api/fallback endpoints use (issue #456): the
// monthly budget is a PER-KEY free-tier allowance, so N usable keys pool N× the
// capacity. `monthlyUsedTokens` is already summed across all keys, so budget
// must scale to match or the headroom guardrail damps a multi-key model to the
// floor after just one account's worth of tokens.
function usableKeyCountsByPlatform(db: Db): Map<string, number> {
  const rows = db.prepare(
    "SELECT platform, COUNT(*) AS count FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform"
  ).all() as { platform: string; count: number }[];
  return new Map(rows.map(r => [r.platform, r.count]));
}

function scoreChainEntry(
  entry: ChainRow,
  weights: RoutingWeights,
  intelMin: number,
  intelMax: number,
  sampled: boolean,
  keyCounts: Map<string, number>,
): ScoredEntry {
  const stats = statsCache?.get(modelStatsKey(entry.platform, entry.model_id, entry.endpoint_scope));
  const successes = stats?.successes ?? 0;
  const failures = stats?.failures ?? 0;

  const community = activeCommunityPrior(entry.platform, entry.model_id, entry.endpoint_scope);
  let reliability: number;
  if (sampled) {
    const { alpha, beta } = reliabilityPosterior(successes, failures, community);
    reliability = sampleBeta(alpha, beta);
  } else {
    reliability = expectedReliability(successes, failures, community);
  }

  const speed = speedScore(stats?.tokPerSec ?? 0, stats?.avgTtfbMs ?? null);
  const intelligence = intelligenceScore(
    intelligenceComposite(entry.size_label, entry.intelligence_rank), intelMin, intelMax,
  );

  // Scale the per-key monthly budget by the usable key count for this platform,
  // matching the pooled `monthlyUsedTokens` aggregate (#456). Math.max(1, …) so a
  // model whose platform currently has no usable key isn't handed a 0 budget.
  const budget = parseBudget(entry.monthly_token_budget) * Math.max(1, keyCounts.get(entry.platform) ?? 1);
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
  // Tier first, always: it is the one ordering input that score must not be able
  // to override (see ChainRow.match_tier). Zero for every chain built anywhere
  // else, so this is a no-op outside slug-fallback resolution.
  const tier = (e: ChainRow) => e.match_tier ?? 0;
  const weights = weightsFor(strategy);
  if (!weights) {
    // Legacy priority mode: base priority + 429 penalty, ascending.
    return chain
      .map(e => ({ e, eff: e.priority + getPenalty(e.model_db_id) }))
      .sort((a, b) => tier(a.e) - tier(b.e) || a.eff - b.eff || a.e.priority - b.e.priority)
      .map(x => x.e);
  }

  const composites = chain.map(e => intelligenceComposite(e.size_label, e.intelligence_rank));
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;
  const keyCounts = usableKeyCountsByPlatform(getDb());

  return chain
    .map(e => ({ e, s: scoreChainEntry(e, weights, intelMin, intelMax, sampled, keyCounts).score }))
    // Higher score first WITHIN a tier; manual priority breaks ties so the chain
    // still matters.
    .sort((a, b) => tier(a.e) - tier(b.e) || b.s - a.s || a.e.priority - b.e.priority)
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

function getActiveChain(db: Db): ChainRow[] {
  const profileId = getActiveProfileId(db);
  if (profileId != null) {
    const chain = db.prepare(`
      SELECT pm.model_db_id, pm.priority, pm.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.size_label, m.monthly_token_budget,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
             m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
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
           m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as ChainRow[];
}

function getChainByProfileName(db: Db, name: string): ChainRow[] | null {
  const profile = db.prepare("SELECT id FROM profiles WHERE LOWER(name) = ?").get(name.toLowerCase()) as { id: number } | undefined;
  if (!profile) return null;

  return db.prepare(`
    SELECT pm.model_db_id, pm.priority, pm.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
    WHERE pm.profile_id = ?
    ORDER BY pm.priority ASC
  `).all(profile.id) as ChainRow[];
}

function getChainByGlobalSort(db: Db, globalAxis: string): ChainRow[] {
  // A global sort ignores the chain's ORDER, not its enable flags: a model the
  // operator switched off — in the catalog or just for auto routing — stays off
  // here too (#634). Models with no chain row yet (fresh catalog rows) default
  // to in, so the sort still spans the whole catalog.
  const profileId = getActiveProfileId(db);
  const chainEnabled = profileId != null
    ? 'COALESCE(pm.enabled, fc.enabled, 1) = 1'
    : 'COALESCE(fc.enabled, 1) = 1';
  const allEnabled = db.prepare(`
    SELECT m.id as model_db_id, 0 as priority, 1 as enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ${profileId != null ? 'LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id' : ''}
    WHERE m.enabled = 1 AND ${chainEnabled}
  `).all(...(profileId != null ? [profileId] : [])) as ChainRow[];

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

// Weights for the in-model key score (#580). Reliability dominates: the point
// of per-key stats is catching a credential that FAILS (expired, drained,
// region-blocked); speed differences between keys of the same platform+model
// are second-order (account-tier throttling) but still worth a nudge.
const KEY_SCORE_WEIGHTS = { reliability: 0.75, speed: 0.25 };

/**
 * Order a model's candidate keys by a Thompson-sampled per-key score, mirroring
 * orderChain's bandit: reliability is a fresh draw from each key's Beta
 * posterior (so exploration is automatic and proportional to uncertainty — a
 * key with no data samples from the uniform prior and still gets traffic),
 * speed is deterministic. Returns null when NO key has recorded data, telling
 * the caller to keep the legacy round-robin rotation (no signal → no ranking).
 */
function orderKeysByScore(entry: ChainRow, keys: KeyRow[]): KeyRow[] | null {
  if (keys.length < 2 || !keyStatsCache) return null;
  const prefix = `${modelStatsKey(entry.platform, entry.model_id, entry.endpoint_scope)}:`;
  if (!keys.some(k => keyStatsCache!.has(prefix + k.id))) return null;

  // The prior is per-model, not per-key: look it up once outside the loop.
  const community = activeCommunityPrior(entry.platform, entry.model_id, entry.endpoint_scope);
  return keys
    .map(k => {
      const stats = keyStatsCache!.get(prefix + k.id);
      const { alpha, beta } = reliabilityPosterior(stats?.successes ?? 0, stats?.failures ?? 0, community);
      const rel = sampleBeta(alpha, beta);
      const spd = speedScore(stats?.tokPerSec ?? 0, stats?.avgTtfbMs ?? null);
      return { k, s: KEY_SCORE_WEIGHTS.reliability * rel + KEY_SCORE_WEIGHTS.speed * spd };
    })
    .sort((a, b) => b.s - a.s || a.k.id - b.k.id)
    .map(x => x.k);
}

/**
 * Pick a usable key for ONE model and build its RouteResult, or return null if
 * the model has no key that can serve the request right now (all cooled down,
 * over quota, undecryptable, or no provider). Factored out of routeRequest so
 * the fusion panel can HARD-PIN a model: walk that model's keys without ever
 * falling through to a different model (issue #326 — soft preference collapses
 * panel diversity under rate limits). Keys are tried in per-key bandit-score
 * order when any of them has recorded data (#580), else round-robin.
 * Request-level filters (vision/tools/context window) stay in the caller; this
 * only does key selection + accounting pre-checks.
 */
function selectKeyForModel(entry: ChainRow, estimatedTokens: number, skipKeys?: Set<string>, diag?: string[]): RouteResult | null {
  const db = getDb();
  const label = `${entry.platform}/${entry.model_id}`;

  if (!hasProvider(entry.platform as Platform)) {
    diag?.push(`${label}: no provider registered`);
    return null;
  }
  const provider = getProvider(entry.platform as Platform)!;

  const allKeys = db.prepare(
    "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all(entry.platform) as KeyRow[];
  if (allKeys.length === 0) {
    diag?.push(`${label}: no enabled+healthy key for platform`);
    return null;
  }

  // Scoped keys (#657) are dropped before the walk: a key whose model scope
  // excludes this model is not a candidate at all — it neither takes a
  // round-robin slot nor burns an attempt on a guaranteed 403. Parsed once per
  // key row.
  const keys = allKeys.filter(k => scopeAllows(parseModelScope(k.model_scope_json), entry.model_id));
  if (keys.length === 0) {
    diag?.push(`${label}: no usable key — ${allKeys.length} key(s) scoped to other models`);
    return null;
  }

  // Tally the gate that rejected each key, so the exhaustion diagnostic can say
  // *why* a model with keys still couldn't serve (all on cooldown vs over quota).
  const skipTally: Record<string, number> = {};
  const note = (reason: string) => { skipTally[reason] = (skipTally[reason] ?? 0) + 1; };

  const limits = {
    rpm: entry.rpm_limit,
    rpd: entry.rpd_limit,
    tpm: entry.tpm_limit,
    tpd: entry.tpd_limit,
  };

  // Score-ordered walk over this model's keys (#580): when any key has recorded
  // reliability/speed data, try them best-sampled-score first so a chronically
  // failing key stops soaking up every Nth request. The stats cache is the same
  // 60s-TTL aggregate the model-level bandit uses (refresh is a no-op when
  // fresh, and cheap when not). With no data at all, keep the legacy rotation.
  refreshStatsCache(db);
  // Scoped so two relays offering the same model id don't share one rotation
  // cursor over the platform's key list (#651).
  const rrKey = modelStatsKey(entry.platform, entry.model_id, entry.endpoint_scope);
  let idx = roundRobinIndex.get(rrKey) ?? 0;
  const ranked = orderKeysByScore(entry, keys);

  // A custom model belongs to exactly one endpoint (#212), but an endpoint can
  // hold several credentials — so the pool is every key on the same base_url,
  // rotated like any other platform's keys (#619). Legacy rows (key_id NULL)
  // keep the old any-key match.
  const endpointKeyIds = entry.platform === 'custom' && entry.key_id != null
    ? customEndpointKeyIds(db, entry.key_id)
    : null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = ranked ? ranked[attempt] : keys[idx % keys.length];
    idx++;

    if (endpointKeyIds && !endpointKeyIds.has(key.id)) { note('custom-key-mismatch'); continue; }

    const skipId = `${entry.platform}:${entry.model_id}:${key.id}`;
    if (skipKeys?.has(skipId)) { note('already-failed-this-request'); continue; }

    if (isOnCooldown(entry.platform, entry.model_id, key.id)) { note('cooldown'); continue; }
    if (!canUseProvider(entry.platform, key.id)) { note('provider-daily-cap'); continue; }
    // Account-wide per-minute budget, checked before the per-model gates: a model
    // with a NULL rpm_limit would otherwise sail past them and spend a budget its
    // siblings share.
    if (!canUseProviderMinute(entry.platform, key.id)) { note('provider-minute-cap'); continue; }
    // Skip a key that already has its allowed requests in the air. Without this,
    // parallel streams all pick the same key and 429 each other on providers that
    // meter concurrency per credential.
    if (!canUseKeyConcurrency(entry.platform, key.id)) { note('key-concurrency'); continue; }
    if (!canMakeRequest(entry.platform, entry.model_id, key.id, limits)) { note('rpm/rpd-limit'); continue; }
    if (!canUseTokens(entry.platform, entry.model_id, key.id, estimatedTokens, limits)) { note('tpm/tpd-limit'); continue; }
    if (!canUseProviderTokens(entry.platform, key.id, entry.model_id, estimatedTokens)) { note('provider-daily-token-cap'); continue; }

    let decryptedKey: string;
    try {
      decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
    } catch {
      db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
        .run(key.id);
      note('decrypt-error');
      continue;
    }

    const resolvedProvider = entry.platform === 'custom'
      ? resolveProvider('custom', key.base_url)
      : provider;
    if (!resolvedProvider) { note('no-resolved-provider'); continue; }

    roundRobinIndex.set(rrKey, idx);
    // Taken only once the key has cleared every gate and is definitely being
    // returned, so a rejected candidate never consumes concurrency budget.
    const leaseId = acquireLease(entry.platform, entry.model_id, key.id, estimatedTokens);
    return {
      provider: resolvedProvider,
      modelId: entry.model_id,
      modelDbId: entry.model_db_id,
      apiKey: decryptedKey,
      keyId: key.id,
      platform: entry.platform,
      displayName: entry.display_name,
      endpointScope: entry.endpoint_scope ?? '',
      rpdLimit: limits.rpd,
      tpdLimit: limits.tpd,
      release: () => releaseLease(leaseId),
    };
  }

  // No usable key for this model. Advance the round-robin index anyway so we
  // don't get stuck re-trying the same exhausted key first next time.
  roundRobinIndex.set(rrKey, idx);
  const summary = Object.entries(skipTally).map(([r, n]) => `${r}:${n}`).join(', ') || 'no usable key';
  diag?.push(`${label}: ${keys.length} key(s) — ${summary}`);
  return null;
}

/**
 * Whether the model still has ANOTHER key that could serve it right now, given
 * the key that just failed (excludingKeyId) and any keys already ruled out this
 * request (skipKeys, in the "platform:modelId:keyId" form). Applies the same
 * gates selectKeyForModel uses — enabled + healthy status, not on cooldown,
 * under the provider daily cap, and under rpm/rpd/tpm/tpd — so the answer means
 * "a real, dispatchable alternative exists".
 *
 * Used by the retry loops to decide whether a single key's 429 should demote the
 * WHOLE model (the model-level 429 penalty). It should not: the per-key cooldown
 * already isolates the failing key, so demoting the model while a sibling key can
 * still serve it wrongly sinks a healthy model in the scorer (#454). We only
 * record the model-level hit when this returns false — i.e. the 429 exhausted the
 * model, not just one of its keys.
 */
export function hasOtherUsableKey(modelDbId: number, excludingKeyId: number, skipKeys?: Set<string>): boolean {
  const db = getDb();
  const m = db.prepare(`
    SELECT platform, model_id, rpm_limit, rpd_limit, tpm_limit, tpd_limit, key_id
      FROM models WHERE id = ?
  `).get(modelDbId) as {
    platform: string; model_id: string;
    rpm_limit: number | null; rpd_limit: number | null;
    tpm_limit: number | null; tpd_limit: number | null; key_id: number | null;
  } | undefined;
  if (!m) return false;

  const limits = { rpm: m.rpm_limit, rpd: m.rpd_limit, tpm: m.tpm_limit, tpd: m.tpd_limit };
  const keys = db.prepare(
    "SELECT id, model_scope_json FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all(m.platform) as { id: number; model_scope_json: string | null }[];

  // Keys of the model's own custom endpoint (#212, #619); a key belonging to a
  // DIFFERENT endpoint cannot serve it, so it doesn't count as an alternative.
  const endpointKeyIds = m.platform === 'custom' && m.key_id != null
    ? customEndpointKeyIds(db, m.key_id)
    : null;

  for (const k of keys) {
    if (k.id === excludingKeyId) continue;
    if (endpointKeyIds && !endpointKeyIds.has(k.id)) continue;
    // A sibling scoped away from this model can never serve it (#657) — counting
    // it would wrongly suppress the model-level penalty this gate exists for.
    if (!scopeAllows(parseModelScope(k.model_scope_json), m.model_id)) continue;
    if (skipKeys?.has(`${m.platform}:${m.model_id}:${k.id}`)) continue;
    if (isOnCooldown(m.platform, m.model_id, k.id)) continue;
    if (!canUseProvider(m.platform, k.id)) continue;
    if (!canUseProviderMinute(m.platform, k.id)) continue;
    if (!canMakeRequest(m.platform, m.model_id, k.id, limits)) continue;
    // A per-minute token spike on the failed key doesn't mean a fresh key lacks
    // headroom; a nominal 1-token probe only rules out a key already at its
    // TPM/TPD ceiling.
    if (!canUseTokens(m.platform, m.model_id, k.id, 1, limits)) continue;
    if (!canUseProviderTokens(m.platform, k.id, m.model_id, 1)) continue;
    return true;
  }
  return false;
}

/**
 * Fetch a single enabled model's chain row by its db id.
 */
function getModelChainRow(db: Db, modelDbId: number): ChainRow | undefined {
  return db.prepare(`
    SELECT m.id as model_db_id, 0 as priority, 1 as enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
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

/**
 * Resolve a logical model group's member db ids to an ordered ChainRow[] for
 * strict group-pin routing (the "unify" feature). Each catalog-enabled member
 * is hydrated as a ChainRow carrying its active-profile/manual priority, then
 * ordered by the active strategy via orderChain. Auto-chain enabled/disabled is
 * intentionally ignored here because an explicit model request should still be
 * able to use a direct model that the user removed from auto routing.
 *
 * Pass the result to routeRequest() as `prefetchedChain` and DO NOT pass a
 * `preferredModelDbId` that isn't already one of these rows — otherwise the
 * preferred-model injection in routeRequest would unshift an off-group model and
 * the pin would no longer be strict (it could answer with a different model).
 */
export function resolveModelGroupCandidates(
  memberDbIds: number[],
  /**
   * Members that were reached only through a group's auto-derived slug, not the
   * id the client wrote (#651). They stay in the chain — resolution must never
   * shrink — but as a strictly lower tier, so they can serve only once every
   * literal match is exhausted. Omit it and every row is an equal candidate,
   * which is what every other caller wants.
   */
  demotedDbIds?: ReadonlySet<number>,
): ChainRow[] {
  const db = getDb();
  const strategy = getRoutingStrategy();
  if (strategy !== 'priority') refreshStatsCache(db);

  const activeProfileId = getActiveProfileId(db);
  const selectMember = activeProfileId == null
    ? db.prepare(`
      SELECT m.id as model_db_id, COALESCE(fc.priority, 0) as priority,
             1 as enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.size_label, m.monthly_token_budget,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
             m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.id = ? AND m.enabled = 1
    `)
    : db.prepare(`
      SELECT m.id as model_db_id, COALESCE(pm.priority, fc.priority, 0) as priority,
             1 as enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.size_label, m.monthly_token_budget,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
             m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
      FROM models m
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.id = ? AND m.enabled = 1
    `);

  const rows: ChainRow[] = [];
  for (const id of memberDbIds) {
    const row = (activeProfileId == null ? selectMember.get(id) : selectMember.get(activeProfileId, id)) as ChainRow | undefined;
    if (!row) continue;
    row.match_tier = demotedDbIds?.has(id) ? 1 : 0;
    rows.push(row);
  }
  return orderChain(rows, strategy);
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
export function getOrderedFusionChain(estimatedTokens: number): FusionCandidate[] {
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
  //
  // The SIZE gates matter as much as the key gates: a model whose context window
  // cannot hold the prompt can NEVER fill its slot, yet diversifyChain keeps
  // handing it one on every request when it is its platform's only representative.
  // That leaves one panel slot dead on arrival and reports the failure as the
  // misleading "no available key for model". Passing a placeholder token count
  // here made both size gates no-ops.
  const usableKeys = db.prepare(
    "SELECT id, platform, model_scope_json FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all() as { id: number; platform: string; model_scope_json: string | null }[];
  // Scope parsed once per key row (#657); the servable filter below re-checks
  // membership per model.
  const keysByPlatform = new Map<string, { id: number; scope: Set<string> | null }[]>();
  for (const k of usableKeys) {
    const entry = { id: k.id, scope: parseModelScope(k.model_scope_json) };
    const arr = keysByPlatform.get(k.platform);
    if (arr) arr.push(entry); else keysByPlatform.set(k.platform, [entry]);
  }
  const servable = chain.filter(e => {
    // A null context_window means "unknown", not "zero": same convention the
    // auto-router uses, so an unspecified window is never itself a reason to skip.
    if (e.context_window != null && estimatedTokens > e.context_window) return false;
    const keyIds = keysByPlatform.get(e.platform);
    if (!keyIds) return false;
    // Same endpoint-pool rule the router applies (#619).
    const endpointKeyIds = e.platform === 'custom' && e.key_id != null
      ? customEndpointKeyIds(db, e.key_id)
      : null;
    const limits = { rpm: e.rpm_limit, rpd: e.rpd_limit, tpm: e.tpm_limit, tpd: e.tpd_limit };
    return keyIds.some(({ id: kid, scope }) =>
      scopeAllows(scope, e.model_id) &&
      (endpointKeyIds == null || endpointKeyIds.has(kid)) &&
      !isOnCooldown(e.platform, e.model_id, kid) &&
      canUseProvider(e.platform, kid) &&
      canUseProviderMinute(e.platform, kid) &&
      canMakeRequest(e.platform, e.model_id, kid, limits) &&
      canUseProviderTokens(e.platform, kid, e.model_id, estimatedTokens),
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
  if (row) {
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

  // Unify ON: a fusion picker value may be a canonical GROUP id rather than a
  // raw model_id. Resolve it to the group's best-ordered enabled member so
  // saved fusion configs that use canonical ids keep working. Exact model_id
  // match above always wins first, so OFF mode and legacy configs are untouched.
  if (isUnifyEnabled()) {
    const resolved = resolveRequestedIdForDispatch(modelId, getModelGroups());
    if (resolved && resolved.memberDbIds.length > 0) {
      const top = resolveModelGroupCandidates(resolved.memberDbIds, resolved.demotedDbIds)[0];
      if (top) {
        return {
          modelDbId: top.model_db_id,
          platform: top.platform,
          modelId: top.model_id,
          displayName: top.display_name,
          sizeLabel: top.size_label,
          supportsVision: top.supports_vision,
          supportsTools: top.supports_tools,
        };
      }
    }
  }
  return null;
}

export function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number, requireVision = false, requireTools = false, skipModels?: Set<number>, prefetchedChain?: ChainRow[], requireStructured = false, skipSort = false): RouteResult {
  const db = getDb();

  const strategy = getRoutingStrategy();
  if (strategy !== 'priority') refreshStatsCache(db);

  const chain = (prefetchedChain ?? getActiveChain(db)).filter(e => e.enabled);

  const sortedChain = skipSort ? chain : orderChain(chain, strategy);

  // Exploration toggle (#685/#707 follow-up): when enabled, give a model with
  // no reliability/speed samples a guaranteed chance to be tried, so it stops
  // losing every bandit draw to prior-heavy rivals. With EXPLORE_CHANCE
  // probability, pick one unmeasured model uniformly and try it first; if it
  // fails, the loop falls through to the scored order as usual. Only for
  // bandit strategies — Manual is the operator's explicit order.
  if (strategy !== 'priority' && getExploreEnabled() && Math.random() < EXPLORE_CHANCE) {
    const unmeasured = sortedChain.filter(e => {
      const stats = statsCache?.get(modelStatsKey(e.platform, e.model_id, e.endpoint_scope));
      return (stats?.successes ?? 0) + (stats?.failures ?? 0) < EXPLORE_MIN_SAMPLES;
    });
    if (unmeasured.length > 0) {
      const probe = unmeasured[Math.floor(Math.random() * unmeasured.length)];
      const idx = sortedChain.findIndex(e => e.model_db_id === probe.model_db_id);
      if (idx > 0) {
        const [probeRow] = sortedChain.splice(idx, 1);
        sortedChain.unshift(probeRow);
      }
    }
  }

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
               m.supports_tools, m.context_window, m.key_id, m.endpoint_scope
        FROM models m
        WHERE m.id = ? AND m.enabled = 1
      `).get(preferredModelDbId) as ChainRow | undefined;
      
      if (pinnedRow) {
        sortedChain.unshift(pinnedRow);
      }
    }
  }

  // Per-model disposition, attached to the exhaustion error when the loop falls
  // through with no route — the only record of WHY the pool was empty on the
  // synchronous "all exhausted" path (nothing downstream logs it). See issue _1.
  const diag: string[] = [];

  for (const entry of sortedChain) {
    const label = `${entry.platform}/${entry.model_id}`;
    // Models the caller has ruled out for this request — e.g. a 404
    // "model removed upstream" already seen this request: trying the same
    // model again on a different key would just burn another attempt on the
    // same dead route (PR #111, credits @barbotkonv).
    if (skipModels?.has(entry.model_db_id)) { diag.push(`${label}: ruled out earlier this request`); continue; }

    // Vision requests skip text-only models — including a sticky/preferred one,
    // which is correct: don't pin an image turn to a model that can't see it.
    if (requireVision && !entry.supports_vision) { diag.push(`${label}: no vision support`); continue; }

    // Tool-bearing requests skip models that can't emit structured tool_calls.
    // A model that "answers" a tool request with the call serialized as text
    // looks successful at the transport level while the client's harness sees
    // nothing — worse than a failover. Applies to sticky models too, same
    // reasoning as vision above.
    if (requireTools && !entry.supports_tools) { diag.push(`${label}: no tool-calling support`); continue; }

    // Structured-output routing (#514 follow-up): when the request carries a
    // response_format, skip platforms whose param policy can't even receive it
    // (the param would be dropped before send, so the model would answer in
    // prose and burn a failover hop). Platform-level fast path — model-level
    // capability isn't in the catalog; models that accept the param but ignore
    // it are caught by the non-stream JSON enforcement downstream.
    if (requireStructured && platformDropsResponseFormat(entry.platform)) { diag.push(`${label}: platform drops response_format`); continue; }

    // Context-aware routing: skip a model whose context window can't hold the
    // request, so a large prompt never selects a small-context model and burns
    // a failover hop on a 413 "request too large" (#167). Only enforced when we
    // know the model's window; estimatedTokens is the INPUT estimate plus a
    // CAPPED output reserve (routingReserveTokens, #470), so a huge client-set
    // max_tokens no longer excludes the model — the input must fit, not
    // input+full max_tokens. A 413 that slips through is still retryable
    // downstream, and the failed model is put on cooldown — so this is a
    // fast-path, not the only guard. If every model is too small, the loop falls
    // through and the caller gets the normal "all models exhausted" error rather
    // than a wasted sweep.
    if (entry.context_window != null && estimatedTokens > entry.context_window) { diag.push(`${label}: context ${entry.context_window} < estimated ${estimatedTokens}`); continue; }

    // Same guard for a model with a small per-minute token budget: a request
    // whose input alone exceeds tpm_limit can never fit one minute of quota and
    // returns a guaranteed 413 (e.g. Groq gpt-oss-120b: 131k context but 8k TPM).
    // estimatedTokens carries the same capped output reserve, mirroring the
    // check above (#470).
    if (entry.tpm_limit != null && estimatedTokens > entry.tpm_limit) { diag.push(`${label}: tpm_limit ${entry.tpm_limit} < estimated ${estimatedTokens}`); continue; }

    // Key selection + accounting pre-checks for this one model. Returns the
    // first usable key's RouteResult, or null when the model has no key that
    // can serve right now — in which case we fall through to the next model in
    // the sorted chain for THIS request (no explicit penalty needed).
    const route = selectKeyForModel(entry, estimatedTokens, skipKeys, diag);
    if (route) return route;
  }

  throw new RouteError(summarizeExhaustion(diag, getSoonestCooldownExpiry()), 429, diag);
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

export function getRoutingScores(): { strategy: RoutingStrategy; weights: RoutingWeights | null; customWeights: RoutingWeights; exploreEnabled: boolean; scores: RoutingScore[] } {
  const db = getDb();
  const strategy = getRoutingStrategy();
  refreshStatsCache(db);

  const chain = getActiveChain(db);

  // For display we score under 'balanced' weights when in priority mode, so the
  // table still shows a meaningful ranking even with the bandit turned off.
  const weights = weightsFor(strategy) ?? BANDIT_PRESETS.balanced;
  const composites = chain.map(e => intelligenceComposite(e.size_label, e.intelligence_rank));
  const intelMin = composites.length ? Math.min(...composites) : 0;
  const intelMax = composites.length ? Math.max(...composites) : 0;
  const keyCounts = usableKeyCountsByPlatform(db);

  const scores: RoutingScore[] = chain.map(entry => {
    const scored = scoreChainEntry(entry, weights, intelMin, intelMax, false, keyCounts);
    const stats = statsCache?.get(modelStatsKey(entry.platform, entry.model_id, entry.endpoint_scope));
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
  // exploreEnabled must ride along here too: the dashboard checkbox renders
  // from GET /routing, so omitting it would make the toggle look permanently
  // off (and impossible to turn off) after a refetch.
  return { strategy, weights: weightsFor(strategy), customWeights: getCustomWeights(), exploreEnabled: getExploreEnabled(), scores };
}

/**
 * Filter a sticky-session pin down to something still routable (#634).
 *
 * A sticky entry holds a model db id for up to 30 minutes, so it goes stale the
 * moment the operator disables that model — in the catalog, or just for auto
 * routing. It must NOT be handed to routeRequest as-is: an off-chain preferred
 * id is treated as an explicit pin and injected ahead of the chain, which is
 * right for a client that named the model and wrong for a pin the client never
 * asked for. Dropping it here falls the request through to normal auto routing.
 *
 * Pass the same chain the request will route over (the prefetched auto chain);
 * omit it to check the active chain, which is what routeRequest would use.
 */
export function resolveStickyPreference(stickyModelDbId: number | undefined, chain?: ChainRow[]): number | undefined {
  if (stickyModelDbId == null) return undefined;
  const rows = chain ?? getActiveChain(getDb());
  return rows.some(entry => entry.model_db_id === stickyModelDbId && entry.enabled)
    ? stickyModelDbId
    : undefined;
}

// Whether at least one vision-capable model is enabled in the fallback chain.
// Used to give image requests a clear "enable a vision model" error instead of
// the generic exhaustion message when none is configured (#118, #125).
export function hasEnabledVisionModel(): boolean {
  const db = getDb();
  return getActiveChain(db).some(entry => entry.enabled === 1 && entry.supports_vision === 1);
}

// Whether at least one tool-capable model is enabled in the fallback chain.
// Same role as hasEnabledVisionModel: a clear up-front error for tool-bearing
// requests beats routing them to a model that mangles the tool call.
export function hasEnabledToolsModel(): boolean {
  const db = getDb();
  return getActiveChain(db).some(entry => entry.enabled === 1 && entry.supports_tools === 1);
}
