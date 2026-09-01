import fs from 'fs';
import { z } from 'zod';
import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import { resolveProvider } from '../providers/index.js';
import { setCustomWeights, setRoutingStrategy, setKeySelectionStrategy } from './router.js';
import { ensureModelInProfiles } from './profile-models.js';
import { customModelSeed } from './custom-model-seed.js';
import { endpointRefMatches, endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';
import {
  clearCatalogModelTombstone,
  isCatalogManagedModel,
  upsertModelOverrides,
  type ModelOverridePatch,
} from './model-state.js';

const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    displayName: z.string().optional(),
    intelligenceRank: z.number().int().min(1).max(1000).optional(),
    speedRank: z.number().int().min(1).max(1000).optional(),
    sizeLabel: z.string().min(1).max(40).optional(),
    monthlyTokenBudget: z.string().max(80).optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    supportsVision: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    fallbackEnabled: z.boolean().optional(),
  }),
]);

const keySchema = z.object({
  platform: z.string().min(1),
  key: z.string().optional(),
  label: z.string().optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});

const customProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  models: z.array(modelEntrySchema).default([]),
});

const modelSchema = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1),
  // Which custom endpoint this entry means, when several serve the same model
  // id (#651). Accepts the endpoint URL or its short handle. Ignored for
  // catalog platforms, where (platform, modelId) is already unique.
  endpoint: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  intelligenceRank: z.number().int().min(1).max(1000).optional(),
  speedRank: z.number().int().min(1).max(1000).optional(),
  sizeLabel: z.string().min(1).max(40).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  monthlyTokenBudget: z.string().max(80).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  fallbackEnabled: z.boolean().optional(),
});

const fallbackEntrySchema = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1),
  endpoint: z.string().min(1).optional(),
  priority: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

const declarativeConfigSchema = z.object({
  keys: z.array(keySchema).optional(),
  customProviders: z.array(customProviderSchema).optional(),
  models: z.array(modelSchema).optional(),
  fallback: z.array(fallbackEntrySchema).optional(),
  routing: z.object({
    strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
    weights: z.object({
      reliability: z.number().nonnegative(),
      speed: z.number().nonnegative(),
      intelligence: z.number().nonnegative(),
    }).optional(),
    // Which key of a platform to reach for (#919); orthogonal to `strategy`,
    // which ranks models. Omitted leaves the persisted value alone.
    keySelectionStrategy: z.enum(['auto', 'least-remaining']).optional(),
  }).optional(),
}).strict();

export type DeclarativeConfig = z.infer<typeof declarativeConfigSchema>;

export interface DeclarativeConfigResult {
  applied: boolean;
  source?: string;
  keys: number;
  customModels: number;
  models: number;
  fallback: number;
  routing: boolean;
  /** Per-entry problems that were degraded to a skip instead of failing the apply (#600). */
  warnings: string[];
}

interface NormalizedCustomModel {
  modelId: string;
  displayName: string;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  monthlyTokenBudget?: string;
  contextWindow?: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  fallbackEnabled?: boolean;
}

function readConfigFromEnv(): { source: string; value: unknown } | null {
  const inline = process.env.FREEAPI_CONFIG_JSON?.trim();
  if (inline) return { source: 'FREEAPI_CONFIG_JSON', value: JSON.parse(inline) };

  const configPath = process.env.FREEAPI_CONFIG_PATH?.trim();
  if (configPath) return { source: configPath, value: JSON.parse(fs.readFileSync(configPath, 'utf8')) };

  return null;
}

function encryptedKey(raw: string) {
  const { encrypted, iv, authTag } = encrypt(raw);
  return { encrypted, iv, authTag };
}

// Boot-time skip guard for `keys` entries (#600). When a platform stops being
// keyless (pollinations lost `keyless: true` in #573), a legacy declarative
// config still carries an entry with no `key` — applyDeclarativeConfigFromEnv()
// runs in main(), so throwing here used to brick the whole install at startup.
// Such entries degrade to a warning + skip; the rest of the config still
// applies. Platform-specific remediation hints live here.
const MISSING_KEY_HINTS: Record<string, string> = {
  pollinations: 'pollinations now requires an API key — get one at enter.pollinations.ai',
};

function missingKeyWarning(input: z.infer<typeof keySchema>): string | null {
  const platform = input.platform.trim();
  if (platform === 'custom' || input.key?.trim()) return null;
  const provider = resolveProvider(platform as never);
  if (!provider || provider.keyless) return null;
  const hint = MISSING_KEY_HINTS[platform] ?? `${platform} requires an API key — add "key" to this entry or remove it`;
  return `${hint}; entry skipped`;
}

function upsertApiKey(db: Db, input: z.infer<typeof keySchema>): number {
  const platform = input.platform.trim();
  const enabled = input.enabled === false ? 0 : 1;
  const isCustom = platform === 'custom';
  const baseUrl = input.baseUrl?.trim().replace(/\/+$/, '') ?? null;
  const provider = !isCustom ? resolveProvider(platform as never) : null;
  if (!isCustom && !provider) throw new Error(`unknown provider platform: ${platform}`);
  const keyToStore = input.key?.trim() || (provider?.keyless ? 'no-key' : '');
  if (!keyToStore) throw new Error(`key is required for ${platform}`);
  const label = input.label?.trim() || (isCustom ? 'Custom' : 'env');
  const key = encryptedKey(keyToStore);

  if (isCustom) {
    if (!baseUrl) throw new Error('baseUrl is required for custom keys');
    const existing = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ?").get(baseUrl) as { id: number } | undefined;
    if (existing) {
      db.prepare(`
        UPDATE api_keys
           SET label = ?, encrypted_key = ?, iv = ?, auth_tag = ?, enabled = ?, status = 'unknown'
         WHERE id = ?
      `).run(label, key.encrypted, key.iv, key.authTag, enabled, existing.id);
      return existing.id;
    }
    const inserted = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('custom', ?, ?, ?, ?, 'unknown', ?, ?)
    `).run(label, key.encrypted, key.iv, key.authTag, enabled, baseUrl);
    return Number(inserted.lastInsertRowid);
  }

  const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? AND label = ? AND base_url IS NULL LIMIT 1')
    .get(platform, label) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE api_keys
         SET encrypted_key = ?, iv = ?, auth_tag = ?, enabled = ?, status = 'unknown'
       WHERE id = ?
    `).run(key.encrypted, key.iv, key.authTag, enabled, existing.id);
    return existing.id;
  }
  const inserted = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', ?)
  `).run(platform, label, key.encrypted, key.iv, key.authTag, enabled);
  return Number(inserted.lastInsertRowid);
}

function normalizeModelEntry(entry: z.infer<typeof modelEntrySchema>): NormalizedCustomModel {
  if (typeof entry === 'string') return { modelId: entry.trim(), displayName: entry.trim() };
  const modelId = entry.model.trim();
  return { ...entry, modelId, displayName: entry.displayName?.trim() || modelId };
}

function ensureFallbackRow(db: Db, modelDbId: number, enabled = true, updateExisting = true): void {
  const existing = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
  if (existing) {
    if (updateExisting) {
      db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?').run(enabled ? 1 : 0, modelDbId);
    }
    return;
  }
  const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)')
    .run(modelDbId, max.m + 1, enabled ? 1 : 0);
  // A chain row alone is not enough to be routable: when a profile is active the
  // router reads profile_models, so a declaratively-added model would be present
  // in the dashboard yet never selected. routes/keys.ts does the same after its
  // own fallback_config insert.
  ensureModelInProfiles(db, modelDbId);
}

function registerCustomProvider(db: Db, input: z.infer<typeof customProviderSchema>): number {
  const keyId = upsertApiKey(db, {
    platform: 'custom',
    key: input.apiKey,
    label: input.label,
    baseUrl: input.baseUrl,
    enabled: true,
  });
  // Same median seeding as the dashboard's custom-model path (#488): an
  // undeclared rank means "unknown", not "worst". An explicitly declared rank
  // always wins.
  const seed = customModelSeed(db);
  // Model identity is per endpoint (#651): declaring the same model id under a
  // second base_url adds a row for that endpoint instead of stealing the first
  // one's.
  const endpointScope = endpointScopeForBaseUrl(input.baseUrl);
  let registered = 0;
  for (const entry of input.models) {
    const model = normalizeModelEntry(entry);
    db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, key_id, source, endpoint_scope)
      VALUES ('custom', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1, ?, ?, ?, 'user', ?)
      ON CONFLICT(platform, model_id, endpoint_scope)
      DO UPDATE SET
        display_name = excluded.display_name,
        intelligence_rank = excluded.intelligence_rank,
        speed_rank = excluded.speed_rank,
        size_label = excluded.size_label,
        monthly_token_budget = excluded.monthly_token_budget,
        context_window = excluded.context_window,
        supports_vision = excluded.supports_vision,
        supports_tools = excluded.supports_tools,
        key_id = excluded.key_id,
        enabled = 1
    `).run(
      model.modelId,
      model.displayName,
      model.intelligenceRank ?? seed.intelligenceRank,
      model.speedRank ?? seed.speedRank,
      model.sizeLabel ?? seed.sizeLabel,
      model.monthlyTokenBudget ?? '',
      model.contextWindow ?? null,
      model.supportsVision ? 1 : 0,
      model.supportsTools ? 1 : 0,
      keyId,
      endpointScope,
    );
    const row = db.prepare(
      "SELECT id FROM models WHERE platform = 'custom' AND model_id = ? AND endpoint_scope = ?",
    ).get(model.modelId, endpointScope) as { id: number };
    ensureFallbackRow(db, row.id, model.fallbackEnabled !== false);
    registered++;
  }
  return registered;
}

function modelPatchFromInput(input: z.infer<typeof modelSchema>): ModelOverridePatch {
  const patch: ModelOverridePatch = {};
  for (const key of [
    'displayName', 'intelligenceRank', 'speedRank', 'sizeLabel',
    'rpmLimit', 'rpdLimit', 'tpmLimit', 'tpdLimit',
    'monthlyTokenBudget', 'contextWindow', 'supportsVision', 'supportsTools',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) patch[key] = input[key] as never;
  }
  return patch;
}

interface DeclaredModelRow {
  id: number;
  platform: string;
  model_id: string;
  key_id: number | null;
  source: string;
  endpoint_scope: string;
}

/**
 * The ONE models row a declarative entry names, or undefined when there is no
 * such model yet.
 *
 * For catalog platforms this is the old lookup: (platform, model_id) is unique,
 * so nothing changes. For 'custom' two relays can hold the same model id
 * (#651), and `SELECT ... LIMIT 1` would patch whichever row the query happened
 * to return — silently editing the wrong relay. So an ambiguous entry is
 * refused, and the config author gets the endpoints to choose from.
 */
function resolveDeclaredModel(
  db: Db,
  platform: string,
  modelId: string,
  endpoint: string | undefined,
): DeclaredModelRow | undefined {
  const rows = db.prepare(
    'SELECT id, platform, model_id, key_id, source, endpoint_scope FROM models WHERE platform = ? AND model_id = ? ORDER BY id',
  ).all(platform, modelId) as DeclaredModelRow[];

  if (endpoint) {
    const named = rows.filter(r => r.endpoint_scope && endpointRefMatches(endpoint, r.endpoint_scope));
    if (named.length === 1) return named[0];
    if (named.length === 0) {
      throw new Error(
        `${platform}/${modelId}: no custom endpoint matching '${endpoint}' serves this model` +
        `${rows.length > 0 ? ` (known: ${rows.map(r => r.endpoint_scope || '(none)').join(', ')})` : ''}. ` +
        'A "models" entry edits a model that already exists — register it under "customProviders" first.',
      );
    }
    throw new Error(`${platform}/${modelId}: endpoint '${endpoint}' matches more than one endpoint`);
  }

  if (rows.length > 1) {
    throw new Error(
      `${platform}/${modelId} exists on more than one endpoint — add an "endpoint" to say which one ` +
      `(${rows.map(r => r.endpoint_scope || '(none)').join(', ')})`,
    );
  }
  return rows[0];
}

function upsertModel(db: Db, input: z.infer<typeof modelSchema>): void {
  const platform = input.platform.trim();
  const modelId = input.modelId.trim();
  clearCatalogModelTombstone(db, 'chat', platform, modelId);
  const existing = resolveDeclaredModel(db, platform, modelId, input.endpoint);

  if (!existing) {
    // A declaratively-created model is user-owned: catalog sync must never
    // update or prune it (see applyCatalog). Patching an EXISTING catalog row
    // below does NOT flip ownership — the row's existence is still catalog-
    // managed and the edit is recorded as an override instead.
    db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user')
    `).run(
      platform,
      modelId,
      input.displayName ?? modelId,
      input.intelligenceRank ?? 50,
      input.speedRank ?? 50,
      input.sizeLabel ?? 'User',
      input.rpmLimit ?? null,
      input.rpdLimit ?? null,
      input.tpmLimit ?? null,
      input.tpdLimit ?? null,
      input.monthlyTokenBudget ?? '',
      input.contextWindow ?? null,
      input.enabled === false ? 0 : 1,
      input.supportsVision ? 1 : 0,
      input.supportsTools ? 1 : 0,
    );
    const created = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number };
    ensureFallbackRow(db, created.id, input.fallbackEnabled ?? input.enabled !== false);
    return;
  }

  const patch = modelPatchFromInput(input);
  const assignments: string[] = [];
  const values: unknown[] = [];
  const columnMap: Record<keyof ModelOverridePatch, string> = {
    displayName: 'display_name',
    intelligenceRank: 'intelligence_rank',
    speedRank: 'speed_rank',
    sizeLabel: 'size_label',
    rpmLimit: 'rpm_limit',
    rpdLimit: 'rpd_limit',
    tpmLimit: 'tpm_limit',
    tpdLimit: 'tpd_limit',
    monthlyTokenBudget: 'monthly_token_budget',
    contextWindow: 'context_window',
    supportsVision: 'supports_vision',
    supportsTools: 'supports_tools',
    enabled: 'enabled',
  };
  for (const key of Object.keys(patch) as Array<keyof ModelOverridePatch>) {
    assignments.push(`${columnMap[key]} = ?`);
    values.push(key === 'supportsVision' || key === 'supportsTools' ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (input.enabled !== undefined) {
    assignments.push('enabled = ?');
    values.push(input.enabled ? 1 : 0);
  }
  if (assignments.length > 0) {
    values.push(existing.id);
    db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  }
  if (isCatalogManagedModel(existing) && Object.keys(patch).length > 0) {
    upsertModelOverrides(db, platform, modelId, patch);
  }
  ensureFallbackRow(db, existing.id, input.fallbackEnabled ?? input.enabled !== false, input.fallbackEnabled !== undefined);
}

function applyFallback(db: Db, entries: z.infer<typeof fallbackEntrySchema>[]): number {
  const update = db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
  let changed = 0;
  entries.forEach((entry, i) => {
    const row = resolveDeclaredModel(db, entry.platform, entry.modelId, entry.endpoint);
    if (!row) return;
    ensureFallbackRow(db, row.id, entry.enabled !== false);
    update.run(entry.priority ?? i + 1, entry.enabled === false ? 0 : 1, row.id);
    changed++;
  });
  return changed;
}

export function applyDeclarativeConfig(input: unknown, source = 'inline'): DeclarativeConfigResult {
  const parsed = declarativeConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid declarative config: ${parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
  }

  const db = getDb();
  const result: DeclarativeConfigResult = {
    applied: true,
    source,
    keys: 0,
    customModels: 0,
    models: 0,
    fallback: 0,
    routing: false,
    warnings: [],
  };

  const apply = db.transaction(() => {
    for (const key of parsed.data.keys ?? []) {
      const warning = missingKeyWarning(key);
      if (warning) {
        result.warnings.push(warning);
        console.warn(`[config] ${warning}`);
        continue;
      }
      upsertApiKey(db, key);
      result.keys++;
    }
    for (const customProvider of parsed.data.customProviders ?? []) {
      result.customModels += registerCustomProvider(db, customProvider);
    }
    for (const model of parsed.data.models ?? []) {
      upsertModel(db, model);
      result.models++;
    }
    if (parsed.data.fallback) {
      result.fallback = applyFallback(db, parsed.data.fallback);
    }
    if (parsed.data.routing) {
      if (parsed.data.routing.weights) setCustomWeights(parsed.data.routing.weights);
      setRoutingStrategy(parsed.data.routing.strategy);
      if (parsed.data.routing.keySelectionStrategy) {
        setKeySelectionStrategy(parsed.data.routing.keySelectionStrategy);
      }
      result.routing = true;
    }
  });
  apply();
  return result;
}

export function applyDeclarativeConfigFromEnv(): DeclarativeConfigResult {
  const loaded = readConfigFromEnv();
  if (!loaded) {
    return { applied: false, keys: 0, customModels: 0, models: 0, fallback: 0, routing: false, warnings: [] };
  }
  const result = applyDeclarativeConfig(loaded.value, loaded.source);
  console.log(
    `[config] applied ${loaded.source}: ${result.keys} keys, ${result.customModels} custom models, ` +
      `${result.models} model edits, ${result.fallback} fallback rows${result.routing ? ', routing' : ''}` +
      `${result.warnings.length > 0 ? `, ${result.warnings.length} entries skipped` : ''}`,
  );
  return result;
}
