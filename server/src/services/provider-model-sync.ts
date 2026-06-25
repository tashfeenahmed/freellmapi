import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { resolveProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import type { Platform } from '@freellmapi/shared/types.js';

/** Built-in providers whose chat catalog is fetched from the provider's own
 *  OpenAI-compatible GET /v1/models instead of the signed freellmapi catalog.
 *  Rows are bound to the discovering api_keys.id so catalog-sync won't delete
 *  them (it only prunes key_id IS NULL catalog-managed rows). */
export const DYNAMIC_MODEL_PLATFORMS = new Set<Platform>(['alibaba']);

export interface ProviderModelSyncResult {
  platform: Platform;
  fetched: number;
  chatCandidates: number;
  inserted: number;
  updated: number;
  removed: number;
  probed: number;
  enabled: number;
  disabled: number;
  models: Array<{ modelId: string; displayName: string; enabled: boolean; probed: boolean; error?: string }>;
}

/** The router walks profile_models when a profile is active — discovered models
 *  must live there too, not only in fallback_config. */
function ensureModelInDefaultProfile(db: Database.Database, modelDbId: number, priority?: number): void {
  const defaultProfile = db.prepare("SELECT id FROM profiles WHERE type = 'default' LIMIT 1").get() as { id: number } | undefined;
  if (!defaultProfile) return;
  const exists = db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
    .get(defaultProfile.id, modelDbId);
  if (exists) return;
  const pri = priority ?? (
    db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM profile_models WHERE profile_id = ?')
      .get(defaultProfile.id) as { m: number }
  ).m + 1;
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(defaultProfile.id, modelDbId, pri);
}

/** Backfill models that were synced before profile wiring landed. */
export function backfillDiscoveredModelsToDefaultProfile(db: Database.Database, platform: Platform): number {
  const defaultProfile = db.prepare("SELECT id FROM profiles WHERE type = 'default' LIMIT 1").get() as { id: number } | undefined;
  if (!defaultProfile) return 0;
  const missing = db.prepare(`
    SELECT m.id, fc.priority
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN profile_models pm ON pm.model_db_id = m.id AND pm.profile_id = ?
    WHERE m.platform = ? AND m.key_id IS NOT NULL AND pm.id IS NULL
  `).all(defaultProfile.id, platform) as { id: number; priority: number }[];
  for (const row of missing) ensureModelInDefaultProfile(db, row.id, row.priority);
  return missing.length;
}

/** Drop obvious non-chat SKUs (image/TTS/embedding/realtime/etc.) from /v1/models. */
export function isLikelyChatModel(modelId: string, platform: Platform): boolean {
  const lower = modelId.toLowerCase();
  if (platform === 'alibaba') {
    const exclude = [
      'embedding', 'image', 'tts', 'asr', 'wan', 'ocr', 'livetranslate', 'realtime',
      's2s', 'captioner', 'tingwu', 'ccai-pro', 'z-image', 'image-edit', '-edit-',
      'vc-realtime', 'vd-realtime', 'qwen-mt', 'qwen-vl-ocr', 'qwen-omni-turbo',
    ];
    if (exclude.some(p => lower.includes(p))) return false;
  }
  return true;
}

function humanizeModelId(modelId: string): string {
  return modelId
    .split(/[-_/]+/)
    .filter(Boolean)
    .map(part => (/^\d/.test(part) || part.length <= 4 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/** Rough intelligence ordering for dynamically discovered rows. */
export function inferIntelligenceRank(modelId: string, platform: Platform): number {
  const id = modelId.toLowerCase();
  if (platform === 'alibaba') {
    if (id.includes('max') || id.includes('480b') || id.includes('235b') || id.includes('397b')) return 2;
    if (id.includes('plus') || id.includes('pro') || id.includes('coder') || id.includes('glm')) return 4;
    if (id.includes('flash') || id.includes('turbo') || id.includes('next')) return 6;
    if (id.includes('7b') || id.includes('8b') || id.includes('14b')) return 12;
  }
  return 20;
}

export async function fetchProviderModelIds(platform: Platform, apiKey: string, baseUrl?: string | null): Promise<string[]> {
  const provider = resolveProvider(platform, baseUrl);
  if (!provider) throw new Error(`Unknown platform: ${platform}`);
  if (!(provider instanceof OpenAICompatProvider)) {
    throw new Error(`Platform '${platform}' does not expose OpenAI-compatible /v1/models`);
  }
  return provider.listModels(apiKey);
}

async function probeChatModel(
  platform: Platform,
  apiKey: string,
  modelId: string,
  baseUrl?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const provider = resolveProvider(platform, baseUrl);
  if (!provider) return { ok: false, error: 'no provider' };
  try {
    await provider.chatCompletion(
      apiKey,
      [{ role: 'user', content: 'Reply with one word: hi' }],
      modelId,
      { max_tokens: 8, timeoutMs: 45000 },
    );
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200) };
  }
}

export interface SyncProviderModelsOptions {
  /** When true (default), chat-probe each candidate and only enable successes. */
  probe?: boolean;
  /** Max concurrent probes. */
  probeConcurrency?: number;
  baseUrl?: string | null;
}

export async function syncProviderModels(
  platform: Platform,
  apiKey: string,
  keyId: number,
  opts: SyncProviderModelsOptions = {},
): Promise<ProviderModelSyncResult> {
  if (!DYNAMIC_MODEL_PLATFORMS.has(platform)) {
    throw new Error(`Platform '${platform}' does not support dynamic model sync`);
  }

  const probe = opts.probe ?? true;
  const concurrency = opts.probeConcurrency ?? 4;
  const db = getDb();

  const fetchedIds = await fetchProviderModelIds(platform, apiKey, opts.baseUrl);
  const chatIds = fetchedIds.filter(id => isLikelyChatModel(id, platform));

  const probeResults = new Map<string, { ok: boolean; error?: string }>();
  if (probe) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, chatIds.length) }, async () => {
      while (idx < chatIds.length) {
        const modelId = chatIds[idx++];
        probeResults.set(modelId, await probeChatModel(platform, apiKey, modelId, opts.baseUrl));
      }
    });
    await Promise.all(workers);
  }

  const result: ProviderModelSyncResult = {
    platform,
    fetched: fetchedIds.length,
    chatCandidates: chatIds.length,
    inserted: 0,
    updated: 0,
    removed: 0,
    probed: probeResults.size,
    enabled: 0,
    disabled: 0,
    models: [],
  };

  const upsert = db.transaction(() => {
    const select = db.prepare('SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?');
    const insert = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, key_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', NULL, ?, 0, 1, ?)
    `);
    const update = db.prepare(`
      UPDATE models SET
        display_name = ?, intelligence_rank = ?, speed_rank = ?, size_label = ?,
        enabled = ?, key_id = ?
      WHERE id = ?
    `);

    const seen = new Set<string>();
    for (const modelId of chatIds) {
      seen.add(modelId);
      const displayName = humanizeModelId(modelId);
      const intelligenceRank = inferIntelligenceRank(modelId, platform);
      const probed = probeResults.get(modelId);
      const enabled = probe ? (probed?.ok ? 1 : 0) : 1;
      if (enabled) result.enabled++;
      else result.disabled++;

      const row = select.get(platform, modelId) as { id: number; enabled: number } | undefined;
      if (row) {
        // Respect a user's manual disable only when we're not re-probing.
        const nextEnabled = probe ? enabled : row.enabled;
        update.run(displayName, intelligenceRank, intelligenceRank, 'Discovered', nextEnabled, keyId, row.id);
        const fb = db.prepare('SELECT priority FROM fallback_config WHERE model_db_id = ?').get(row.id) as { priority: number } | undefined;
        if (nextEnabled) ensureModelInDefaultProfile(db, row.id, fb?.priority);
        result.updated++;
        result.models.push({
          modelId,
          displayName,
          enabled: nextEnabled === 1,
          probed: !!probed,
          error: probed && !probed.ok ? probed.error : undefined,
        });
      } else {
        insert.run(platform, modelId, displayName, intelligenceRank, intelligenceRank, 'Discovered', enabled, keyId);
        const inserted = select.get(platform, modelId) as { id: number };
        const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(inserted.id);
        let fbPriority: number | undefined;
        if (!inChain) {
          const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
          fbPriority = max.m + 1;
          db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(inserted.id, fbPriority);
        } else {
          fbPriority = (db.prepare('SELECT priority FROM fallback_config WHERE model_db_id = ?').get(inserted.id) as { priority: number }).priority;
        }
        if (enabled) ensureModelInDefaultProfile(db, inserted.id, fbPriority);
        result.inserted++;
        result.models.push({
          modelId,
          displayName,
          enabled: enabled === 1,
          probed: !!probed,
          error: probed && !probed.ok ? probed.error : undefined,
        });
      }
    }

    // Drop models previously discovered by THIS key that vanished upstream.
    const stale = db.prepare(`
      SELECT id, model_id FROM models
       WHERE platform = ? AND key_id = ?
    `).all(platform, keyId) as { id: number; model_id: string }[];
    const deleteFb = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const deleteProfile = db.prepare('DELETE FROM profile_models WHERE model_db_id = ?');
    const deleteModel = db.prepare('DELETE FROM models WHERE id = ?');
    for (const row of stale) {
      if (!seen.has(row.model_id)) {
        deleteFb.run(row.id);
        deleteProfile.run(row.id);
        deleteModel.run(row.id);
        result.removed++;
      }
    }
  });

  upsert();
  backfillDiscoveredModelsToDefaultProfile(db, platform);
  return result;
}

/** Remove all models bound to a provider key (used when deleting dynamic-sync keys). */
export function deleteModelsForKey(db: Database.Database, platform: Platform, keyId: number): number {
  if (!DYNAMIC_MODEL_PLATFORMS.has(platform)) return 0;
  const rows = db.prepare('SELECT id FROM models WHERE platform = ? AND key_id = ?').all(platform, keyId) as { id: number }[];
  const deleteFb = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
  const deleteProfile = db.prepare('DELETE FROM profile_models WHERE model_db_id = ?');
  const deleteModel = db.prepare('DELETE FROM models WHERE id = ?');
  for (const row of rows) {
    deleteFb.run(row.id);
    deleteProfile.run(row.id);
    deleteModel.run(row.id);
  }
  return rows.length;
}

/** Kick off a background /v1/models fetch + chat probe for dynamic-catalog providers. */
export function scheduleProviderModelSync(keyId: number, platform: Platform): void {
  if (!DYNAMIC_MODEL_PLATFORMS.has(platform)) return;
  void (async () => {
    try {
      const db = getDb();
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as {
        encrypted_key: string; iv: string; auth_tag: string; enabled: number; base_url?: string | null;
      } | undefined;
      if (!row || row.enabled !== 1) return;
      const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      const result = await syncProviderModels(platform, apiKey, keyId, { baseUrl: row.base_url });
      console.log(
        `[provider-model-sync] ${platform} key ${keyId}: ${result.enabled} enabled, ${result.disabled} disabled ` +
        `(${result.fetched} fetched, ${result.chatCandidates} chat candidates)`,
      );
    } catch (err) {
      console.warn(
        `[provider-model-sync] ${platform} key ${keyId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** On boot, sync dynamic-catalog providers that have a key but no models yet,
 *  and backfill any discovered models missing from the active Default profile. */
export function scheduleMissingDynamicProviderSync(): void {
  const db = getDb();
  for (const platform of DYNAMIC_MODEL_PLATFORMS) {
    backfillDiscoveredModelsToDefaultProfile(db, platform);
    const modelCount = (db.prepare('SELECT COUNT(1) AS c FROM models WHERE platform = ?').get(platform) as { c: number }).c;
    if (modelCount > 0) continue;
    const keys = db.prepare('SELECT id FROM api_keys WHERE platform = ? AND enabled = 1').all(platform) as { id: number }[];
    for (const key of keys) scheduleProviderModelSync(key.id, platform);
  }
}
