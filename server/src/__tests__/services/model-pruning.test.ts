import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { pruneUpstreamRetiredModels, recordCatalogModelTombstone, isCatalogManagedModel } from '../../services/model-state.js';
import { runModelPruningPass } from '../../services/model-pruning.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const PLATFORM = 'groq';
const MODEL_ID = 'prune-test-model';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

function seedModel(modelId = MODEL_ID, enabled = 1): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, 'Prune Test', 50, 50, ?, 'catalog')
    ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET enabled = ?
  `).run(PLATFORM, modelId, enabled, enabled);
  const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(PLATFORM, modelId) as { id: number };
  db.prepare(`
    INSERT INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, 999, ?)
    ON CONFLICT(model_db_id) DO UPDATE SET enabled = ?
  `).run(row.id, enabled, enabled);
  return row.id;
}

function isRoutable(modelDbId: number): boolean {
  const row = getDb()
    .prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?')
    .get(modelDbId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function isEnabledInModels(modelDbId: number): boolean {
  const row = getDb()
    .prepare('SELECT enabled FROM models WHERE id = ?')
    .get(modelDbId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

describe('pruneUpstreamRetiredModels (model pruning — #1394)', () => {
  beforeEach(() => {
    const db = getDb();
    // Clean up in correct order due to foreign keys
    db.prepare("DELETE FROM catalog_model_tombstones WHERE model_id LIKE 'prune-test-%'").run();
    db.prepare("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'prune-test-%')").run();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'prune-test-%')").run();
    db.prepare("DELETE FROM models WHERE model_id LIKE 'prune-test-%'").run();
  });

  it('disables a model with upstream_eol tombstone but still enabled=1', () => {
    const id = seedModel();
    // Create upstream_eol tombstone without disabling the model
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID, { source: 'upstream_eol', reason: 'end of life' });
    // Model should still be enabled in models table
    expect(isEnabledInModels(id)).toBe(true);
    expect(isRoutable(id)).toBe(true);

    // Run pruning
    const pruned = pruneUpstreamRetiredModels(getDb());
    expect(pruned).toBe(1);

    // Model should now be disabled
    expect(isEnabledInModels(id)).toBe(false);
    // fallback_config should also be disabled
    expect(isRoutable(id)).toBe(false);
  });

  it('does not affect user-deleted tombstones (source=user)', () => {
    const id = seedModel();
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID, { source: 'user', reason: null });

    const pruned = pruneUpstreamRetiredModels(getDb());
    expect(pruned).toBe(0);
    expect(isEnabledInModels(id)).toBe(true);
    expect(isRoutable(id)).toBe(true);
  });

  it('does not affect models already disabled', () => {
    const id = seedModel('prune-test-disabled', 0); // already disabled
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'prune-test-disabled', { source: 'upstream_eol', reason: 'end of life' });

    const pruned = pruneUpstreamRetiredModels(getDb());
    expect(pruned).toBe(0);
    expect(isEnabledInModels(id)).toBe(false);
  });

  it('handles multiple upstream_eol models', () => {
    const id1 = seedModel('prune-test-1');
    const id2 = seedModel('prune-test-2');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'prune-test-1', { source: 'upstream_eol', reason: 'end of life' });
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'prune-test-2', { source: 'upstream_eol', reason: 'end of life' });

    const pruned = pruneUpstreamRetiredModels(getDb());
    expect(pruned).toBe(2);

    expect(isEnabledInModels(id1)).toBe(false);
    expect(isEnabledInModels(id2)).toBe(false);
  });

  it('idempotent: running twice prunes only once', () => {
    const id = seedModel();
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID, { source: 'upstream_eol', reason: 'end of life' });

    expect(pruneUpstreamRetiredModels(getDb())).toBe(1);
    expect(pruneUpstreamRetiredModels(getDb())).toBe(0);
  });
});

describe('runModelPruningPass (scheduler integration)', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM catalog_model_tombstones WHERE model_id LIKE 'prune-pass-%'").run();
    db.prepare("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'prune-pass-%')").run();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'prune-pass-%')").run();
    db.prepare("DELETE FROM models WHERE model_id LIKE 'prune-pass-%'").run();
  });

  it('runs pruning and returns count', async () => {
    const id = seedModel('prune-pass-1');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'prune-pass-1', { source: 'upstream_eol', reason: 'end of life' });

    const pruned = await runModelPruningPass();
    expect(pruned).toBe(1);
    expect(isEnabledInModels(id)).toBe(false);
  });
});

describe('catalog sync vs. upstream retirement + pruning (#1394)', () => {
  function catalogWith(modelId: string, enabled: boolean) {
    return {
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live' as const,
      models: [{
        platform: PLATFORM,
        modelId,
        displayName: 'Prune Test',
        intelligenceRank: 50,
        speedRank: 50,
        sizeLabel: 'Medium',
        limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
        monthlyTokenBudget: '~1M',
        contextWindow: 8192,
        enabled,
        supportsVision: false,
        supportsTools: true,
      }],
      quirks: [],
    } as unknown as Parameters<typeof applyCatalog>[1];
  }

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM catalog_model_tombstones WHERE model_id LIKE 'prune-sync-%'").run();
    db.prepare("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'prune-sync-%')").run();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'prune-sync-%')").run();
    db.prepare("DELETE FROM models WHERE model_id LIKE 'prune-sync-%'").run();
  });

  it('re-enables an auto-retired model when a later catalog still lists it (before pruning runs)', () => {
    const id = seedModel('prune-sync-relisted');
    // Manually create tombstone + disable (simulating noteModelRetirementSignal)
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'prune-sync-relisted', { source: 'upstream_eol', reason: 'end of life' });
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(id);
    getDb().prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(id);
    expect(isEnabledInModels(id)).toBe(false);

    // Apply catalog that still lists the model enabled
    applyCatalog(getDb(), catalogWith('prune-sync-relisted', true));

    // Model should be re-enabled by catalog sync
    expect(isEnabledInModels(id)).toBe(true);
    expect(isRoutable(id)).toBe(true);
    expect(getDb().prepare('SELECT 1 FROM catalog_model_tombstones WHERE model_id = ?').get('prune-sync-relisted')).toBeUndefined();
  });

  it('pruning does not delete user-tombstoned models (unchanged behavior)', () => {
    seedModel('prune-sync-user-deleted');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'prune-sync-user-deleted');
    applyCatalog(getDb(), catalogWith('prune-sync-user-deleted', true));
    // User tombstones cause deletion
    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(PLATFORM, 'prune-sync-user-deleted')).toBeUndefined();
  });
});