import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  builtinDiscoveryMode,
  BUILTIN_DISCOVERY_PLATFORMS,
  autoRegistrable,
  builtinDiscoveryEligibility,
  registerDiscoveredModels,
  resetBuiltinDiscoveryThrottle,
  runBuiltinModelDiscovery,
  triggerBuiltinModelDiscovery,
} from '../../services/builtin-model-discovery.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { recordCatalogModelTombstone, isCatalogManagedModel } from '../../services/model-state.js';

// #1348: built-in OpenAI-compatible providers the signed catalog carries no
// models for fill their list from their own /models. These tests pin the
// eligibility rules (allowlist, catalog-managed, Premium-gated), the
// precedence of catalog and user rows over discovered ones, and how the
// catalog adopts and retires discovered rows later.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

const realFetch = globalThis.fetch;
const ORIGINAL_MODE = process.env.BUILTIN_MODEL_DISCOVERY;
const ORIGINAL_PATTERNS = process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;

function catalogModel(platform: string, modelId: string, enabled = true): AnyCatalog['models'][number] {
  return {
    platform,
    modelId,
    displayName: `${modelId} (catalog)`,
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Large',
    limits: { rpm: 30, rpd: 1000, tpm: null, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 131072,
    enabled,
    supportsVision: false,
    supportsTools: true,
  };
}

function catalogOf(models: AnyCatalog['models'], extra: Partial<AnyCatalog> = {}): AnyCatalog {
  return { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'monthly', models, quirks: [], ...extra };
}

/** Pretend `catalog` was the last one applied (what appliedCatalogPlatforms reads). */
function cacheAppliedCatalog(catalog: AnyCatalog): void {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES ('catalog_applied_json', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(catalog));
}

function addKey(platform: string, secret = 'sk-test', status = 'healthy'): number {
  const { encrypted, iv, authTag } = encrypt(secret);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, '', ?, ?, ?, ?, 1)
  `).run(platform, encrypted, iv, authTag, status);
  return Number(info.lastInsertRowid);
}

function stubModels(ids: Array<string | Record<string, unknown>>) {
  const mock = vi.fn(async () => new Response(
    JSON.stringify({ object: 'list', data: ids.map(id => typeof id === 'string' ? { id } : id) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  globalThis.fetch = mock as any;
  return mock;
}

function rows(platform: string) {
  return getDb().prepare(
    'SELECT id, model_id, source, display_name, enabled, key_id FROM models WHERE platform = ? ORDER BY model_id',
  ).all(platform) as Array<{ id: number; model_id: string; source: string; display_name: string; enabled: number; key_id: number | null }>;
}

describe('built-in model discovery (#1348)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.BUILTIN_MODEL_DISCOVERY = 'auto';
    delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    initDb(':memory:');
    resetBuiltinDiscoveryThrottle();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    if (ORIGINAL_MODE === undefined) delete process.env.BUILTIN_MODEL_DISCOVERY;
    else process.env.BUILTIN_MODEL_DISCOVERY = ORIGINAL_MODE;
    if (ORIGINAL_PATTERNS === undefined) delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    else process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = ORIGINAL_PATTERNS;
  });

  it('defaults to manual so nothing is registered without the operator picking it', () => {
    delete process.env.BUILTIN_MODEL_DISCOVERY;
    expect(builtinDiscoveryMode()).toBe('manual');
    process.env.BUILTIN_MODEL_DISCOVERY = 'auto';
    expect(builtinDiscoveryMode()).toBe('auto');
  });

  describe('eligibility', () => {
    it('allows only the allowlisted platforms the catalog does not carry', () => {
      const db = getDb();
      expect(builtinDiscoveryEligibility(db, 'siliconflow').eligible).toBe(true);
      expect(builtinDiscoveryEligibility(db, 'longcat').eligible).toBe(true);
      // Catalog-managed providers are never discoverable, whatever their state.
      expect(builtinDiscoveryEligibility(db, 'groq')).toMatchObject({ eligible: false, reason: 'not_allowlisted' });
      expect(builtinDiscoveryEligibility(db, 'custom').eligible).toBe(false);
    });

    it('keeps Premium-window and audited-off providers out of the allowlist', () => {
      // radeon/routeway ship enabled rows in the Premium catalog only (not yet
      // aged into free); reka/navy/opencode/orcarouter/xfyun carry disabled
      // rows the audit keeps off. A free install cannot see either, so the
      // allowlist is what keeps discovery from bypassing the gate.
      for (const gated of ['radeon', 'routeway', 'reka', 'navy', 'opencode', 'orcarouter', 'xfyun']) {
        expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain(gated);
        expect(builtinDiscoveryEligibility(getDb(), gated).eligible).toBe(false);
      }
    });

    it('is off limits once the applied catalog lists the platform, even with a disabled row', () => {
      cacheAppliedCatalog(catalogOf([catalogModel('siliconflow', 'Qwen/Qwen3-8B', false)]));
      expect(builtinDiscoveryEligibility(getDb(), 'siliconflow')).toMatchObject({ eligible: false, reason: 'catalog_managed' });
      expect(builtinDiscoveryEligibility(getDb(), 'longcat').eligible).toBe(true);
    });

    it('honors a names-only managedPlatforms entry (Premium window, no rows in this tier)', () => {
      cacheAppliedCatalog(catalogOf([], { managedPlatforms: ['longcat'] }));
      expect(builtinDiscoveryEligibility(getDb(), 'longcat')).toMatchObject({ eligible: false, reason: 'catalog_managed' });
    });

    it('is off limits while the bundled baseline still holds catalog rows for the platform', () => {
      // A fresh DB seeds github rows until the first catalog sync prunes them.
      const github = rows('github');
      expect(github.length).toBeGreaterThan(0);
      expect(builtinDiscoveryEligibility(getDb(), 'github')).toMatchObject({ eligible: false, reason: 'catalog_managed' });
      getDb().exec("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'github'); DELETE FROM models WHERE platform = 'github'; DELETE FROM embedding_models WHERE platform = 'github';");
      expect(builtinDiscoveryEligibility(getDb(), 'github').eligible).toBe(true);
    });

    it('can be switched off', () => {
      process.env.BUILTIN_MODEL_DISCOVERY = 'off';
      expect(builtinDiscoveryEligibility(getDb(), 'siliconflow')).toMatchObject({ eligible: false, reason: 'disabled' });
    });
  });

  describe('registration precedence', () => {
    it('writes discovered rows that route like catalog rows but are marked discovered', () => {
      const result = registerDiscoveredModels(getDb(), 'siliconflow', [{ modelId: 'deepseek-ai/DeepSeek-V3', contextWindow: 65536 }], { explicit: false });
      expect(result.created).toEqual(['deepseek-ai/DeepSeek-V3']);
      const [row] = rows('siliconflow');
      expect(row).toMatchObject({ model_id: 'deepseek-ai/DeepSeek-V3', source: 'discovered', enabled: 1, key_id: null });
      expect(getDb().prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(row!.id)).toBeTruthy();
      // Deleting one records a catalog tombstone, the "stays deleted" contract.
      expect(isCatalogManagedModel({ platform: 'siliconflow', key_id: null, source: 'discovered' })).toBe(true);
    });

    it('never overwrites an existing catalog or user row', () => {
      const db = getDb();
      db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, source)
                  VALUES ('siliconflow', 'from-user', 'Mine', 1, 1, 'Large', 'user')`).run();
      const result = registerDiscoveredModels(db, 'siliconflow', [{ modelId: 'from-user' }, { modelId: 'fresh' }], { explicit: true });
      expect(result.existing).toEqual(['from-user']);
      expect(result.created).toEqual(['fresh']);
      expect(rows('siliconflow').find(r => r.model_id === 'from-user')).toMatchObject({ source: 'user', display_name: 'Mine' });
    });

    it('keeps a deleted model deleted on automatic passes; an explicit pick lifts it', () => {
      const db = getDb();
      recordCatalogModelTombstone(db, 'chat', 'siliconflow', 'gone');
      expect(registerDiscoveredModels(db, 'siliconflow', [{ modelId: 'gone' }], { explicit: false }).tombstoned).toEqual(['gone']);
      expect(rows('siliconflow')).toEqual([]);
      expect(registerDiscoveredModels(db, 'siliconflow', [{ modelId: 'gone' }], { explicit: true }).created).toEqual(['gone']);
    });
  });

  describe('automatic filtering', () => {
    it('registers chat models only and skips models the upstream prices as paid', () => {
      const { accepted, nonChat, paid } = autoRegistrable([
        { id: 'chat-a', ownedBy: null },
        { id: 'text-embedding-3', ownedBy: null, kind: 'embedding' },
        { id: 'black-forest-labs/FLUX.1-schnell', ownedBy: null, kind: 'image' },
        { id: 'paid-chat', ownedBy: null, priceNote: '$1/M in $2/M out', isFree: false },
        { id: 'free-chat', ownedBy: null, priceNote: 'free', isFree: true },
      ]);
      expect(accepted.map(m => m.id)).toEqual(['chat-a', 'free-chat']);
      expect(nonChat).toBe(2);
      expect(paid).toBe(1);
    });

    it('applies CUSTOM_MODEL_SYNC_FREE_PATTERNS when set', () => {
      process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = '*:free';
      const { accepted } = autoRegistrable([{ id: 'a:free', ownedBy: null }, { id: 'b', ownedBy: null }]);
      expect(accepted.map(m => m.id)).toEqual(['a:free']);
    });
  });

  describe('runBuiltinModelDiscovery', () => {
    it('fetches the registered base URL with the stored key and registers new chat models', async () => {
      addKey('siliconflow', 'sk-silicon');
      const mock = stubModels(['deepseek-ai/DeepSeek-V3', 'BAAI/bge-m3-embedding', 'Qwen/Qwen3-8B']);

      const result = await runBuiltinModelDiscovery(getDb());

      expect(String(mock.mock.calls[0]![0])).toBe('https://api.siliconflow.com/v1/models');
      const init = mock.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-silicon');
      expect(result.added).toBe(2);
      expect(result.nonChatSkipped).toBe(1);
      expect(rows('siliconflow').map(r => r.model_id)).toEqual(['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3']);
    });

    it('does nothing for a platform without a usable key, or in manual mode', async () => {
      const mock = stubModels(['x']);
      expect((await runBuiltinModelDiscovery(getDb())).platforms).toBe(0);
      addKey('siliconflow');
      process.env.BUILTIN_MODEL_DISCOVERY = 'manual';
      expect((await runBuiltinModelDiscovery(getDb())).platforms).toBe(0);
      expect(mock).not.toHaveBeenCalled();
    });

    it('never touches a Premium-gated platform even with a healthy key', async () => {
      addKey('routeway');
      const mock = stubModels(['a:free']);
      await runBuiltinModelDiscovery(getDb(), 'routeway');
      expect(triggerBuiltinModelDiscovery(getDb(), 'routeway', 'key_added')).toBeNull();
      expect(mock).not.toHaveBeenCalled();
      expect(rows('routeway')).toEqual([]);
    });

    it('records upstream failures without throwing', async () => {
      addKey('longcat');
      globalThis.fetch = vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })) as any;
      const result = await runBuiltinModelDiscovery(getDb());
      expect(result.failures).toEqual([{ platform: 'longcat', error: expect.stringContaining('rejected the key') }]);
    });

    it('the healthy-check trigger runs once for an empty platform and then stays quiet', async () => {
      addKey('longcat');
      const mock = stubModels(['LongCat-Flash-Chat']);
      await triggerBuiltinModelDiscovery(getDb(), 'longcat', 'healthy');
      expect(rows('longcat').map(r => r.model_id)).toEqual(['LongCat-Flash-Chat']);
      expect(triggerBuiltinModelDiscovery(getDb(), 'longcat', 'healthy')).toBeNull();
      expect(mock).toHaveBeenCalledTimes(1);
    });
  });

  describe('catalog precedence on sync', () => {
    function stripCatalogRows(): AnyCatalog['models'] {
      // Keep every baseline catalog row so the apply only exercises the rows under test.
      return (getDb().prepare("SELECT platform, model_id FROM models WHERE source = 'catalog'").all() as Array<{ platform: string; model_id: string }>)
        .map(r => catalogModel(r.platform, r.model_id));
    }

    it('adopts a discovered row the catalog lists and retires the rest of that platform', () => {
      const db = getDb();
      registerDiscoveredModels(db, 'siliconflow', [{ modelId: 'listed' }, { modelId: 'unlisted' }], { explicit: false });
      registerDiscoveredModels(db, 'longcat', [{ modelId: 'untouched' }], { explicit: false });
      const listedId = rows('siliconflow').find(r => r.model_id === 'listed')!.id;

      applyCatalog(db, catalogOf([...stripCatalogRows(), catalogModel('siliconflow', 'listed')]));

      const silicon = rows('siliconflow');
      expect(silicon).toEqual([
        expect.objectContaining({ id: listedId, model_id: 'listed', source: 'catalog', display_name: 'listed (catalog)' }),
      ]);
      // A platform the catalog still does not manage keeps its discovered rows.
      expect(rows('longcat')).toEqual([expect.objectContaining({ model_id: 'untouched', source: 'discovered' })]);
    });

    it('retires discovered rows when the catalog manages the platform by name only', () => {
      const db = getDb();
      registerDiscoveredModels(db, 'longcat', [{ modelId: 'a' }], { explicit: false });
      applyCatalog(db, catalogOf(stripCatalogRows(), { managedPlatforms: ['longcat'] }));
      expect(rows('longcat')).toEqual([]);
    });

    it('keeps a local disable when the catalog adopts a discovered row', () => {
      const db = getDb();
      registerDiscoveredModels(db, 'siliconflow', [{ modelId: 'listed' }], { explicit: false });
      db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'siliconflow'").run();
      applyCatalog(db, catalogOf([...stripCatalogRows(), catalogModel('siliconflow', 'listed')]));
      expect(rows('siliconflow')[0]).toMatchObject({ source: 'catalog', enabled: 0 });
    });
  });
});
