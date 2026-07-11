import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

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

describe('Model management API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('updates catalog model metadata and records durable overrides', async () => {
    const target = getDb().prepare(`
      SELECT id FROM models
       WHERE platform = 'groq' AND key_id IS NULL
       ORDER BY id LIMIT 1
    `).get() as { id: number };

    const { status, body } = await request(app, 'PATCH', `/api/models/${target.id}`, {
      displayName: 'Locally tuned model',
      supportsTools: true,
      contextWindow: 123456,
      fallbackEnabled: false,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const row = getDb().prepare(`
      SELECT m.display_name, m.supports_tools, m.context_window, fc.enabled AS fallback_enabled
        FROM models m
        JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.id = ?
    `).get(target.id) as { display_name: string; supports_tools: number; context_window: number; fallback_enabled: number };
    expect(row).toEqual({
      display_name: 'Locally tuned model',
      supports_tools: 1,
      context_window: 123456,
      fallback_enabled: 0,
    });

    const override = getDb().prepare('SELECT overrides_json FROM model_overrides WHERE model_id = (SELECT model_id FROM models WHERE id = ?)')
      .get(target.id) as { overrides_json: string };
    expect(JSON.parse(override.overrides_json)).toMatchObject({
      displayName: 'Locally tuned model',
      supportsTools: true,
      contextWindow: 123456,
    });

    const listed = await request(app, 'GET', '/api/models');
    const item = listed.body.find((m: any) => m.id === target.id);
    expect(item.hasOverrides).toBe(true);
    expect(item.fallbackEnabled).toBe(false);
  });

  it('patches a custom model capability directly, without recording a catalog override', async () => {
    // Custom models are not catalog-managed, so their capability edits are
    // written straight to the row (no model_overrides entry to survive syncs).
    const reg = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:6100/v1',
      model: 'cap-edit-model',
    });
    expect(reg.status).toBe(201);
    const modelDbId = reg.body.modelDbId as number;

    const { status, body } = await request(app, 'PATCH', `/api/models/${modelDbId}`, {
      supportsVision: true,
      supportsTools: false,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const row = getDb().prepare('SELECT supports_vision, supports_tools FROM models WHERE id = ?')
      .get(modelDbId) as { supports_vision: number; supports_tools: number };
    expect(row).toEqual({ supports_vision: 1, supports_tools: 0 });

    const override = getDb().prepare("SELECT 1 FROM model_overrides WHERE platform = 'custom' AND model_id = 'cap-edit-model'").get();
    expect(override).toBeUndefined();
  });

  it('deletes a catalog model with a tombstone', async () => {
    const target = getDb().prepare(`
      SELECT id, platform, model_id FROM models
       WHERE platform = 'openrouter' AND key_id IS NULL
       ORDER BY id LIMIT 1
    `).get() as { id: number; platform: string; model_id: string };

    const { status, body } = await request(app, 'DELETE', `/api/models/${target.id}`);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, tombstoned: true });

    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(target.id)).toBeUndefined();
    expect(getDb().prepare(`
      SELECT 1 FROM catalog_model_tombstones
       WHERE kind = 'chat' AND platform = ? AND model_id = ?
    `).get(target.platform, target.model_id)).toBeDefined();
  });
});
