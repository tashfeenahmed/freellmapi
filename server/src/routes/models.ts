import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Platform } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import { hasProvider, resolveProvider } from '../providers/index.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import {
  isCatalogManagedModel,
  overriddenFieldNames,
  recordCatalogModelTombstone,
  clearCatalogModelTombstone,
  upsertModelOverrides,
  type ModelOverridePatch,
} from '../services/model-state.js';
import { pruneUnavailableSavedFusionConfig } from '../services/fusion.js';
import { getActiveProfileId, ensureModelInProfiles } from '../services/profile-models.js';
import { endpointScopeForBaseUrl, endpointScopeOfKey, qualifiedModelMemberId } from '../lib/endpoint-scope.js';
import { clearCustomModelTombstone, recordCustomModelTombstone } from '../services/custom-model-tombstone.js';
import { customModelSeed } from '../services/custom-model-seed.js';
import { routableKeyIdsForModel } from '../services/router.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { customEndpointKeyIds } from '../services/custom-endpoint.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { recordRequest, recordTokens } from '../services/ratelimit.js';

export const modelsRouter = Router();

// Throttle map for model test endpoint: modelDbId -> lastTestTimestamp
const modelTestCooldowns = new Map<number, number>();
const MODEL_TEST_THROTTLE_MS = 5000;


const modelUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  intelligenceRank: z.number().int().min(1).max(1000).optional(),
  speedRank: z.number().int().min(1).max(1000).optional(),
  // '' is a legal value: size_label is TEXT NOT NULL DEFAULT '' and the empty
  // string is the canonical "unscored" tier (scores 0 on the intelligence
  // axis), so the dashboard's "None" option must be able to send it.
  sizeLabel: z.string().max(40).optional(),
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
}).strict();

const MODEL_FIELD_COLUMNS: Record<keyof ModelOverridePatch | 'enabled', string> = {
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

type ModelRow = {
  id: number;
  platform: string;
  model_id: string;
  key_id: number | null;
  source: string;
};

function dbValue(key: keyof typeof MODEL_FIELD_COLUMNS, value: unknown): unknown {
  if (key === 'enabled' || key === 'supportsVision' || key === 'supportsTools') return value ? 1 : 0;
  return value;
}

function fetchModelRow(id: number): ModelRow | undefined {
  return getDb()
    .prepare('SELECT id, platform, model_id, key_id, source FROM models WHERE id = ?')
    .get(id) as ModelRow | undefined;
}

const createModelSchema = z.object({
  platform: z.string().min(1).max(50),
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  keyId: z.number().int().positive().nullable().optional(),
  endpointScope: z.string().nullable().optional(),
}).strict();

modelsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const data = parsed.data;
  if (!hasProvider(data.platform as Platform) && data.platform !== 'custom') {
    res.status(400).json({ error: { message: `Invalid platform "${data.platform}"` } });
    return;
  }

  const db = getDb();

  let endpointScope = '';
  const boundKeyId: number | null = data.keyId ?? null;
  if (data.platform === 'custom') {
    if (data.endpointScope) {
      endpointScope = endpointScopeForBaseUrl(data.endpointScope);
    } else if (data.keyId != null) {
      endpointScope = endpointScopeOfKey(db, data.keyId);
    }
  }

  const existing = db.prepare(
    'SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ?'
  ).get(data.platform, data.modelId, endpointScope) as { id: number } | undefined;

  if (existing) {
    res.status(409).json({ error: { message: `Model "${data.modelId}" already exists for platform "${data.platform}"` } });
    return;
  }

  const seed = customModelSeed(db);

  const insertModel = db.transaction(() => {
    // Clear any tombstone so manual re-creation brings the model back into active state
    if (data.platform === 'custom') {
      clearCustomModelTombstone(db, endpointScope, data.modelId);
    } else {
      clearCatalogModelTombstone(db, 'chat', data.platform, data.modelId);
    }

    const info = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
        enabled, supports_vision, supports_tools, key_id, source, endpoint_scope
      ) VALUES (
        @platform, @modelId, @displayName, @intelligenceRank, @speedRank, @sizeLabel,
        @rpmLimit, @rpdLimit, @tpmLimit, @tpdLimit, '', @contextWindow,
        1, @supportsVision, @supportsTools, @keyId, 'user', @endpointScope
      )
    `).run({
      platform: data.platform,
      modelId: data.modelId,
      displayName: data.displayName || data.modelId,
      intelligenceRank: seed.intelligenceRank,
      speedRank: seed.speedRank,
      sizeLabel: seed.sizeLabel,
      rpmLimit: data.rpmLimit ?? null,
      rpdLimit: data.rpdLimit ?? null,
      tpmLimit: data.tpmLimit ?? null,
      tpdLimit: data.tpdLimit ?? null,
      contextWindow: data.contextWindow ?? null,
      supportsVision: data.supportsVision ? 1 : 0,
      supportsTools: data.supportsTools !== undefined ? (data.supportsTools ? 1 : 0) : 1,
      keyId: boundKeyId,
      endpointScope,
    });

    const modelDbId = Number(info.lastInsertRowid);

    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
    if (!inChain) {
      const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, max.m + 1);
    }
    ensureModelInProfiles(db, modelDbId);

    return modelDbId;
  });

  const createdId = insertModel();

  res.status(201).json({
    success: true,
    id: createdId,
    model: {
      id: createdId,
      platform: data.platform,
      modelId: data.modelId,
      displayName: data.displayName || data.modelId,
      contextWindow: data.contextWindow ?? null,
      rpmLimit: data.rpmLimit ?? null,
      rpdLimit: data.rpdLimit ?? null,
      tpmLimit: data.tpmLimit ?? null,
      tpdLimit: data.tpdLimit ?? null,
      supportsVision: Boolean(data.supportsVision),
      supportsTools: data.supportsTools ?? true,
      enabled: true,
      source: 'custom',
      endpointScope: endpointScope || null,
      keyId: boundKeyId,
    },
  });
});

modelsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT id, key_id, model_id FROM models WHERE id = ? AND platform = 'custom'").get(id) as { id: number; key_id: number | null; model_id: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    // #926: keep this deletion across the scheduled custom-model sync, or the
    // next daily pass re-registers a model the operator removed on purpose.
    recordCustomModelTombstone(db, endpointScopeOfKey(db, row.key_id), row.model_id);
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(id);
    db.prepare("DELETE FROM models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
    pruneUnavailableSavedFusionConfig();
  });
  remove();
  res.json({ success: true });
});

modelsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const parsed = modelUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const row = fetchModelRow(id);
  if (!row) {
    res.status(404).json({ error: { message: `Unknown model ${id}` } });
    return;
  }

  const modelPatch: Partial<typeof parsed.data> = { ...parsed.data };
  delete modelPatch.fallbackEnabled;
  const modelKeys = Object.keys(modelPatch) as Array<keyof typeof modelPatch>;
  if (modelKeys.length === 0 && parsed.data.fallbackEnabled === undefined) {
    res.status(400).json({ error: { message: 'No model fields provided' } });
    return;
  }

  const applyUpdate = db.transaction(() => {
    const disablesModel = modelPatch.enabled === false;

    if (modelKeys.length > 0) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const key of modelKeys) {
        assignments.push(`${MODEL_FIELD_COLUMNS[key as keyof typeof MODEL_FIELD_COLUMNS]} = ?`);
        values.push(dbValue(key as keyof typeof MODEL_FIELD_COLUMNS, modelPatch[key]));
      }
      values.push(id);
      db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

      if (isCatalogManagedModel(row)) {
        const overridePatch: ModelOverridePatch = {};
        for (const key of [
          'displayName', 'intelligenceRank', 'speedRank', 'sizeLabel',
          'rpmLimit', 'rpdLimit', 'tpmLimit', 'tpdLimit',
          'monthlyTokenBudget', 'contextWindow', 'supportsVision', 'supportsTools',
        ] as const) {
          if (Object.prototype.hasOwnProperty.call(modelPatch, key)) {
            overridePatch[key] = modelPatch[key] as never;
          }
        }
        upsertModelOverrides(db, row.platform, row.model_id, overridePatch);
      }

      if (disablesModel) {
        db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(id);
        pruneUnavailableSavedFusionConfig();
      }
    }

    if (disablesModel || parsed.data.fallbackEnabled !== undefined) {
      const next = disablesModel ? 0 : parsed.data.fallbackEnabled ? 1 : 0;
      db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?')
        .run(next, id);
      const activeProfileId = getActiveProfileId(db);
      if (activeProfileId != null) {
        db.prepare('UPDATE profile_models SET enabled = ? WHERE profile_id = ? AND model_db_id = ?')
          .run(next, activeProfileId, id);
      }
    }
  });
  applyUpdate();

  res.json({ success: true, id });
});

modelsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = fetchModelRow(id);
  if (!row) {
    res.status(404).json({ error: { message: `Unknown model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    if (isCatalogManagedModel(row)) {
      recordCatalogModelTombstone(db, 'chat', row.platform, row.model_id);
    } else if (row.platform === 'custom') {
      // #926: same "keep it deleted" contract for custom relay models — the
      // scheduled custom-model sync must not resurrect this row.
      recordCustomModelTombstone(db, endpointScopeOfKey(db, row.key_id), row.model_id);
    }
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
    if (row.platform === 'custom') deleteUnusedCustomEndpointKey(db, row.key_id);
    pruneUnavailableSavedFusionConfig();
  });
  remove();

  res.json({ success: true, tombstoned: isCatalogManagedModel(row) });
});

modelsRouter.post('/:id/test', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  // Per-model throttling: 5 seconds
  const now = Date.now();
  const lastTest = modelTestCooldowns.get(id);
  if (lastTest && now - lastTest < MODEL_TEST_THROTTLE_MS) {
    const waitSec = Math.ceil((MODEL_TEST_THROTTLE_MS - (now - lastTest)) / 1000);
    res.status(429).json({
      error: {
        message: `Model test is throttled. Please wait ${waitSec}s before testing again.`,
      },
    });
    return;
  }
  modelTestCooldowns.set(id, now);

  const db = getDb();
  const modelRow = db.prepare('SELECT id, platform, model_id, key_id FROM models WHERE id = ?').get(id) as {
    id: number;
    platform: string;
    model_id: string;
    key_id: number | null;
  } | undefined;

  if (!modelRow) {
    res.status(404).json({ error: { message: `Unknown model ${id}` } });
    return;
  }

  // Find a routable or enabled key for this model
  let keyRow: any = null;
  const routableKeys = routableKeyIdsForModel(id);
  if (routableKeys.length > 0) {
    keyRow = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(routableKeys[0]);
  } else if (modelRow.platform === 'custom') {
    if (modelRow.key_id != null) {
      const endpointKeyIds = customEndpointKeyIds(db, modelRow.key_id);
      const candidateKeys = db.prepare("SELECT * FROM api_keys WHERE platform = 'custom' AND enabled = 1 ORDER BY id ASC").all() as any[];
      keyRow = candidateKeys.find(k => endpointKeyIds.has(k.id) && scopeAllows(parseModelScope(k.model_scope_json), modelRow.model_id)) ?? null;
    }
  } else {
    const candidateKeys = db.prepare('SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY id ASC').all(modelRow.platform) as any[];
    keyRow = candidateKeys.find(k => scopeAllows(parseModelScope(k.model_scope_json), modelRow.model_id)) ?? null;
  }

  if (!keyRow) {
    res.json({
      success: false,
      modelId: modelRow.model_id,
      latencyMs: 0,
      error: 'No enabled API key available for this model',
    });
    return;
  }

  let apiKey = '';
  try {
    apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch (err: any) {
    res.json({
      success: false,
      modelId: modelRow.model_id,
      latencyMs: 0,
      error: `Failed to decrypt key: ${sanitizeProviderErrorMessage(err?.message)}`,
    });
    return;
  }

  const provider = resolveProvider(modelRow.platform as Platform, keyRow.base_url);
  if (!provider) {
    res.json({
      success: false,
      modelId: modelRow.model_id,
      latencyMs: 0,
      error: `Provider "${modelRow.platform}" is not available`,
    });
    return;
  }

  const proxyUrl = decryptProxyUrl(keyRow);
  const startTime = Date.now();

  try {
    const response = await withKeyProxy(proxyUrl, () =>
      provider.chatCompletion(
        apiKey,
        [{ role: 'user', content: 'ping' }],
        modelRow.model_id,
        { max_tokens: 4, timeoutMs: 15_000 },
      ),
    );
    const latencyMs = Date.now() - startTime;

    // Record successful test in rate-limit ledger
    recordRequest(modelRow.platform, modelRow.model_id, keyRow.id);
    const totalTokens = response?.usage?.total_tokens ?? (
      (response?.usage?.prompt_tokens ?? 0) + (response?.usage?.completion_tokens ?? 0)
    );
    if (totalTokens > 0) {
      recordTokens(modelRow.platform, modelRow.model_id, keyRow.id, totalTokens);
    }

    res.json({
      success: true,
      modelId: modelRow.model_id,
      latencyMs,
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    const sanitizedError = sanitizeProviderErrorMessage(err?.message ?? err);
    res.json({
      success: false,
      modelId: modelRow.model_id,
      latencyMs,
      error: sanitizedError,
    });
  }
});

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const activeProfileId = getActiveProfileId(db);
  const models = activeProfileId == null ? db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled,
           mo.overrides_json IS NOT NULL AS has_overrides, mo.overrides_json,
           ak.label AS key_label
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[] : db.prepare(`
    SELECT m.*, COALESCE(pm.priority, fc.priority) AS priority,
           COALESCE(pm.enabled, fc.enabled) AS fallback_enabled,
           mo.overrides_json IS NOT NULL AS has_overrides, mo.overrides_json,
           ak.label AS key_label
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    ORDER BY COALESCE(pm.priority, fc.priority, m.intelligence_rank) ASC
  `).all(activeProfileId) as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    // Real provenance from models.source ('catalog' | 'user'). The dashboard's
    // existing vocabulary for user-added rows is 'custom', so map 1:1 here —
    // this now also flags user models on native platforms (declarative
    // config / admin adds), which the old platform/key_id heuristic missed.
    source: m.source === 'user' ? 'custom' : 'catalog',
    keyId: m.key_id ?? null,
    keyLabel: m.key_label ?? null,
    // Endpoint identity for custom rows (#651); null for catalog models and for
    // custom rows that carry no endpoint scope.
    endpointScope: m.endpoint_scope || null,
    qualifiedModelId: qualifiedModelMemberId(m.platform, m.model_id, m.endpoint_scope),
    hasOverrides: Boolean(m.has_overrides),
    overrideFields: overriddenFieldNames(m.overrides_json),
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});
