import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb, setSetting, getSetting } from '../../db/index.js';
import { applyCatalog, reapplyCachedCatalog, MIN_CATALOG_VERSION } from '../../services/catalog-sync.js';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import { recordCatalogModelTombstone, upsertModelOverrides } from '../../services/model-state.js';

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

type CatalogEmbedding = NonNullable<AnyCatalog['embeddings']>[number];

function existingAsCatalogEmbeddings(): CatalogEmbedding[] {
  const rows = getDb().prepare(`
    SELECT family, platform, model_id, display_name, dimensions,
           max_input_tokens, priority, enabled, quota_label
      FROM embedding_models
     WHERE platform != 'custom' AND key_id IS NULL
  `).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    family: r.family as string,
    platform: r.platform as string,
    modelId: r.model_id as string,
    displayName: r.display_name as string,
    dimensions: r.dimensions as number,
    maxInputTokens: r.max_input_tokens as number | null,
    priority: r.priority as number,
    enabled: (r.enabled as number) === 1,
    quotaLabel: r.quota_label as string,
  }));
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

  it('caps GitHub GPT-4.1 catalog context at the routable free-tier limit (#426)', () => {
    const models = existingAsCatalogModels();
    const target = models.find((m) => m.platform === 'github' && m.modelId === 'openai/gpt-4.1');
    expect(target).toBeDefined();
    target!.contextWindow = 128000;

    applyCatalog(getDb(), catalogOf(models));

    const row = getDb()
      .prepare("SELECT context_window FROM models WHERE platform = 'github' AND model_id = 'openai/gpt-4.1'")
      .get() as { context_window: number };
    expect(row.context_window).toBe(8000);
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

  it('re-applies local model overrides after catalog metadata refreshes', () => {
    const models = existingAsCatalogModels().filter((m) => m.modelId !== 'override-model');
    models.push(baseModel({
      modelId: 'override-model',
      displayName: 'Catalog Name',
      contextWindow: 1000,
      supportsTools: false,
    }));
    applyCatalog(getDb(), catalogOf(models));

    upsertModelOverrides(getDb(), 'groq', 'override-model', {
      displayName: 'Local Name',
      contextWindow: 12345,
      supportsTools: true,
    });

    const refreshed = existingAsCatalogModels().filter((m) => m.modelId !== 'override-model');
    refreshed.push(baseModel({
      modelId: 'override-model',
      displayName: 'Catalog Name v2',
      contextWindow: 2000,
      supportsTools: false,
    }));
    applyCatalog(getDb(), catalogOf(refreshed));

    const row = getDb().prepare(`
      SELECT display_name, context_window, supports_tools
        FROM models
       WHERE platform = 'groq' AND model_id = 'override-model'
    `).get() as { display_name: string; context_window: number; supports_tools: number };
    expect(row).toEqual({ display_name: 'Local Name', context_window: 12345, supports_tools: 1 });
  });

  it('keeps user-deleted catalog models deleted across catalog refreshes', () => {
    const models = existingAsCatalogModels().filter((m) => m.modelId !== 'tombstone-model');
    models.push(baseModel({ modelId: 'tombstone-model', displayName: 'Tombstone Me' }));
    applyCatalog(getDb(), catalogOf(models));
    expect(getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'tombstone-model'").get()).toBeDefined();

    recordCatalogModelTombstone(getDb(), 'chat', 'groq', 'tombstone-model');
    applyCatalog(getDb(), catalogOf(models));
    expect(getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'tombstone-model'").get()).toBeUndefined();

    applyCatalog(getDb(), catalogOf(models));
    expect(getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'tombstone-model'").get()).toBeUndefined();
  });

  it('skips models for platforms this binary has no provider for', () => {
    const models = existingAsCatalogModels();
    models.push(baseModel({ platform: 'some-future-provider', modelId: 'future-model' }));
    const counts = applyCatalog(getDb(), catalogOf(models));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect(getDb().prepare("SELECT id FROM models WHERE platform = 'some-future-provider'").get()).toBeUndefined();
  });

  it('applies the full embedding snapshot and retires a replaced provider id', () => {
    const embeddings = existingAsCatalogEmbeddings();
    const openRouter = embeddings.find(
      (m) => m.platform === 'openrouter' && m.modelId === 'nvidia/llama-nemotron-embed-vl-1b-v2',
    );
    expect(openRouter).toBeDefined();
    openRouter!.modelId = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
    openRouter!.displayName = 'Nemotron Embed VL 1B (OR free)';
    embeddings.push({
      family: 'sea-lion-e5-embedding-600m',
      platform: 'sealion',
      modelId: 'aisingapore/SEA-LION-E5-Embedding-600M',
      displayName: 'SEA-LION E5 Embedding 600M',
      dimensions: 1024,
      maxInputTokens: 8192,
      priority: 1,
      enabled: true,
      quotaLabel: 'free · 10 rpm',
    });
    const catalog = catalogOf(existingAsCatalogModels());
    catalog.embeddings = embeddings;

    applyCatalog(getDb(), catalog);

    expect(getDb().prepare(`
      SELECT id FROM embedding_models
       WHERE platform = 'openrouter' AND model_id = 'nvidia/llama-nemotron-embed-vl-1b-v2'
    `).get()).toBeUndefined();
    expect(getDb().prepare(`
      SELECT id FROM embedding_models
       WHERE platform = 'openrouter' AND model_id = 'nvidia/llama-nemotron-embed-vl-1b-v2:free'
    `).get()).toBeDefined();
    expect(getDb().prepare(`
      SELECT dimensions FROM embedding_models
       WHERE platform = 'sealion' AND model_id = 'aisingapore/SEA-LION-E5-Embedding-600M'
    `).get()).toEqual({ dimensions: 1024 });
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

    // Simulate a restart: re-run the baseline migrations so their
    // INSERT OR IGNORE re-adds the catalog-deleted model. The source-provenance
    // migration (20260726_000003) must stay recorded as applied — in the real
    // timeline its backfill runs exactly once (every install with an applied
    // catalog cache already has a migrations table), and re-running it here
    // would re-classify the baseline's re-inserted rows against the applied
    // catalog instead of leaving them catalog-owned.
    getDb().prepare("DELETE FROM migrations WHERE filename NOT LIKE '20260726_000003%'").run();
    runMigrationsSync(getDb(), 'up');
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

// The speech-to-text registry rides the catalog's dedicated optional
// `transcriptionModels` key (NOT the `models` array — old binaries would
// ingest unknown-modality models entries as chat models) and lands in
// media_models with modality='transcription'. These tests lock the sync,
// prune scoping, enabled-merge, tombstone, and rejection rules.
describe('applyCatalog: transcriptionModels', () => {
  type CatalogTranscription = NonNullable<AnyCatalog['transcriptionModels']>[number];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function sttRoster(): CatalogTranscription[] {
    return [
      { platform: 'groq', modelId: 'whisper-large-v3-turbo', displayName: 'Whisper Large v3 Turbo (Groq)', priority: 0, enabled: true, maxBytes: 26214400 },
      { platform: 'groq', modelId: 'whisper-large-v3', displayName: 'Whisper Large v3 (Groq)', priority: 1, enabled: true, maxBytes: 26214400 },
      { platform: 'cloudflare', modelId: '@cf/openai/whisper-large-v3-turbo', displayName: 'Whisper Large v3 Turbo (Cloudflare Workers AI)', priority: 2, enabled: true, subtitleFormats: ['vtt'], requestStyle: 'json' },
      { platform: 'cloudflare', modelId: '@cf/openai/whisper', displayName: 'Whisper (Cloudflare Workers AI)', priority: 3, enabled: true, subtitleFormats: ['vtt'], requestStyle: 'binary' },
    ];
  }

  /** Catalog with an image media model plus (optionally) a STT snapshot. */
  function sttCatalog(entries?: CatalogTranscription[]): AnyCatalog {
    const models = existingAsCatalogModels();
    models.push(baseModel({
      platform: 'cloudflare',
      modelId: '@cf/test/image-model',
      displayName: 'Test Image Model',
      modality: 'image',
    }));
    const catalog = catalogOf(models);
    if (entries) catalog.transcriptionModels = entries;
    return catalog;
  }

  function sttRows(): Array<{ platform: string; model_id: string; enabled: number; priority: number; meta_json: string | null }> {
    return getDb().prepare(`
      SELECT platform, model_id, enabled, priority, meta_json
        FROM media_models
       WHERE modality = 'transcription'
       ORDER BY priority, id
    `).all() as any;
  }

  it('routes entries into media_models with modality, meta_json, and priority order', () => {
    const counts = applyCatalog(getDb(), sttCatalog(sttRoster()));
    expect(counts.inserted).toBeGreaterThanOrEqual(5); // 4 STT + the image row

    const rows = sttRows();
    expect(rows.map(r => `${r.platform}:${r.model_id}`)).toEqual([
      'groq:whisper-large-v3-turbo',
      'groq:whisper-large-v3',
      'cloudflare:@cf/openai/whisper-large-v3-turbo',
      'cloudflare:@cf/openai/whisper',
    ]);
    expect(JSON.parse(rows[0].meta_json!)).toEqual({ maxBytes: 26214400 });
    expect(JSON.parse(rows[2].meta_json!)).toEqual({ subtitleFormats: ['vtt'], requestStyle: 'json' });
    expect(JSON.parse(rows[3].meta_json!)).toEqual({ subtitleFormats: ['vtt'], requestStyle: 'binary' });

    // The image row landed alongside, in its own modality.
    const image = getDb().prepare(
      "SELECT modality FROM media_models WHERE platform = 'cloudflare' AND model_id = '@cf/test/image-model'",
    ).get() as { modality: string };
    expect(image.modality).toBe('image');
  });

  it('enabled merge: local disable survives a catalog enable; catalog disable forces off', () => {
    getDb().prepare(
      "UPDATE media_models SET enabled = 0 WHERE modality = 'transcription' AND model_id = 'whisper-large-v3'",
    ).run();
    applyCatalog(getDb(), sttCatalog(sttRoster())); // catalog still says enabled
    expect(sttRows().find(r => r.model_id === 'whisper-large-v3')!.enabled).toBe(0);

    getDb().prepare(
      "UPDATE media_models SET enabled = 1 WHERE modality = 'transcription' AND model_id = 'whisper-large-v3'",
    ).run();
    const roster = sttRoster();
    roster.find(m => m.modelId === 'whisper-large-v3')!.enabled = false;
    applyCatalog(getDb(), sttCatalog(roster));
    expect(sttRows().find(r => r.model_id === 'whisper-large-v3')!.enabled).toBe(0);

    // Restore for the following tests.
    applyCatalog(getDb(), sttCatalog(sttRoster()));
    getDb().prepare(
      "UPDATE media_models SET enabled = 1 WHERE modality = 'transcription'",
    ).run();
  });

  it('a catalog without the key leaves existing transcription rows untouched', () => {
    applyCatalog(getDb(), sttCatalog(undefined)); // old payload shape
    expect(sttRows()).toHaveLength(4);
  });

  it('prunes dropped transcription rows, scoped to the modality', () => {
    const roster = sttRoster().filter(m => m.modelId !== '@cf/openai/whisper');
    const counts = applyCatalog(getDb(), sttCatalog(roster));
    expect(counts.removed).toBe(1);
    expect(sttRows().map(r => r.model_id)).not.toContain('@cf/openai/whisper');
    // Image row untouched by the transcription prune.
    expect(getDb().prepare(
      "SELECT id FROM media_models WHERE model_id = '@cf/test/image-model'",
    ).get()).toBeDefined();
  });

  it('skips entries for platforms without a transcription adapter', () => {
    const roster = sttRoster();
    roster.push({ platform: 'nvidia', modelId: 'parakeet-stt', displayName: 'Parakeet', priority: 9, enabled: true });
    const counts = applyCatalog(getDb(), sttCatalog(roster));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect(sttRows().map(r => r.model_id)).not.toContain('parakeet-stt');
  });

  it('tombstoned (user-deleted) transcription models stay deleted', () => {
    recordCatalogModelTombstone(getDb(), 'media', 'groq', 'whisper-large-v3');
    applyCatalog(getDb(), sttCatalog(sttRoster()));
    expect(sttRows().map(r => r.model_id)).not.toContain('whisper-large-v3');
  });

  it('a malformed transcriptionModels key rejects the whole payload', () => {
    const catalog = sttCatalog(sttRoster());
    (catalog as any).transcriptionModels = [{ platform: 'groq' }]; // missing required fields
    setSetting('catalog_applied_json', JSON.stringify(catalog));
    // isCatalog gates both the network and the cached re-apply paths.
    expect(reapplyCachedCatalog().reapplied).toBe(false);
  });
});

// Video models use a dedicated optional top-level registry. That shape is the
// backward-compatibility boundary: clients released before video support ignore
// it, instead of misclassifying an unknown models[].modality as chat.
describe('applyCatalog: videoModels', () => {
  type CatalogVideo = NonNullable<AnyCatalog['videoModels']>[number];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function videoRoster(): CatalogVideo[] {
    return [
      {
        platform: 'pollinations',
        modelId: 'nova-reel',
        displayName: 'Nova Reel',
        priority: 0,
        enabled: true,
        quotaLabel: 'Recurring daily Pollen refill',
      },
      {
        platform: 'huggingface',
        modelId: 'Lightricks/LTX-Video-0.9.5',
        displayName: 'LTX-Video 0.9.5',
        priority: 1,
        enabled: true,
        quotaLabel: '$0.10 shared monthly credits',
        providerModelId: 'fal-ai/ltx-video-v095',
      },
    ];
  }

  function videoCatalog(entries?: CatalogVideo[]): AnyCatalog {
    const catalog = catalogOf(existingAsCatalogModels());
    if (entries) catalog.videoModels = entries;
    return catalog;
  }

  function videoRows(): Array<{ platform: string; model_id: string; enabled: number; priority: number; meta_json: string | null }> {
    return getDb().prepare(`
      SELECT platform, model_id, enabled, priority, meta_json
        FROM media_models
       WHERE modality = 'video'
       ORDER BY priority, id
    `).all() as any;
  }

  it('lands the video roster and provider-native metadata in media_models', () => {
    const counts = applyCatalog(getDb(), videoCatalog(videoRoster()));
    expect(counts.inserted).toBeGreaterThanOrEqual(2);
    expect(videoRows().map(r => `${r.platform}:${r.model_id}`)).toEqual([
      'pollinations:nova-reel',
      'huggingface:Lightricks/LTX-Video-0.9.5',
    ]);
    expect(videoRows()[0].meta_json).toBeNull();
    expect(JSON.parse(videoRows()[1].meta_json!)).toEqual({ providerModelId: 'fal-ai/ltx-video-v095' });
  });

  it('retains video rows when an older catalog omits the optional registry', () => {
    applyCatalog(getDb(), videoCatalog(undefined));
    expect(videoRows()).toHaveLength(2);
  });

  it('prunes only video rows when the registry drops a model', () => {
    const counts = applyCatalog(
      getDb(),
      videoCatalog(videoRoster().filter(m => m.platform !== 'pollinations')),
    );
    expect(counts.removed).toBe(1);
    expect(videoRows().map(r => r.model_id)).toEqual(['Lightricks/LTX-Video-0.9.5']);
  });

  it('skips a video entry without a runtime adapter', () => {
    const roster = videoRoster();
    roster.push({
      platform: 'cloudflare',
      modelId: 'future-video',
      displayName: 'Future Video',
      priority: 9,
      enabled: true,
    });
    const counts = applyCatalog(getDb(), videoCatalog(roster));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect(videoRows().map(r => r.model_id)).not.toContain('future-video');
  });

  it('keeps a user-deleted video model tombstoned', () => {
    recordCatalogModelTombstone(getDb(), 'media', 'pollinations', 'nova-reel');
    applyCatalog(getDb(), videoCatalog(videoRoster()));
    expect(videoRows().map(r => r.model_id)).not.toContain('nova-reel');
  });

  it('rejects malformed video metadata before applying the cached catalog', () => {
    const catalog = videoCatalog(videoRoster());
    (catalog.videoModels![0] as any).providerModelId = 42;
    setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect(reapplyCachedCatalog().reapplied).toBe(false);
  });
});

// Generative media rows (image/audio) carry adapter metadata in meta_json the
// same way transcription rows do — the flavour a platform's endpoint expects.
// Cloudflare hosts both JSON-body image models and the FLUX.2 family, whose
// schema takes multipart only, so the flag has to survive the sync.
describe('applyCatalog: generative media meta', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function imageCatalog(requestStyle?: string): AnyCatalog {
    const models = existingAsCatalogModels();
    models.push(baseModel({
      platform: 'cloudflare',
      modelId: '@cf/black-forest-labs/flux-2-klein-4b',
      displayName: 'FLUX.2 [klein] 4B',
      modality: 'image',
      ...(requestStyle ? { requestStyle } : {}),
    }));
    models.push(baseModel({
      platform: 'cloudflare',
      modelId: '@cf/black-forest-labs/flux-1-schnell',
      displayName: 'FLUX.1 [schnell]',
      modality: 'image',
    }));
    return catalogOf(models);
  }

  function metaOf(modelId: string): string | null {
    return (getDb().prepare('SELECT meta_json FROM media_models WHERE model_id = ?')
      .get(modelId) as { meta_json: string | null }).meta_json;
  }

  it('carries requestStyle onto an image row, and leaves rows without one NULL', () => {
    applyCatalog(getDb(), imageCatalog('multipart'));
    expect(JSON.parse(metaOf('@cf/black-forest-labs/flux-2-klein-4b')!)).toEqual({ requestStyle: 'multipart' });
    expect(metaOf('@cf/black-forest-labs/flux-1-schnell')).toBeNull();
  });

  it('clears meta when the catalog drops requestStyle (full-snapshot semantics)', () => {
    applyCatalog(getDb(), imageCatalog('multipart'));
    applyCatalog(getDb(), imageCatalog());
    expect(metaOf('@cf/black-forest-labs/flux-2-klein-4b')).toBeNull();
  });

  it('a non-string requestStyle rejects the whole payload', () => {
    const catalog = imageCatalog('multipart');
    (catalog.models[catalog.models.length - 2] as any).requestStyle = 42;
    setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect(reapplyCachedCatalog().reapplied).toBe(false);
  });
});
