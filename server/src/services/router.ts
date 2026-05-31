import { getDb } from '../db/index.js';
import { getProvider, resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  supports_vision: number;
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

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
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
 * @param requireVision - only consider models that accept image input (#118)
 */
export function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number, requireVision = false): RouteResult {
  const db = getDb();

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

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

    // Get model details
    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    // Vision requests skip text-only models — including a sticky/preferred one,
    // which is correct: don't pin an image turn to a model that can't see it.
    if (requireVision && !model.supports_vision) continue;

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

      // For the 'custom' platform the real provider is built from this key's
      // base_url (the registered instance is just a placeholder). A custom key
      // with no base_url can't be routed — skip it.
      const resolvedProvider = model.platform === 'custom'
        ? resolveProvider('custom', key.base_url)
        : provider;
      if (!resolvedProvider) continue;

      // We found a working key for this model!
      roundRobinIndex.set(rrKey, idx);
      return {
        provider: resolvedProvider,
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
