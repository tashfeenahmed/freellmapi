import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { ensurePersistenceSchema } from '../db/persistence-schema.js';
import { decrypt } from '../lib/crypto.js';
import { discoverProviderModels } from '../providers/catalog/index.js';
import type { DiscoveredModel } from '../providers/catalog/types.js';

let discoveryTimer: NodeJS.Timeout | null = null;

function idFor(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function upsertDiscoveredModel(model: DiscoveredModel): void {
  const db = getDb();
  const id = idFor(model.provider_slug, model.provider_model_id);
  const existing = db.prepare(`
    SELECT display_name, status, context_window, supports_tools, supports_vision, supports_json
    FROM provider_catalog_models
    WHERE provider_slug = ? AND provider_model_id = ?
  `).get(model.provider_slug, model.provider_model_id) as any | undefined;

  const payload = {
    displayName: model.display_name ?? model.provider_model_id,
    contextWindow: model.context_window ?? null,
    maxOutputTokens: model.max_output_tokens ?? null,
    supportsTools: model.supports_tools ? 1 : 0,
    supportsVision: model.supports_vision ? 1 : 0,
    supportsStreaming: model.supports_streaming === false ? 0 : 1,
    supportsJson: model.supports_json ? 1 : 0,
    inputModalities: JSON.stringify(model.input_modalities ?? []),
    outputModalities: JSON.stringify(model.output_modalities ?? []),
    raw: JSON.stringify(model.raw_metadata_json ?? {}),
  };

  db.prepare(`
    INSERT INTO provider_catalog_models (
      id, provider_slug, provider_model_id, display_name, status, context_window, max_output_tokens,
      supports_tools, supports_vision, supports_streaming, supports_json, input_modalities,
      output_modalities, raw_metadata_json, discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(provider_slug, provider_model_id) DO UPDATE SET
      display_name = excluded.display_name,
      status = 'active',
      context_window = excluded.context_window,
      max_output_tokens = excluded.max_output_tokens,
      supports_tools = excluded.supports_tools,
      supports_vision = excluded.supports_vision,
      supports_streaming = excluded.supports_streaming,
      supports_json = excluded.supports_json,
      input_modalities = excluded.input_modalities,
      output_modalities = excluded.output_modalities,
      raw_metadata_json = excluded.raw_metadata_json,
      removed_at = NULL,
      updated_at = datetime('now')
  `).run(
    id,
    model.provider_slug,
    model.provider_model_id,
    payload.displayName,
    payload.contextWindow,
    payload.maxOutputTokens,
    payload.supportsTools,
    payload.supportsVision,
    payload.supportsStreaming,
    payload.supportsJson,
    payload.inputModalities,
    payload.outputModalities,
    payload.raw,
  );

  if (!existing) {
    db.prepare(`
      INSERT INTO model_change_events (id, provider_slug, provider_model_id, change_type, old_value_json, new_value_json)
      VALUES (?, ?, ?, 'model_added', NULL, ?)
    `).run(idFor('event', model.provider_slug, model.provider_model_id, nowIso()), model.provider_slug, model.provider_model_id, payload.raw);
  } else if (existing.context_window !== payload.contextWindow) {
    db.prepare(`
      INSERT INTO model_change_events (id, provider_slug, provider_model_id, change_type, old_value_json, new_value_json)
      VALUES (?, ?, ?, 'context_window_changed', ?, ?)
    `).run(
      idFor('event', model.provider_slug, model.provider_model_id, 'context', nowIso()),
      model.provider_slug,
      model.provider_model_id,
      JSON.stringify({ contextWindow: existing.context_window }),
      JSON.stringify({ contextWindow: payload.contextWindow }),
    );
  }
}

function mirrorLegacyModelsIntoCatalog(): void {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM models').all() as any[];
  for (const row of rows) {
    upsertDiscoveredModel({
      provider_slug: row.platform,
      provider_model_id: row.model_id,
      display_name: row.display_name,
      context_window: row.context_window,
      supports_tools: row.supports_tools === 1,
      supports_vision: row.supports_vision === 1,
      supports_streaming: true,
      supports_json: false,
      raw_metadata_json: { source: 'legacy_models_table', rpm_limit: row.rpm_limit, rpd_limit: row.rpd_limit, tpm_limit: row.tpm_limit, tpd_limit: row.tpd_limit },
    });
    db.prepare(`
      INSERT INTO provider_model_limits (id, provider_slug, provider_model_id, rpm_limit, rpd_limit, tpm_limit, tpd_limit, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'legacy_models_table', datetime('now'))
      ON CONFLICT(provider_slug, provider_model_id) DO UPDATE SET
        rpm_limit = excluded.rpm_limit,
        rpd_limit = excluded.rpd_limit,
        tpm_limit = excluded.tpm_limit,
        tpd_limit = excluded.tpd_limit,
        source = excluded.source,
        updated_at = datetime('now')
    `).run(idFor('limit', row.platform, row.model_id), row.platform, row.model_id, row.rpm_limit, row.rpd_limit, row.tpm_limit, row.tpd_limit);
  }
}

function classifySizeLabel(contextWindow: number | null): string {
  if ((contextWindow ?? 0) >= 262144) return 'Frontier';
  if ((contextWindow ?? 0) >= 131072) return 'Large';
  if ((contextWindow ?? 0) >= 32768) return 'Medium';
  return 'Small';
}

function looksReasoningOrCoder(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes('coder') || id.includes('code') || id.includes('reason') || id.includes('r1') || id.includes('thinking');
}

function syncDiscoveredCatalogIntoLegacyModels(): number {
  const db = getDb();
  const discovered = db.prepare(`
    SELECT pcm.provider_slug, pcm.provider_model_id, pcm.display_name, pcm.context_window,
           pcm.supports_tools, pcm.supports_vision,
           pml.rpm_limit, pml.rpd_limit, pml.tpm_limit, pml.tpd_limit
    FROM provider_catalog_models pcm
    LEFT JOIN provider_model_limits pml
      ON pml.provider_slug = pcm.provider_slug AND pml.provider_model_id = pcm.provider_model_id
    WHERE pcm.status = 'active'
  `).all() as any[];

  let synced = 0;
  const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM fallback_config').get() as { max_priority: number };
  let nextPriority = maxPriority.max_priority + 1;

  for (const row of discovered) {
    const existing = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(row.provider_slug, row.provider_model_id) as { id: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE models SET
          display_name = COALESCE(?, display_name),
          context_window = COALESCE(?, context_window),
          supports_tools = ?,
          supports_vision = ?,
          rpm_limit = COALESCE(?, rpm_limit),
          rpd_limit = COALESCE(?, rpd_limit),
          tpm_limit = COALESCE(?, tpm_limit),
          tpd_limit = COALESCE(?, tpd_limit)
        WHERE id = ?
      `).run(
        row.display_name,
        row.context_window,
        row.supports_tools ? 1 : 0,
        row.supports_vision ? 1 : 0,
        row.rpm_limit,
        row.rpd_limit,
        row.tpm_limit,
        row.tpd_limit,
        existing.id,
      );
      synced += 1;
      continue;
    }

    // New upstream model: make it visible in the existing Models page, but do
    // not automatically route production traffic to it. The user can explicitly
    // enable it in the fallback chain after seeing it and testing the account.
    const displayName = row.display_name || row.provider_model_id;
    const contextWindow = row.context_window ?? null;
    const sizeLabel = classifySizeLabel(contextWindow);
    const intelligenceRank = looksReasoningOrCoder(row.provider_model_id) ? 6 : 12;
    const speedRank = 10;
    const monthlyBudget = 'discovered';

    const insert = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
        enabled, supports_vision, supports_tools
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      row.provider_slug,
      row.provider_model_id,
      displayName,
      intelligenceRank,
      speedRank,
      sizeLabel,
      row.rpm_limit ?? null,
      row.rpd_limit ?? null,
      row.tpm_limit ?? null,
      row.tpd_limit ?? null,
      monthlyBudget,
      contextWindow,
      row.supports_vision ? 1 : 0,
      row.supports_tools ? 1 : 0,
    );

    const modelDbId = Number(insert.lastInsertRowid);
    db.prepare(`
      INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
      VALUES (?, ?, 0)
    `).run(modelDbId, nextPriority++);
    synced += 1;
  }

  return synced;
}

function getAccountsForDiscovery() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys WHERE enabled = 1').all() as any[];
  return rows.map(row => {
    let apiKey = 'no-key';
    try {
      apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    } catch {
      apiKey = 'no-key';
    }
    return {
      id: String(row.id),
      providerSlug: row.platform,
      displayName: row.label || `${row.platform} account ${row.id}`,
      apiKey,
      baseUrl: row.base_url ?? null,
    };
  });
}

export async function runModelDiscoveryOnce(): Promise<{ discovered: number; accounts: number; errors: string[]; synced: number }> {
  const db = getDb();
  ensurePersistenceSchema(db);
  mirrorLegacyModelsIntoCatalog();

  const accounts = getAccountsForDiscovery();
  let discovered = 0;
  const errors: string[] = [];

  for (const account of accounts) {
    try {
      const models = await discoverProviderModels(account);
      const seen = new Set<string>();
      for (const model of models) {
        upsertDiscoveredModel(model);
        seen.add(model.provider_model_id);
        discovered += 1;
      }

      if (seen.size > 0) {
        const previous = db.prepare(`
          SELECT provider_model_id FROM provider_catalog_models
          WHERE provider_slug = ? AND status = 'active'
        `).all(account.providerSlug) as { provider_model_id: string }[];
        for (const row of previous) {
          if (!seen.has(row.provider_model_id)) {
            db.prepare(`
              UPDATE provider_catalog_models
              SET status = 'removed', removed_at = datetime('now'), updated_at = datetime('now')
              WHERE provider_slug = ? AND provider_model_id = ?
            `).run(account.providerSlug, row.provider_model_id);
          }
        }
      }
    } catch (error) {
      errors.push(`${account.providerSlug}/${account.id}: ${(error as Error).message}`);
    }
  }

  const synced = syncDiscoveredCatalogIntoLegacyModels();
  return { discovered, accounts: accounts.length, errors, synced };
}

export function startModelDiscoveryLoop(): void {
  if (discoveryTimer || process.env.MODEL_DISCOVERY_ENABLED === 'false') return;

  if (process.env.MODEL_DISCOVERY_ON_BOOT !== 'false') {
    void runModelDiscoveryOnce().catch(error => console.warn(`[model-discovery] ${error.message}`));
  }

  const intervalSeconds = Number(process.env.MODEL_DISCOVERY_INTERVAL_SECONDS ?? 21600);
  discoveryTimer = setInterval(() => {
    void runModelDiscoveryOnce().catch(error => console.warn(`[model-discovery] ${error.message}`));
  }, Math.max(300, intervalSeconds) * 1000);
  discoveryTimer.unref?.();
}
