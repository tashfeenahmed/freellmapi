import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { up as mediaProvenanceUp, down as mediaProvenanceDown } from '../../db/migrations/20261125_000001_media_source_provenance.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { TRANSCRIPTION_PLATFORMS, VIDEO_PLATFORMS } from '../../services/media.js';
import { SEARCH_ENGINE_PLATFORMS, SEARCH_MODALITY } from '../../services/search.js';
import { CATALOG_DECISION_PLATFORMS, DECISION_MODALITY } from '../../services/decision.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// media_models.source is the provenance column that lets catalog-sync tell its
// own media rows apart from rows the user created, mirroring
// embedding-source-provenance.test.ts. Before it the prune guessed ownership
// from the platform alone, so a media row registered on a NATIVE platform was
// deleted by the next sync whenever the signed catalog did not list it.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

const IMAGE_PLATFORM = 'pollinations';

function imageModel(modelId: string, over: Record<string, unknown> = {}) {
  return {
    platform: IMAGE_PLATFORM,
    modelId,
    displayName: 'Catalog Image',
    intelligenceRank: 1,
    speedRank: 1,
    sizeLabel: 'N/A',
    limits: { rpm: null, rpd: null, tpm: null, tpd: null },
    monthlyTokenBudget: null,
    contextWindow: null,
    enabled: true,
    supportsVision: false,
    supportsTools: false,
    modality: 'image',
    mediaNote: 'catalog note',
    ...over,
  };
}

function catalogOf(models: unknown[], extra: Record<string, unknown> = {}): AnyCatalog {
  return {
    version: '2099.01.01',
    generatedAt: new Date().toISOString(),
    tier: 'live',
    models,
    quirks: [],
    ...extra,
  } as unknown as AnyCatalog;
}

function insertMedia(platform: string, modelId: string, modality: string, source: string, keyId: number | null = null) {
  getDb()
    .prepare(
      `INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, source)
       VALUES (?, ?, ?, ?, 1, 1, 'test', ?, ?)`,
    )
    .run(platform, modelId, `Row ${modelId}`, modality, keyId, source);
}

function mediaRow(platform: string, modelId: string) {
  return getDb()
    .prepare('SELECT id, display_name, source FROM media_models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number; display_name: string; source: string } | undefined;
}

describe('media_models.source provenance', () => {
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

  it('catalog sync inserts new media rows with source=catalog', () => {
    applyCatalog(getDb(), catalogOf([imageModel('prov/catalog-image')]));
    expect(mediaRow(IMAGE_PLATFORM, 'prov/catalog-image')?.source).toBe('catalog');
  });

  it('a native-platform user row survives a sync that does not list it; a stale catalog row is pruned', () => {
    insertMedia(IMAGE_PLATFORM, 'prov/native-user-image', 'image', 'user');
    expect(mediaRow(IMAGE_PLATFORM, 'prov/catalog-image')).toBeDefined();

    // The catalog lists neither row.
    const counts = applyCatalog(getDb(), catalogOf([imageModel('prov/other-image')]));

    expect(mediaRow(IMAGE_PLATFORM, 'prov/native-user-image')?.source).toBe('user');
    expect(mediaRow(IMAGE_PLATFORM, 'prov/catalog-image')).toBeUndefined();
    expect(counts.removed).toBeGreaterThanOrEqual(1);
  });

  it('user rows of every media modality survive snapshots that omit them', () => {
    const rows: [string, string, string][] = [
      [[...VIDEO_PLATFORMS][0], 'prov/user-video', 'video'],
      [[...TRANSCRIPTION_PLATFORMS][0], 'prov/user-stt', 'transcription'],
      [[...SEARCH_ENGINE_PLATFORMS][0], 'prov-user-search', SEARCH_MODALITY],
      [[...CATALOG_DECISION_PLATFORMS][0], 'prov/user-decision', DECISION_MODALITY],
    ];
    for (const [platform, modelId, modality] of rows) {
      insertMedia(platform, modelId, modality, 'user');
      insertMedia(platform, `${modelId}-catalog`, modality, 'catalog');
    }

    // Present-but-empty snapshots are authoritative, so each prune runs.
    const counts = applyCatalog(getDb(), catalogOf([], {
      videoModels: [], transcriptionModels: [], searchEngines: [], decisionModels: [],
    }));

    for (const [platform, modelId] of rows) {
      expect(mediaRow(platform, modelId)?.source).toBe('user');
      expect(mediaRow(platform, `${modelId}-catalog`)).toBeUndefined();
    }
    expect(counts.removed).toBeGreaterThanOrEqual(rows.length);
  });

  it('a user media row colliding with a catalog id is not clobbered (user wins)', () => {
    insertMedia(IMAGE_PLATFORM, 'prov/collide-image', 'image', 'user');
    applyCatalog(getDb(), catalogOf([imageModel('prov/collide-image', { displayName: 'Catalog Name' })]));
    expect(mediaRow(IMAGE_PLATFORM, 'prov/collide-image')).toMatchObject({ display_name: 'Row prov/collide-image', source: 'user' });

    // And when the colliding entry leaves the catalog again, the user row stays.
    applyCatalog(getDb(), catalogOf([imageModel('prov/other-image')]));
    expect(mediaRow(IMAGE_PLATFORM, 'prov/collide-image')?.source).toBe('user');
  });

  it('POST /api/media/custom stamps source=user on create and on re-registration', async () => {
    const body = { baseUrl: 'http://127.0.0.1:9333/v1', model: 'prov-custom-image', modality: 'image', apiKey: 'sk-test-bbbbbbbb' };
    expect((await request('POST', '/api/media/custom', body)).status).toBe(201);
    const select = "SELECT source FROM media_models WHERE platform = 'custom' AND model_id = 'prov-custom-image'";
    expect((getDb().prepare(select).get() as { source: string }).source).toBe('user');

    getDb().prepare("UPDATE media_models SET source = 'catalog' WHERE platform = 'custom' AND model_id = 'prov-custom-image'").run();
    expect((await request('POST', '/api/media/custom', body)).status).toBe(201);
    expect((getDb().prepare(select).get() as { source: string }).source).toBe('user');
  });

  describe('migration', () => {
    const VIDEO_PLATFORM = [...VIDEO_PLATFORMS][0];

    function resetWithRows() {
      const db = getDb();
      mediaProvenanceDown(db);
      db.prepare("DELETE FROM media_models WHERE model_id LIKE 'bf/%'").run();
      db.prepare("DELETE FROM api_keys WHERE label = 'bf-key'").run();
      const keyId = Number(
        db
          .prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag) VALUES ('nvidia', 'bf-key', 'x', 'x', 'x')")
          .run().lastInsertRowid,
      );
      const insert = db.prepare(
        `INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
         VALUES (?, ?, 'x', ?, 1, 1, '', ?)`,
      );
      insert.run('custom', 'bf/custom', 'image', null);
      insert.run('nvidia', 'bf/bound', 'image', keyId);
      insert.run(IMAGE_PLATFORM, 'bf/listed', 'image', null);
      insert.run(IMAGE_PLATFORM, 'bf/unlisted', 'image', null);
      insert.run(VIDEO_PLATFORM, 'bf/video-unlisted', 'video', null);
    }

    it('down drops the column and up restores it, idempotently', () => {
      const db = getDb();
      const cols = () => (db.prepare('PRAGMA table_info(media_models)').all() as { name: string }[]).map(c => c.name);
      mediaProvenanceDown(db);
      expect(cols()).not.toContain('source');
      mediaProvenanceUp(db);
      mediaProvenanceUp(db);
      expect(cols()).toContain('source');
      mediaProvenanceDown(db);
      mediaProvenanceDown(db);
      mediaProvenanceUp(db);
      expect(cols()).toContain('source');
    });

    it('backfills custom and key-bound rows as user, the rest as catalog when nothing was applied', () => {
      resetWithRows();
      getDb().prepare("DELETE FROM settings WHERE key = 'catalog_applied_json'").run();
      mediaProvenanceUp(getDb());
      expect(mediaRow('custom', 'bf/custom')?.source).toBe('user');
      expect(mediaRow('nvidia', 'bf/bound')?.source).toBe('user');
      expect(mediaRow(IMAGE_PLATFORM, 'bf/unlisted')?.source).toBe('catalog');
    });

    it('marks rows the applied catalog does not list as user, per modality snapshot', () => {
      resetWithRows();
      getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('catalog_applied_json', ?)").run(
        JSON.stringify({ version: '2026.01.01', models: [imageModel('bf/listed')], videoModels: [] }),
      );
      mediaProvenanceUp(getDb());
      expect(mediaRow(IMAGE_PLATFORM, 'bf/listed')?.source).toBe('catalog');
      expect(mediaRow(IMAGE_PLATFORM, 'bf/unlisted')?.source).toBe('user');
      // An empty snapshot means "leave untouched", so the video row keeps the default.
      expect(mediaRow(VIDEO_PLATFORM, 'bf/video-unlisted')?.source).toBe('catalog');
    });

    it('survives a corrupt applied catalog', () => {
      resetWithRows();
      getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('catalog_applied_json', '{not json')").run();
      expect(() => mediaProvenanceUp(getDb())).not.toThrow();
      expect(mediaRow('custom', 'bf/custom')?.source).toBe('user');
    });
  });
});
