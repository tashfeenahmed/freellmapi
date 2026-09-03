import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { runCustomModelSync, customModelSyncIntervalMs, customModelSyncFreePatterns, startCustomModelSync } from '../../services/custom-model-sync.js';
import { discoverEndpointModels } from '../../services/model-discovery.js';
import { registerCustomModels } from '../../services/custom-model-register.js';
import { recordCustomModelTombstone } from '../../services/custom-model-tombstone.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';

// The sync pass talks to the outside world ONLY through discoverEndpointModels;
// stub it so each test controls what an endpoint "serves" today.
vi.mock('../../services/model-discovery.js', async () => {
  const actual = await vi.importActual('../../services/model-discovery.js');
  return { ...actual, discoverEndpointModels: vi.fn() };
});

// Stored custom credentials are decrypted by the crypto module; make it return
// a stable plaintext so listCustomEndpoints can read back the rows we insert.
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_INTERVAL = process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS;

function addCustomEndpoint(baseUrl: string, label = 'endpoint'): void {
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, 'enc', 'iv', 'tag', 'healthy', 1, ?)
  `).run(label, baseUrl);
}

function addDisabledCustomEndpoint(baseUrl: string, label = 'disabled-endpoint'): void {
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, 'enc', 'iv', 'tag', 'healthy', 0, ?)
  `).run(label, baseUrl);
}

function customModelIds(): string[] {
  const rows = getDb().prepare("SELECT model_id FROM models WHERE platform = 'custom'").all() as { model_id: string }[];
  return rows.map(r => r.model_id).sort();
}

describe('custom model sync', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    // initDb seeds the real catalog; wipe it so each test controls its own rows.
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_INTERVAL === undefined) {
      delete process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS;
    } else {
      process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS = ORIGINAL_INTERVAL;
    }
  });

  it('reports zero endpoints when none are configured', async () => {
    const result = await runCustomModelSync(getDb());
    expect(result.endpoints).toBe(0);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('registers newly discovered models for a configured endpoint', async () => {
    addCustomEndpoint('http://localhost:9999');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'model-a', ownedBy: null },
      { id: 'model-b', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    expect(result.endpoints).toBe(1);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failures).toEqual([]);
    expect(customModelIds()).toEqual(['model-a', 'model-b']);
  });

  it('skips models already registered on the endpoint and adds the rest', async () => {
    addCustomEndpoint('http://localhost:9999');
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, endpoint_scope)
      VALUES ('custom', 'model-a', 'model-a', 50, 50, 'Medium', 1, ?)
    `).run(endpointScopeForBaseUrl('http://localhost:9999'));
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'model-a', ownedBy: null },
      { id: 'model-b', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(customModelIds()).toEqual(['model-a', 'model-b']);
  });

  it('never polls a disabled endpoint', async () => {
    addDisabledCustomEndpoint('http://off:9999');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'model-a', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    // Turning an endpoint off means "stop using this": the unattended pass must
    // not reach out to it, nor register (enabled) rows behind the operator's back.
    expect(discoverEndpointModels).not.toHaveBeenCalled();
    expect(result.endpoints).toBe(0);
    expect(result.added).toBe(0);
    expect(customModelIds()).toEqual([]);
  });

  it('syncs the enabled endpoint while skipping a disabled one', async () => {
    addDisabledCustomEndpoint('http://off:9999');
    addCustomEndpoint('http://on:9999');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'model-a', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    expect(result.endpoints).toBe(1);
    expect(discoverEndpointModels).toHaveBeenCalledTimes(1);
    expect((discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('http://on:9999');
    expect(customModelIds()).toEqual(['model-a']);
  });

  it('isolates a failing endpoint and keeps syncing the rest', async () => {
    addCustomEndpoint('http://bad:9999');
    addCustomEndpoint('http://good:9999');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ id: 'model-c', ownedBy: null }]);

    const result = await runCustomModelSync(getDb());

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.baseUrl).toBe('http://bad:9999');
    expect(result.failures[0]!.error).toContain('boom');
    expect(result.added).toBe(1);
    expect(customModelIds()).toEqual(['model-c']);
  });

  it('parses the interval env: daily default, 0 disables the scheduled pass', () => {
    delete process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS;
    expect(customModelSyncIntervalMs()).toBe(24 * 60 * 60 * 1000);

    process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS = '3600000';
    expect(customModelSyncIntervalMs()).toBe(3600000);

    process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS = '0';
    expect(customModelSyncIntervalMs()).toBe(0);
    expect(startCustomModelSync(getDb(), { every: vi.fn(), after: vi.fn() } as never)).toBeNull();
  });

  it('parses free patterns from env', () => {
    const prev = process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    expect(customModelSyncFreePatterns()).toEqual([]);
    process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = ' *-free, free-* ,paid';
    expect(customModelSyncFreePatterns()).toEqual(['*-free', 'free-*', 'paid']);
    if (prev === undefined) delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    else process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = prev;
  });

  it('skips models that match no free pattern when FREE_PATTERNS is set', async () => {
    const prev = process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = '*:free,free-*';
    addCustomEndpoint('http://localhost:9999');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'free-model-a', ownedBy: null },
      { id: 'gpt-oss:free', ownedBy: null },
      { id: 'paid-model', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    expect(result.added).toBe(2);
    expect(result.paidSkipped).toBe(1);
    expect(customModelIds()).toEqual(['free-model-a', 'gpt-oss:free']);
    if (prev === undefined) delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    else process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = prev;
  });

  it('does not resurrect a model the operator deleted (tombstoned)', async () => {
    addCustomEndpoint('http://localhost:9999');
    const scope = endpointScopeForBaseUrl('http://localhost:9999');
    // The operator deleted this model from the list; the tombstone records that.
    recordCustomModelTombstone(getDb(), scope, 'model-a');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'model-a', ownedBy: null },
      { id: 'model-b', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    expect(result.tombstoned).toBe(1);
    expect(result.added).toBe(1);
    expect(customModelIds()).toEqual(['model-b']);
  });

  it('keeps the tombstone scoped: a deletion on one relay never hides the same id on another', async () => {
    addCustomEndpoint('http://relay-a:9999');
    addCustomEndpoint('http://relay-b:9999');
    recordCustomModelTombstone(getDb(), endpointScopeForBaseUrl('http://relay-a:9999'), 'shared-model');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'shared-model', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    expect(result.tombstoned).toBe(1);
    expect(result.added).toBe(1);
    // relay-b still registered its copy: only relay-a's deletion is honored.
    const rows = getDb().prepare(
      "SELECT model_id, endpoint_scope FROM models WHERE platform = 'custom' AND model_id = 'shared-model'",
    ).all() as { model_id: string; endpoint_scope: string }[];
    expect(rows).toEqual([{ model_id: 'shared-model', endpoint_scope: endpointScopeForBaseUrl('http://relay-b:9999') }]);
  });

  it('an explicit re-registration clears the tombstone so the next sync can add it again', async () => {
    addCustomEndpoint('http://localhost:9999');
    const scope = endpointScopeForBaseUrl('http://localhost:9999');
    recordCustomModelTombstone(getDb(), scope, 'model-a');
    // Operator changes their mind and explicitly re-adds the model.
    registerCustomModels(getDb(), 'http://localhost:9999', undefined, 'endpoint', undefined, [
      { modelId: 'model-a', displayName: null },
    ]);

    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'model-a', ownedBy: null },
    ]);

    const result = await runCustomModelSync(getDb());

    // Tombstone is gone: model-a is already registered again, so the pass just
    // sees an existing row (skipped), never a tombstoned one.
    expect(result.tombstoned).toBe(0);
    expect(result.skipped).toBe(1);
    expect(customModelIds()).toEqual(['model-a']);
  });

  it('skips discovered media/embedding models instead of registering them as chat (#1051)', async () => {
    addCustomEndpoint('http://localhost:9999');
    (discoverEndpointModels as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'glm-chat-mini', ownedBy: null },
      { id: 'stable-diffusion-3-5-large', ownedBy: null, kind: 'image' },
      { id: 'whisper-large-v3', ownedBy: null, kind: 'transcription' },
      { id: 'Wan2.2-T2V-A14B', ownedBy: null, kind: 'video' },
      { id: 'text-embedding-3-small', ownedBy: null, kind: 'embedding' },
    ]);

    const result = await runCustomModelSync(getDb());
    expect(result.added).toBe(1);
    expect(result.nonChatSkipped).toBe(4);
    expect(customModelIds()).toEqual(['glm-chat-mini']);
  });
});
