import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';
import type Database from 'better-sqlite3';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

export interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
}

export function getActiveChain(db: Database.Database): FallbackRow[] {
  // Check if there is an active profile set in settings
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  const activeProfileId = row ? (parseInt(row.value) || null) : null;

  if (activeProfileId) {
    // Verify profile still exists
    const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(activeProfileId) as any;
    if (profile) {
      return db.prepare(`
        SELECT pm.model_db_id, pm.priority, pm.enabled
        FROM profile_models pm
        WHERE pm.profile_id = ?
        ORDER BY pm.priority ASC
      `).all(activeProfileId) as FallbackRow[];
    }
  }

  // Default: use global fallback_config
  return db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];
}

/**
 * Look up a profile by name (case-insensitive) and return its model chain.
 * Returns null if the profile doesn't exist.
 */
export function getChainByProfileName(db: Database.Database, profileName: string): FallbackRow[] | null {
  const profile = db.prepare('SELECT id FROM profiles WHERE LOWER(name) = LOWER(?)').get(profileName) as { id: number } | undefined;
  if (!profile) return null;

  return db.prepare(`
    SELECT pm.model_db_id, pm.priority, pm.enabled
    FROM profile_models pm
    WHERE pm.profile_id = ?
    ORDER BY pm.priority ASC
  `).all(profile.id) as FallbackRow[];
}

/**
 * Build a virtual fallback chain by sorting ALL enabled models by a global axis.
 * Used for auto:smart, auto:fast, auto:cheap — no profile needed.
 */
function getBudgetScoreForRouting(m: { monthly_token_budget: string | null; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;
  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;
  const cleanStr = str.split('(')[0];
  const matches = cleanStr.match(/[\d.]+/g);
  let maxNum = 0;
  if (matches) {
    maxNum = Math.max(...matches.map(s => parseFloat(s)));
  }
  let mult = 1;
  const upper = cleanStr.toUpperCase();
  if (upper.includes('B')) mult = 1_000_000_000;
  else if (upper.includes('M')) mult = 1_000_000;
  else if (upper.includes('K')) mult = 1_000;
  return maxNum * mult;
}

export function getChainByGlobalSort(db: Database.Database, axis: 'smart' | 'fast' | 'cheap'): FallbackRow[] {
  if (axis === 'smart') {
    const models = db.prepare('SELECT id FROM models WHERE enabled = 1 ORDER BY intelligence_rank ASC').all() as { id: number }[];
    return models.map((m, i) => ({ model_db_id: m.id, priority: i + 1, enabled: 1 }));
  }
  if (axis === 'fast') {
    const models = db.prepare('SELECT id FROM models WHERE enabled = 1 ORDER BY speed_rank ASC').all() as { id: number }[];
    return models.map((m, i) => ({ model_db_id: m.id, priority: i + 1, enabled: 1 }));
  }
  // cheap / budget
  const models = db.prepare('SELECT id, monthly_token_budget, tpd_limit FROM models WHERE enabled = 1').all() as { id: number; monthly_token_budget: string | null; tpd_limit: number | null }[];
  models.sort((a, b) => getBudgetScoreForRouting(b) - getBudgetScoreForRouting(a));
  return models.map((m, i) => ({ model_db_id: m.id, priority: i + 1, enabled: 1 }));
}

// Global sort axis aliases for convenience
const GLOBAL_SORT_ALIASES: Record<string, 'smart' | 'fast' | 'cheap'> = {
  smart: 'smart',
  intelligence: 'smart',
  fast: 'fast',
  speed: 'fast',
  cheap: 'cheap',
  budget: 'cheap',
};

export interface ResolvedChain {
  chain: FallbackRow[];
  /** The original strategy string for sticky session hashing */
  strategyKey: string;
}

/**
 * Resolve an auto:* model string to a fallback chain.
 * Called ONCE before the retry loop to avoid repeated DB queries.
 *
 * Returns:
 * - { chain, strategyKey } on success
 * - Throws an error with status 400 if the profile is not found or empty
 */
export function resolveRoutingChain(modelString: string | undefined): ResolvedChain {
  const db = getDb();

  // No model or bare "auto" → use the globally active profile
  if (!modelString || modelString.toLowerCase() === 'auto') {
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  // Must start with "auto:"
  const lower = modelString.toLowerCase();
  if (!lower.startsWith('auto:')) {
    // Not an auto:* string — it's a specific model ID, let proxy handle it
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  const suffix = lower.slice('auto:'.length).trim();
  if (!suffix) {
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  // Check if it's a global sort axis (smart, fast, cheap and aliases)
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

  // Otherwise it's a profile name
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

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
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
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
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

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 */
export function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number, skipModels?: Set<number>, prefetchedChain?: FallbackRow[]): RouteResult {
  const db = getDb();

  // Use pre-fetched chain if provided (avoids repeated DB queries in retry loop),
  // otherwise fall back to the active profile / global fallback_config.
  const fallbackChain = prefetchedChain ?? getActiveChain(db);

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;
    if (skipModels?.has(entry.model_db_id)) continue;

    // Get model details
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    // Get enabled keys that have not already failed validation or decryption.
    const keys = db.prepare(
      "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
    ).all(model.platform) as KeyRow[];

    if (keys.length === 0) continue;

    // Get limits once for this model
    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    // Try all keys for this model before giving up on it
    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      // Check cooldown (from previous 429s)
      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;

      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

      let decryptedKey: string;
      try {
        decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      } catch {
        db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
          .run(key.id);
        continue;
      }

      // We found a working key for this model!
      roundRobinIndex.set(rrKey, idx);
      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
      };
    }

    // If we reach here, this specific model has NO available keys.
    // Update round-robin index even if we failed so we don't get stuck.
    roundRobinIndex.set(rrKey, idx);
    
    // We don't explicitly penalize the model here because the fact that we 
    // couldn't find a key means we will naturally move to the next model 
    // in the `sortedChain` for THIS specific request.
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}
