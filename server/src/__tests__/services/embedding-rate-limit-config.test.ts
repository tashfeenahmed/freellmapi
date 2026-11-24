import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { registerCustomEmbeddingModel } from '../../services/embeddings.js';
import { catalogShapeProblems } from '../../services/catalog-sync.js';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

afterEach(() => vi.restoreAllMocks());

function addCustomKey(baseUrl = 'https://embed.example/v1'): number {
  const { encrypted, iv, authTag } = encrypt('custom-key');
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, baseUrl);
  return Number(row.lastInsertRowid);
}

/** A registration with every required field filled, plus optional windows. */
function reg(keyId: number, modelId: string, family: string, windows: Record<string, number | null | undefined> = {}) {
  return {
    keyId,
    modelId,
    family,
    displayName: null,
    dimensions: 8,
    maxInputTokens: null,
    quotaLabel: '',
    ...windows,
  };
}

function limitsOf(modelDbId: number) {
  return getDb().prepare(`
    SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM embedding_models WHERE id = ?
  `).get(modelDbId) as {
    rpm_limit: number | null; rpd_limit: number | null;
    tpm_limit: number | null; tpd_limit: number | null;
  };
}

/** The catalogue shape every valid payload needs (see catalog-shape.test.ts). */
function catalog(embeddings: Record<string, unknown>[]) {
  return {
    version: '2099.01.01',
    generatedAt: 'x',
    tier: 'live',
    models: [],
    quirks: [],
    embeddings,
  };
}

describe('embedding model rate-limit windows', () => {
  it('starts every window at NULL, so an unconfigured row behaves as before', () => {
    const keyId = addCustomKey();
    const { modelDbId } = registerCustomEmbeddingModel(getDb(), reg(keyId, 'plain-embed', 'plain'));
    expect(limitsOf(modelDbId)).toEqual({
      rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null,
    });
  });

  it('stores the windows an operator submits', () => {
    const keyId = addCustomKey();
    const { modelDbId } = registerCustomEmbeddingModel(getDb(), reg(keyId, 'limited-embed', 'limited', {
      rpmLimit: 30, rpdLimit: 1000, tpmLimit: 50000, tpdLimit: 1000000,
    }));
    expect(limitsOf(modelDbId)).toEqual({
      rpm_limit: 30, rpd_limit: 1000, tpm_limit: 50000, tpd_limit: 1000000,
    });
  });

  it('keeps a configured window when a re-submit says nothing about it', () => {
    const keyId = addCustomKey();
    const first = registerCustomEmbeddingModel(getDb(), reg(keyId, 'kept-embed', 'kept', { rpmLimit: 30 }));
    // A re-submit (a rename, a family change) must not wipe the cap: an
    // endpoint that was deliberately bounded stays bounded.
    const second = registerCustomEmbeddingModel(getDb(), reg(keyId, 'kept-embed', 'kept'));
    expect(second.modelDbId).toBe(first.modelDbId);
    expect(limitsOf(second.modelDbId).rpm_limit).toBe(30);
  });

  it('clears a window when the operator explicitly sends null', () => {
    const keyId = addCustomKey();
    registerCustomEmbeddingModel(getDb(), reg(keyId, 'clear-embed', 'clear', { rpmLimit: 30 }));
    const second = registerCustomEmbeddingModel(getDb(), reg(keyId, 'clear-embed', 'clear', { rpmLimit: null }));
    expect(limitsOf(second.modelDbId).rpm_limit).toBeNull();
  });

  it('accepts a catalogue that publishes the four windows', () => {
    const problems = catalogShapeProblems(catalog([{
      family: 'catalog-embed', platform: 'nvidia', modelId: 'nvidia/catalog-embed',
      displayName: 'Catalog Embed', dimensions: 2048, priority: 1, enabled: true,
      rpm: 30, rpd: 1000, tpm: 50000, tpd: 1000000,
    }]));
    expect(problems).toEqual([]);
  });

  it('rejects a catalogue that publishes a non-integer window', () => {
    const problems = catalogShapeProblems(catalog([{
      family: 'bad-embed', platform: 'nvidia', modelId: 'nvidia/bad-embed',
      displayName: 'Bad Embed', dimensions: 2048, priority: 1, enabled: true,
      rpm: '30',
    }]));
    expect(problems.length).toBeGreaterThan(0);
  });

  it('accepts a catalogue that omits the windows entirely', () => {
    const problems = catalogShapeProblems(catalog([{
      family: 'old-embed', platform: 'nvidia', modelId: 'nvidia/old-embed',
      displayName: 'Old Embed', dimensions: 2048, priority: 1, enabled: true,
    }]));
    expect(problems).toEqual([]);
  });
});
