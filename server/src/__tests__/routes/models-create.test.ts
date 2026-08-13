import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('POST /api/models (add model)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('creates a routable user model on a native platform', async () => {
    const created = await request(app, 'POST', '/api/models', {
      platform: 'groq',
      modelId: 'test-user-model',
      displayName: 'Test User Model',
      contextWindow: 100000,
      supportsVision: true,
      supportsTools: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.model).toMatchObject({ platform: 'groq', modelId: 'test-user-model', source: 'custom' });

    const db = getDb();
    const row = db.prepare("SELECT * FROM models WHERE platform = 'groq' AND model_id = 'test-user-model'").get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.source).toBe('user');
    expect(row.enabled).toBe(1);
    expect(row.deprecated).toBe(0);

    // A freshly added model must be routable: a fallback row plus a row in the
    // active profile's model list.
    const modelDbId = row.id as number;
    expect(db.prepare('SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?').get(modelDbId)).toEqual({ n: 1 });

    const profile = db.prepare("SELECT id FROM profiles WHERE type = 'default' ORDER BY id LIMIT 1").get() as { id: number };
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_models WHERE profile_id = ? AND model_db_id = ?').get(profile.id, modelDbId)).toEqual({ n: 1 });
  });

  it('rejects duplicate model ids on the same platform', async () => {
    const dup = await request(app, 'POST', '/api/models', { platform: 'groq', modelId: 'test-user-model' });
    expect(dup.status).toBe(409);
  });

  it('rejects the custom platform and unknown platforms', async () => {
    const custom = await request(app, 'POST', '/api/models', { platform: 'custom', modelId: 'x' });
    expect(custom.status).toBe(400);

    const unknown = await request(app, 'POST', '/api/models', { platform: 'nope', modelId: 'x' });
    expect(unknown.status).toBe(400);
  });
});
