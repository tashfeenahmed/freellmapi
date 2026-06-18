import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Models API contract:
//   GET    /api/models      → returns each row with `source` field
//   POST   /api/models      → adds a user-managed model (source='user')
//   PATCH  /api/models/:id  → edits the allow-listed fields only
//   DELETE /api/models/:id  → hard-deletes only when source='user'
//
// Identity-bearing fields (platform, modelId, source) and routing-policy
// fields (ranks, limits, monthly_token_budget) are immutable through this API
// — they are owned by the migration / catalog write paths.

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function insertSeedRow(platform: string, modelId: string, source: 'migration' | 'catalog' | 'user', enabled = 1): number {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                           monthly_token_budget, enabled, source)
       VALUES (?, ?, ?, 50, 50, 'Test', '', ?, ?)`,
    )
    .run(platform, modelId, modelId, enabled, source);
  const id = Number(info.lastInsertRowid);
  const max = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number }).m;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, max + 1);
  return id;
}

describe('Models API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    // Strip everything except the seeded migration models so each test starts
    // from a clean slate without losing the providers we register against.
    const db = getDb();
    db.prepare(`DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE source != 'migration')`).run();
    db.prepare(`DELETE FROM models WHERE source != 'migration'`).run();
  });

  // ----------- GET ----------------------------------------------------------
  it('GET /api/models response includes the source field', async () => {
    const { status, body } = await request(app, 'GET', '/api/models');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const m of body) {
      expect(['migration', 'catalog', 'user']).toContain(m.source);
    }
  });

  // ----------- POST ---------------------------------------------------------
  it('POST creates a user model with a fallback row', async () => {
    const { status, body } = await request(app, 'POST', '/api/models', {
      platform: 'groq',
      modelId: 'qwen-3-coder-next-512b',
      displayName: 'Qwen3 Coder Next',
    });
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.source).toBe('user');
    expect(body.id).toBeGreaterThan(0);

    const row = getDb()
      .prepare("SELECT source, enabled, display_name FROM models WHERE platform = 'groq' AND model_id = 'qwen-3-coder-next-512b'")
      .get() as { source: string; enabled: number; display_name: string };
    expect(row.source).toBe('user');
    expect(row.enabled).toBe(1);
    expect(row.display_name).toBe('Qwen3 Coder Next');

    const fb = getDb().prepare('SELECT id FROM fallback_config WHERE model_db_id = ?').get(body.id);
    expect(fb).toBeTruthy();
  });

  it('POST rejects platform=custom', async () => {
    const { status, body } = await request(app, 'POST', '/api/models', {
      platform: 'custom',
      modelId: 'X',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/custom/i);
    expect(body.error).toMatch(/keyIds/);
  });

  // ----------- POST keyIds[] form (custom multi-key write) ----------------
  // #custom-platform-model-management. The same handler accepts
  //   { keyIds: number[], modelId, displayName? }
  // for platform='custom', writing one row per keyId.
  describe('POST keyIds[] form', () => {
    function createCustomKey(baseUrl: string, label = 'k') {
      const db = getDb();
      const r = db
        .prepare(
          `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
           VALUES ('custom', ?, 'x', 'x', 'x', 'unknown', 1, ?)`,
        )
        .run(label, baseUrl);
      return Number(r.lastInsertRowid);
    }

    it('creates one models row per keyId, all source=user', async () => {
      const baseUrl = 'http://127.0.0.1:11434/v1';
      const k1 = createCustomKey(baseUrl, 'A');
      const k2 = createCustomKey(baseUrl, 'B');
      const { status, body } = await request(app, 'POST', '/api/models', {
        keyIds: [k1, k2],
        modelId: 'qwen3:8b',
        displayName: 'Qwen3 8B',
      });
      expect(status).toBe(200);
      expect(body.created).toHaveLength(2);
      expect(body.updated).toEqual([]);
      const rows = getDb()
        .prepare("SELECT id, source, key_id, display_name FROM models WHERE platform='custom' AND model_id IN (?, ?)")
        .all(`${k1}-qwen3:8b`, `${k2}-qwen3:8b`) as { id: number; source: string; key_id: number; display_name: string }[];
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.source).toBe('user');
        expect(r.display_name).toBe('Qwen3 8B');
      }
      // Each new row gets a fallback_config entry.
      for (const r of rows) {
        expect(getDb().prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(r.id)).toBeTruthy();
      }
    });

    it('UPDATEs existing rows on repeat submit and only touches display_name', async () => {
      const baseUrl = 'http://127.0.0.1:11500/v1';
      const k1 = createCustomKey(baseUrl);
      const k2 = createCustomKey(baseUrl);
      await request(app, 'POST', '/api/models', { keyIds: [k1, k2], modelId: 'm', displayName: 'M v1' });
      // Disable one row to verify ON CONFLICT does not flip enabled back to 1.
      getDb().prepare("UPDATE models SET enabled=0 WHERE platform='custom' AND model_id = ?").run(`${k1}-m`);

      const { status, body } = await request(app, 'POST', '/api/models', { keyIds: [k1, k2], modelId: 'm', displayName: 'M v2' });
      expect(status).toBe(200);
      expect(body.created).toEqual([]);
      expect(body.updated).toHaveLength(2);
      const rows = getDb()
        .prepare("SELECT model_id, display_name, enabled FROM models WHERE platform='custom' AND model_id IN (?, ?)")
        .all(`${k1}-m`, `${k2}-m`) as { model_id: string; display_name: string; enabled: number }[];
      for (const r of rows) {
        expect(r.display_name).toBe('M v2');
      }
      const disabled = rows.find(r => r.model_id === `${k1}-m`)!;
      expect(disabled.enabled).toBe(0); // not revived
    });

    it('partial existence yields mixed created/updated', async () => {
      const baseUrl = 'http://127.0.0.1:11600/v1';
      const k1 = createCustomKey(baseUrl);
      const k2 = createCustomKey(baseUrl);
      await request(app, 'POST', '/api/models', { keyIds: [k1], modelId: 'mix' });
      const { status, body } = await request(app, 'POST', '/api/models', { keyIds: [k1, k2], modelId: 'mix' });
      expect(status).toBe(200);
      expect(body.created).toHaveLength(1);
      expect(body.updated).toHaveLength(1);
    });

    it('rejects keyIds spanning multiple base_urls', async () => {
      const k1 = createCustomKey('http://127.0.0.1:11434/v1');
      const k2 = createCustomKey('http://127.0.0.1:9999/v1');
      const { status, body } = await request(app, 'POST', '/api/models', { keyIds: [k1, k2], modelId: 'X' });
      expect(status).toBe(400);
      expect(body.error).toMatch(/multiple base_urls/);
    });

    it('rejects keyIds for non-custom platform', async () => {
      const db = getDb();
      const r = db
        .prepare(
          `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
           VALUES ('groq', 'g', 'x', 'x', 'x', 'unknown', 1)`,
        )
        .run();
      const { status, body } = await request(app, 'POST', '/api/models', {
        keyIds: [Number(r.lastInsertRowid)],
        modelId: 'X',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/custom/);
    });

    it('rejects keyIds with invalid (unknown) ids', async () => {
      const { status, body } = await request(app, 'POST', '/api/models', { keyIds: [9999999], modelId: 'X' });
      expect(status).toBe(400);
      expect(body.invalidIds).toContain(9999999);
    });
  });

  // ----------- POST keys.ts custom path tags source='user' ---------------

  it('POST rejects an unregistered platform', async () => {
    const { status, body } = await request(app, 'POST', '/api/models', {
      platform: 'unknown-vendor-xyz',
      modelId: 'X',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown platform/i);
  });

  it('POST returns 409 on UNIQUE conflict', async () => {
    insertSeedRow('groq', 'collide-me', 'catalog');
    const { status, body } = await request(app, 'POST', '/api/models', {
      platform: 'groq',
      modelId: 'collide-me',
    });
    expect(status).toBe(409);
    expect(body.existingId).toBeDefined();
  });

  // ----------- PATCH --------------------------------------------------------
  it('PATCH can disable a catalog model', async () => {
    const id = insertSeedRow('groq', 'patch-enabled', 'catalog', 1);
    const { status, body } = await request(app, 'PATCH', `/api/models/${id}`, { enabled: false });
    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.source).toBe('catalog'); // unchanged
    const row = getDb().prepare('SELECT enabled FROM models WHERE id = ?').get(id) as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('PATCH can rename displayName on a user model', async () => {
    const id = insertSeedRow('groq', 'patch-name', 'user');
    const { status, body } = await request(app, 'PATCH', `/api/models/${id}`, { displayName: 'New Name' });
    expect(status).toBe(200);
    expect(body.displayName).toBe('New Name');
  });

  it('PATCH rejects platform/modelId/source in body', async () => {
    const id = insertSeedRow('groq', 'patch-immutable', 'user');
    const { status, body } = await request(app, 'PATCH', `/api/models/${id}`, {
      platform: 'cerebras',
      modelId: 'something-else',
      source: 'catalog',
    });
    expect(status).toBe(400);
    expect(body.fields).toEqual(expect.arrayContaining(['platform', 'modelId', 'source']));
    // Persistence unchanged.
    const row = getDb().prepare('SELECT platform, model_id, source FROM models WHERE id = ?').get(id) as {
      platform: string;
      model_id: string;
      source: string;
    };
    expect(row).toEqual({ platform: 'groq', model_id: 'patch-immutable', source: 'user' });
  });

  it('PATCH on a missing id returns 404', async () => {
    const { status } = await request(app, 'PATCH', '/api/models/9999999', { enabled: false });
    expect(status).toBe(404);
  });

  // ----------- DELETE -------------------------------------------------------
  it('DELETE on a user model succeeds and cascades fallback_config', async () => {
    const id = insertSeedRow('groq', 'delete-me-user', 'user');
    expect(getDb().prepare('SELECT id FROM fallback_config WHERE model_db_id = ?').get(id)).toBeTruthy();
    const { status, body } = await request(app, 'DELETE', `/api/models/${id}`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(id)).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM fallback_config WHERE model_db_id = ?').get(id)).toBeUndefined();
  });

  it('DELETE on a catalog model returns 400 with the disable hint', async () => {
    const id = insertSeedRow('groq', 'delete-me-catalog', 'catalog');
    const { status, body } = await request(app, 'DELETE', `/api/models/${id}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/PATCH/);
    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(id)).toBeDefined();
  });

  it('DELETE on a migration model returns 400', async () => {
    const id = insertSeedRow('groq', 'delete-me-migration', 'migration');
    const { status, body } = await request(app, 'DELETE', `/api/models/${id}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/migration/);
    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(id)).toBeDefined();
  });

  it('DELETE on a missing id returns 404', async () => {
    const { status } = await request(app, 'DELETE', '/api/models/9999999');
    expect(status).toBe(404);
  });
});
