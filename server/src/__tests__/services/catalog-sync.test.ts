import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb, setSetting, getSetting } from '../../db/index.js';
import { applyCatalog, reapplyCachedCatalog, MIN_CATALOG_VERSION } from '../../services/catalog-sync.js';
import { migrateDbSchema } from '../../db/migrations.js';

// applyCatalog is the write path between the published catalog and the live
// router DB. These tests lock its contract: catalog metadata always wins, the
// user's manual disables survive, custom-provider models are untouchable, and
// disappeared models are removed in FK-safe order.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

function baseModel(over: Partial<AnyCatalog['models'][number]> = {}): AnyCatalog['models'][number] {
  return {
    platform: 'groq',
    modelId: 'test-model',
    displayName: 'Test Model',
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Medium',
    limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 8192,
    enabled: true,
    supportsVision: false,
    supportsTools: true,
    ...over,
  };
}

function catalogOf(models: AnyCatalog['models'], quirks: AnyCatalog['quirks'] = []): AnyCatalog {
  return {
    version: '2099.01.01',
    generatedAt: new Date().toISOString(),
    tier: 'live',
    models,
    quirks,
  };
}

/** Snapshot every catalog-managed model as catalog entries so applyCatalog keeps them. */
function existingAsCatalogModels(): AnyCatalog['models'] {
  const rows = getDb()
    .prepare(
      `SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
              rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
              enabled, supports_vision, supports_tools
         FROM models WHERE platform != 'custom' AND key_id IS NULL`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    baseModel({
      platform: r.platform as string,
      modelId: r.model_id as string,
      displayName: r.display_name as string,
      intelligenceRank: r.intelligence_rank as number,
      speedRank: r.speed_rank as number,
      sizeLabel: r.size_label as string,
      limits: {
        rpm: r.rpm_limit as number | null,
        rpd: r.rpd_limit as number | null,
        tpm: r.tpm_limit as number | null,
        tpd: r.tpd_limit as number | null,
      },
      monthlyTokenBudget: r.monthly_token_budget as string,
      contextWindow: r.context_window as number | null,
      enabled: (r.enabled as number) === 1,
      supportsVision: (r.supports_vision as number) === 1,
      supportsTools: (r.supports_tools as number) === 1,
    }),
  );
}

describe('applyCatalog', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('inserts a new model with a fallback_config row', () => {
    const models = existingAsCatalogModels();
    models.push(baseModel({ modelId: 'brand-new-model', displayName: 'Brand New' }));

    const counts = applyCatalog(getDb(), catalogOf(models));
    expect(counts.inserted).toBe(1);

    const row = getDb()
      .prepare("SELECT id, enabled FROM models WHERE platform = 'groq' AND model_id = 'brand-new-model'")
      .get() as { id: number; enabled: number };
    expect(row.enabled).toBe(1);
    const fb = getDb().prepare('SELECT id FROM fallback_config WHERE model_db_id = ?').get(row.id);
    expect(fb).toBeTruthy();
  });

  it('updates metadata in place and respects the enabled policy', () => {
    const models = existingAsCatalogModels();
    const target = models.find((m) => m.modelId === 'brand-new-model')!;

    // User disables the model locally; catalog still says enabled -> stays off.
    getDb()
      .prepare("UPDATE models SET enabled = 0 WHERE platform = 'groq' AND model_id = 'brand-new-model'")
      .run();
    target.displayName = 'Brand New v2';
    target.limits = { rpm: 99, rpd: null, tpm: null, tpd: null };
    applyCatalog(getDb(), catalogOf(models));

    let row = getDb()
      .prepare("SELECT display_name, rpm_limit, enabled FROM models WHERE platform = 'groq' AND model_id = 'brand-new-model'")
      .get() as { display_name: string; rpm_limit: number; enabled: number };
    expect(row.display_name).toBe('Brand New v2');
    expect(row.rpm_limit).toBe(99);
    expect(row.enabled).toBe(0); // local disable survives

    // Catalog disables (dead upstream) -> force off even if user re-enabled.
    getDb()
      .prepare("UPDATE models SET enabled = 1 WHERE platform = 'groq' AND model_id = 'brand-new-model'")
      .run();
    target.enabled = false;
    applyCatalog(getDb(), catalogOf(models));
    row = getDb()
      .prepare("SELECT display_name, rpm_limit, enabled FROM models WHERE platform = 'groq' AND model_id = 'brand-new-model'")
      .get() as typeof row;
    expect(row.enabled).toBe(0);
  });

  it('removes models that left the catalog (and their fallback rows)', () => {
    const models = existingAsCatalogModels().filter((m) => m.modelId !== 'brand-new-model');
    const before = getDb()
      .prepare("SELECT id FROM models WHERE model_id = 'brand-new-model'")
      .get() as { id: number };

    const counts = applyCatalog(getDb(), catalogOf(models));
    expect(counts.removed).toBe(1);
    expect(getDb().prepare("SELECT id FROM models WHERE model_id = 'brand-new-model'").get()).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM fallback_config WHERE model_db_id = ?').get(before.id)).toBeUndefined();
  });

  it('never touches custom-provider models', () => {
    getDb()
      .prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
         VALUES ('custom', 'my-local-model', 'My Local', 50, 50, 'Custom', 1)`,
      )
      .run();

    // Catalog without the custom model: it must survive the delete pass.
    applyCatalog(getDb(), catalogOf(existingAsCatalogModels().filter((m) => m.platform !== 'custom')));
    const row = getDb().prepare("SELECT enabled FROM models WHERE platform = 'custom'").get() as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('skips models for platforms this binary has no provider for', () => {
    const models = existingAsCatalogModels();
    models.push(baseModel({ platform: 'some-future-provider', modelId: 'future-model' }));
    const counts = applyCatalog(getDb(), catalogOf(models));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect(getDb().prepare("SELECT id FROM models WHERE platform = 'some-future-provider'").get()).toBeUndefined();
  });

  it('replaces quirks wholesale', () => {
    const quirks: AnyCatalog['quirks'] = [
      {
        slug: 'fresh-quirk',
        title: 'Fresh quirk',
        body: 'New knowledge from the catalog.',
        severity: 'warning',
        targets: [{ platform: 'groq', modelGlob: null }],
      },
    ];
    const counts = applyCatalog(getDb(), catalogOf(existingAsCatalogModels(), quirks));
    expect(counts.quirks).toBe(1);

    const all = getDb().prepare('SELECT slug FROM quirks').all() as { slug: string }[];
    expect(all.map((q) => q.slug)).toEqual(['fresh-quirk']);
    const targets = getDb().prepare('SELECT platform, model_glob FROM quirk_targets').all();
    expect(targets).toEqual([{ platform: 'groq', model_glob: null }]);
  });
});

// reapplyCachedCatalog keeps the catalog authoritative across restarts:
// migrations re-assert the bundled baseline on every boot (INSERT OR IGNORE
// re-adds catalog-deleted models, family rules reset flags) while the boot
// sync 304s on an unchanged version. The cached re-apply closes that gap.
describe('reapplyCachedCatalog', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function cacheCatalog(catalog: AnyCatalog) {
    setSetting('catalog_applied_version', catalog.version);
    setSetting('catalog_applied_tier', catalog.tier);
    setSetting('catalog_applied_json', JSON.stringify(catalog));
  }

  it('restores catalog state over a re-run of the baseline migrations', () => {
    // Catalog says: one baseline model is gone. The victim must be one that a
    // re-runnable migration re-inserts on boot (V23's INSERT OR IGNORE rows),
    // not a first-init-only seed row — that re-insertion is the exact drift
    // this function exists to undo.
    const models = existingAsCatalogModels();
    const victim = models.find((m) => m.platform === 'openrouter' && m.modelId === 'moonshotai/kimi-k2.6:free')!;
    expect(victim).toBeDefined();
    const remaining = models.filter((m) => m.modelId !== victim.modelId);
    const catalog = catalogOf(remaining);
    applyCatalog(getDb(), catalog);
    cacheCatalog(catalog);
    expect(
      getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(victim.platform, victim.modelId),
    ).toBeUndefined();

    // Simulate a restart: migrations re-insert the baseline model.
    migrateDbSchema(getDb());
    expect(
      getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(victim.platform, victim.modelId),
    ).toBeDefined();

    // Boot re-apply removes it again from the local cache, no network.
    const result = reapplyCachedCatalog();
    expect(result.reapplied).toBe(true);
    expect(result.version).toBe(catalog.version);
    expect(
      getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(victim.platform, victim.modelId),
    ).toBeUndefined();
  });

  it('clears the applied version when an older install has no cached document', () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'catalog_applied_json'").run();
    setSetting('catalog_applied_version', '2099.01.01');
    const result = reapplyCachedCatalog();
    expect(result.reapplied).toBe(false);
    expect(getSetting('catalog_applied_version')).toBeUndefined();
  });

  it('is a no-op without throwing on a corrupt cache', () => {
    setSetting('catalog_applied_json', 'not json at all {');
    expect(reapplyCachedCatalog().reapplied).toBe(false);
  });

  it('refuses a cached catalog older than the bundled baseline', () => {
    const catalog = catalogOf(existingAsCatalogModels());
    catalog.version = '2000.01.01';
    expect(catalog.version < MIN_CATALOG_VERSION).toBe(true);
    setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect(reapplyCachedCatalog().reapplied).toBe(false);
  });
});
