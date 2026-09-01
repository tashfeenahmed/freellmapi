import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
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

// PATCH /api/keys/:id modelScope handling (#657).
describe('Keys API — model scope', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  function insertKey(): number {
    const { encrypted, iv, authTag } = encrypt('sk-test');
    const result = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
    return Number(result.lastInsertRowid);
  }

  it('sets a scope and surfaces it on the key list', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['llama-3.3-70b', 'qwen-2.5'] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toEqual(['llama-3.3-70b', 'qwen-2.5']);

    const list = await request(app, 'GET', '/api/keys');
    expect(list.status).toBe(200);
    expect(list.body.find((k: any) => k.id === id).modelScope).toEqual(['llama-3.3-70b', 'qwen-2.5']);
  });

  it('dedupes repeated ids', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1', 'm1', 'm2'] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toEqual(['m1', 'm2']);
  });

  it('null clears the scope', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: null });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toBeNull();

    const row = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.model_scope_json).toBeNull();

    const list = await request(app, 'GET', '/api/keys');
    expect(list.body.find((k: any) => k.id === id).modelScope).toBeNull();
  });

  it('an empty array clears the scope too', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: [] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toBeNull();
    const row = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.model_scope_json).toBeNull();
  });

  it('leaves the scope alone when only other fields are patched', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    await request(app, 'PATCH', `/api/keys/${id}`, { label: 'renamed' });
    const list = await request(app, 'GET', '/api/keys');
    expect(list.body.find((k: any) => k.id === id).modelScope).toEqual(['m1']);
  });

  it('persists and surfaces per-account provider limits independently', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, {
      providerRpmLimit: 30,
      providerRpdLimit: 750,
      providerTpdLimit: 125000,
    });
    expect(patch.status).toBe(200);

    const list = await request(app, 'GET', '/api/keys');
    const key = list.body.find((candidate: any) => candidate.id === id);
    expect(key).toMatchObject({
      providerRpmLimit: 30,
      providerRpdLimit: 750,
      providerTpdLimit: 125000,
    });

    const clear = await request(app, 'PATCH', `/api/keys/${id}`, {
      providerRpmLimit: null,
      providerRpdLimit: 0,
      providerTpdLimit: null,
    });
    expect(clear.status).toBe(200);
    expect(clear.body).toMatchObject({ providerRpmLimit: null, providerRpdLimit: 0, providerTpdLimit: null });
  });

  it('rejects malformed payloads', async () => {
    const id = insertKey();
    for (const modelScope of ['not-an-array', [''], [42], [{ id: 'x' }], ['x'.repeat(201)], Array.from({ length: 501 }, (_, i) => `m${i}`)]) {
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope });
      expect(patch.status, JSON.stringify(modelScope).slice(0, 60)).toBe(400);
    }
    // A body naming none of the updatable fields is still rejected.
    const empty = await request(app, 'PATCH', `/api/keys/${id}`, {});
    expect(empty.status).toBe(400);
  });

  it('404s on a missing key', async () => {
    const patch = await request(app, 'PATCH', '/api/keys/999999', { modelScope: ['m1'] });
    expect(patch.status).toBe(404);
  });
});
