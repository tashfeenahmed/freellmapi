import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function req(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Aliases API (logical-model-alias)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('creates an alias with level defaulting to low', async () => {
    const r = await req(app, 'POST', '/api/aliases', { name: 'glm5.2' });
    expect(r.status).toBe(201);
    expect(r.body.level).toBe('low');
    expect(r.body.priority).toBe(0);
    expect(r.body.enabled).toBe(true);
    expect(r.body.id).toBeGreaterThan(0);
  });

  it('creates an alias with explicit level/priority', async () => {
    const r = await req(app, 'POST', '/api/aliases', { name: 'ds-pro', level: 'high', priority: 3 });
    expect(r.status).toBe(201);
    expect(r.body.level).toBe('high');
    expect(r.body.priority).toBe(3);
  });

  it('rejects reserved level names (case-insensitive)', async () => {
    for (const name of ['high-level', 'High-Level', 'MIDDLE-LEVEL', 'low-level']) {
      const r = await req(app, 'POST', '/api/aliases', { name });
      expect(r.status).toBe(400);
    }
  });

  it('rejects duplicate names with 409', async () => {
    const r = await req(app, 'POST', '/api/aliases', { name: 'glm5.2' });
    expect(r.status).toBe(409);
    expect(r.body.existingId).toBeGreaterThan(0);
  });

  it('lists aliases ordered by level (high first) then priority', async () => {
    const r = await req(app, 'GET', '/api/aliases');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const names = r.body.map((a: any) => a.name);
    expect(names).toContain('glm5.2');
    expect(names).toContain('ds-pro');
    // ds-pro (high) before glm5.2 (low)
    expect(names.indexOf('ds-pro')).toBeLessThan(names.indexOf('glm5.2'));
  });

  it('patches level/priority/enabled', async () => {
    const list = await req(app, 'GET', '/api/aliases');
    const glm = list.body.find((a: any) => a.name === 'glm5.2');
    const r = await req(app, 'PATCH', `/api/aliases/${glm.id}`, { level: 'middle', priority: 5, enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.level).toBe('middle');
    expect(r.body.priority).toBe(5);
    expect(r.body.enabled).toBe(false);
  });

  it('rename triggers reserved-name check', async () => {
    const list = await req(app, 'GET', '/api/aliases');
    const glm = list.body.find((a: any) => a.name === 'glm5.2');
    const r = await req(app, 'PATCH', `/api/aliases/${glm.id}`, { name: 'low-level' });
    expect(r.status).toBe(400);
  });

  it('rename triggers duplicate check', async () => {
    const list = await req(app, 'GET', '/api/aliases');
    const glm = list.body.find((a: any) => a.name === 'glm5.2');
    const r = await req(app, 'PATCH', `/api/aliases/${glm.id}`, { name: 'ds-pro' });
    expect(r.status).toBe(409);
  });

  it('binds a model to an alias via POST /api/models', async () => {
    const list = await req(app, 'GET', '/api/aliases');
    const glm = list.body.find((a: any) => a.name === 'glm5.2');
    await req(app, 'PATCH', `/api/aliases/${glm.id}`, { enabled: true });
    const r = await req(app, 'POST', '/api/models', {
      platform: 'google', modelId: 'glm5.2-test', aliasId: glm.id, aliasPriority: 1,
    });
    expect(r.status).toBe(201);
    expect(r.body.aliasId).toBe(glm.id);
    expect(r.body.aliasPriority).toBe(1);
  });

  it('rejects POST /api/models with non-existent aliasId', async () => {
    const r = await req(app, 'POST', '/api/models', {
      platform: 'google', modelId: 'ghost-model', aliasId: 99999,
    });
    expect(r.status).toBe(400);
  });

  it('PATCH /api/models clears aliasId and GET reflects it', async () => {
    const models = await req(app, 'GET', '/api/models');
    const m = models.body.find((x: any) => x.modelId === 'glm5.2-test');
    expect(m.aliasId).toBeGreaterThan(0);
    const r = await req(app, 'PATCH', `/api/models/${m.id}`, { aliasId: null });
    expect(r.status).toBe(200);
    expect(r.body.aliasId).toBeNull();
    const models2 = await req(app, 'GET', '/api/models');
    const m2 = models2.body.find((x: any) => x.modelId === 'glm5.2-test');
    expect(m2.aliasId).toBeNull();
  });

  it('deletes an alias and clears member alias_id (ON DELETE SET NULL)', async () => {
    const created = await req(app, 'POST', '/api/aliases', { name: 'to-delete', level: 'high' });
    const model = await req(app, 'POST', '/api/models', {
      platform: 'google', modelId: 'member-test', aliasId: created.body.id, aliasPriority: 0,
    });
    expect(model.body.aliasId).toBe(created.body.id);
    const r = await req(app, 'DELETE', `/api/aliases/${created.body.id}`);
    expect(r.status).toBe(200);
    const models = await req(app, 'GET', '/api/models');
    const m = models.body.find((x: any) => x.modelId === 'member-test');
    expect(m).toBeDefined();
    expect(m.aliasId).toBeNull();
  });

  it('GET /api/aliases returns memberModelIds', async () => {
    const alias = await req(app, 'POST', '/api/aliases', { name: 'with-members', level: 'middle' });
    const model = await req(app, 'POST', '/api/models', {
      platform: 'google', modelId: 'wm-test', aliasId: alias.body.id, aliasPriority: 0,
    });
    const list = await req(app, 'GET', '/api/aliases');
    const a = list.body.find((x: any) => x.name === 'with-members');
    expect(a.memberModelIds).toContain(model.body.id);
  });

  it('returns 404 for non-existent alias on PATCH/DELETE', async () => {
    expect((await req(app, 'PATCH', '/api/aliases/99999', { level: 'low' })).status).toBe(404);
    expect((await req(app, 'DELETE', '/api/aliases/99999')).status).toBe(404);
  });
});
