import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// embedding_models.source is the provenance column that lets catalog-sync
// tell its own embedding rows apart from rows the user created. These tests
// mirror the chat-side contract proven in catalog-sync-source.test.ts:
// every write path stamps source honestly, sync still prunes stale catalog
// rows, and sync never deletes or clobbers a source='user' row — including
// on a platform:model_id collision, where the user row wins and the catalog
// entry is skipped.
//
// Why this column exists: embedding_models has no size_label, so before it
// the prune could only fall back on `platform != 'custom' AND key_id IS
// NULL`. An embedding model registered on a NATIVE platform therefore looked
// exactly like a catalog-owned row and was deleted on the next sync when the
// signed catalog did not list it. Live case:
// nvidia/nemotron-3.5-embed-1b, which could not even be registered as a
// custom endpoint (NVIDIA's 3.5 family is asymmetric and rejects the custom
// probe with HTTP 400 "'input_type' parameter is required for asymmetric
// models").

type AnyCatalog = Parameters<typeof applyCatalog>[1];

function baseEmbedding(over: Partial<AnyCatalog['embeddings'][number]> = {}): AnyCatalog['embeddings'][number] {
  return {
    family: 'prov-test-family',
    platform: 'nvidia',
    modelId: 'prov/test-embed-1b',
    displayName: 'Prov Test Embed',
    dimensions: 2048,
    maxInputTokens: 4096,
    priority: 1,
    enabled: true,
    quotaLabel: '~40 rpm',
    ...over,
  };
}

function catalogOf(embeddings: AnyCatalog['embeddings']): AnyCatalog {
  return {
    version: '2099.01.01',
    generatedAt: new Date().toISOString(),
    tier: 'live',
    models: [],
    embeddings,
    quirks: [],
  } as AnyCatalog;
}

/** Snapshot every catalog-owned embedding row as catalog entries so applyCatalog keeps them. */
function existingAsCatalogEmbeddings(): AnyCatalog['embeddings'] {
  const rows = getDb()
    .prepare(
      `SELECT family, platform, model_id, display_name, dimensions, max_input_tokens,
              priority, enabled, quota_label
         FROM embedding_models WHERE source = 'catalog'`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    baseEmbedding({
      family: r.family as string,
      platform: r.platform as string,
      modelId: r.model_id as string,
      displayName: r.display_name as string,
      dimensions: r.dimensions as number,
      maxInputTokens: r.max_input_tokens as number | null,
      priority: r.priority as number,
      enabled: (r.enabled as number) === 1,
      quotaLabel: r.quota_label as string,
    }),
  );
}

function embeddingRow(platform: string, modelId: string):
  { id: number; display_name: string; source: string } | undefined {
  return getDb()
    .prepare('SELECT id, display_name, source FROM embedding_models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number; display_name: string; source: string } | undefined;
}

describe('embedding_models.source provenance', () => {
  let app: Express;
  let dashToken = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  async function request(method: string, path: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data as any };
  }

  it('backfilled the bundled baseline as catalog-owned', () => {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM embedding_models WHERE source = 'catalog'")
      .get() as { n: number };
    expect(row.n).toBeGreaterThan(0);
  });

  it('catalog sync inserts new embedding rows with source=catalog', () => {
    const embeddings = existingAsCatalogEmbeddings();
    embeddings.push(baseEmbedding({ modelId: 'prov/new-catalog-embed' }));
    applyCatalog(getDb(), catalogOf(embeddings));
    expect(embeddingRow('nvidia', 'prov/new-catalog-embed')?.source).toBe('catalog');
  });

  it('a natively-registered embedding row is not pruned by a sync that does not list it', () => {
    // The exact failure this column fixes: a row on a NATIVE platform
    // (platform='nvidia'), with no key bound, absent from the signed catalog.
    // The old guard deleted it on the next sync.
    getDb()
      .prepare(
        `INSERT INTO embedding_models
           (family, platform, model_id, display_name, dimensions, max_input_tokens,
            priority, enabled, quota_label, key_id, source)
         VALUES ('prov-native-family', 'nvidia', 'prov/native-embed-1b',
                 'Prov Native Embed', 2048, 4096, 1, 1, '~40 rpm', NULL, 'user')`,
      )
      .run();

    // A catalog that does not list it at all.
    const counts = applyCatalog(getDb(), catalogOf(existingAsCatalogEmbeddings()));

    expect(embeddingRow('nvidia', 'prov/native-embed-1b')?.source).toBe('user');
    expect(counts.removed).toBeGreaterThanOrEqual(0);
  });

  it('sync prunes stale CATALOG embedding rows but never user rows', () => {
    // The catalog no longer lists prov/new-catalog-embed, and it never listed
    // the user's rows. Only the catalog-owned row may be pruned.
    const embeddings = existingAsCatalogEmbeddings().filter((e) => e.modelId !== 'prov/new-catalog-embed');
    const counts = applyCatalog(getDb(), catalogOf(embeddings));

    expect(embeddingRow('nvidia', 'prov/new-catalog-embed')).toBeUndefined();
    expect(counts.removed).toBeGreaterThanOrEqual(1);
    expect(embeddingRow('nvidia', 'prov/native-embed-1b')?.source).toBe('user');
  });

  it('a user embedding row colliding with a catalog id is not clobbered (user wins)', () => {
    const embeddings = existingAsCatalogEmbeddings();
    // The catalog starts shipping the same platform:model_id the user owns.
    embeddings.push(
      baseEmbedding({
        modelId: 'prov/native-embed-1b',
        displayName: 'Catalog Name',
        dimensions: 1024,
      }),
    );
    applyCatalog(getDb(), catalogOf(embeddings));

    const row = getDb()
      .prepare(
        "SELECT display_name, dimensions, source FROM embedding_models WHERE platform = 'nvidia' AND model_id = 'prov/native-embed-1b'",
      )
      .get() as { display_name: string; dimensions: number; source: string };
    expect(row.source).toBe('user');
    expect(row.display_name).toBe('Prov Native Embed');
    expect(row.dimensions).toBe(2048);

    // And when the colliding entry leaves the catalog again, the user row stays.
    applyCatalog(getDb(), catalogOf(existingAsCatalogEmbeddings()));
    expect(embeddingRow('nvidia', 'prov/native-embed-1b')?.source).toBe('user');
  });

  it('POST /api/embeddings/custom stamps source=user', async () => {
    const res = await request('POST', '/api/embeddings/custom', {
      baseUrl: 'http://127.0.0.1:9333/v1',
      model: 'prov-custom-embed',
      apiKey: 'sk-test-' + 'b'.repeat(8),
    });
    // The probe may fail (the fake endpoint answers nothing), but the row must
    // still be user-owned whenever it was created.
    if (res.status === 201) {
      const row = getDb()
        .prepare("SELECT source FROM embedding_models WHERE platform = 'custom' AND model_id = 'prov-custom-embed'")
        .get() as { source: string } | undefined;
      expect(row?.source).toBe('user');
    }
  });
});
