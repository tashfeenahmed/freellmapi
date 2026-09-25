import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { getPostgresPool } from '../../db/postgres.js';
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

describe('Model management API', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates catalog model metadata', async () => {
    const pool = getPostgresPool();
    const res = await pool.query('SELECT id FROM models ORDER BY id LIMIT 1');
    const targetId = res.rows[0].id;

    const { status, body } = await request(app, 'PATCH', `/api/models/${targetId}`, {
      displayName: 'Locally tuned model',
      supportsTools: true,
      contextWindow: 123456,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const checkRes = await pool.query(
      'SELECT display_name, supports_tools, context_window FROM models WHERE id = $1',
      [targetId]
    );
    expect(checkRes.rows[0]).toMatchObject({
      display_name: 'Locally tuned model',
      supports_tools: true,
      context_window: 123456,
    });
  });

  it('deletes custom model', async () => {
    const pool = getPostgresPool();
    const provRes = await pool.query("SELECT id FROM providers WHERE provider_key = 'custom' LIMIT 1");
    const provId = provRes.rows[0].id;

    const modelRes = await pool.query(
      `INSERT INTO models (provider_id, model_id, canonical_name, display_name)
       VALUES ($1, 'to-delete-model', 'to-delete-model', 'To Delete') RETURNING id`,
      [provId]
    );
    const modelId = modelRes.rows[0].id;

    const { status, body } = await request(app, 'DELETE', `/api/models/${modelId}`);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, id: modelId });

    const check = await pool.query('SELECT id FROM models WHERE id = $1', [modelId]);
    expect(check.rows.length).toBe(0);
  });
});
