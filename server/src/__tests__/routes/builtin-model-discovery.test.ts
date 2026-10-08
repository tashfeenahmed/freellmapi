import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { resetBuiltinDiscoveryThrottle } from '../../services/builtin-model-discovery.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// #1348: the dashboard's Fetch models action, extended from custom endpoints
// to built-in providers the signed catalog carries no models for.

const DISCOVER = '/api/keys/custom/discover-models';
const REGISTER = '/api/keys/discovered-models';
const realFetch = globalThis.fetch;
let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown, auth = true) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data as any };
}

const post = (app: Express, path: string, body: unknown) => request(app, 'POST', path, body);

function stubProvider(ids: string[]) {
  const mock = vi.fn(async () => new Response(
    JSON.stringify({ object: 'list', data: ids.map(id => ({ id, owned_by: 'upstream' })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  globalThis.fetch = mock as any;
  return mock;
}

async function addKey(app: Express, platform: string, key = 'sk-test'): Promise<{ id: number; notice?: string }> {
  const { status, body } = await post(app, '/api/keys', { platform, key });
  expect(status).toBe(201);
  return body;
}

function modelRows(platform: string) {
  return getDb().prepare('SELECT model_id, source FROM models WHERE platform = ? ORDER BY model_id').all(platform) as
    Array<{ model_id: string; source: string }>;
}

describe('built-in provider model discovery routes (#1348)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // The key-save trigger is exercised in its own test; keep the others to
    // the dashboard action so a background pass cannot race them.
    process.env.BUILTIN_MODEL_DISCOVERY = 'manual';
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    resetBuiltinDiscoveryThrottle();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    delete process.env.BUILTIN_MODEL_DISCOVERY;
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('lists an eligible built-in provider\'s models through its registered base URL', async () => {
    const key = await addKey(app, 'siliconflow', 'sk-silicon');
    getDb().prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, source)
                     VALUES ('siliconflow', 'already', 'already', 50, 50, 'Medium', 'discovered')`).run();
    const mock = stubProvider(['already', 'deepseek-ai/DeepSeek-V3']);

    const { status, body } = await post(app, DISCOVER, { keyId: key.id });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      platform: 'siliconflow',
      baseUrl: 'https://api.siliconflow.com/v1',
      keyId: key.id,
      total: 2,
      registeredCount: 1,
    });
    expect(body.models.map((m: any) => [m.id, m.registered])).toEqual([['already', true], ['deepseek-ai/DeepSeek-V3', false]]);
    expect(String(mock.mock.calls[0]![0])).toBe('https://api.siliconflow.com/v1/models');
    expect(((mock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer sk-silicon');
  });

  it('refuses a catalog-managed built-in provider without calling it', async () => {
    const key = await addKey(app, 'groq');
    const mock = stubProvider(['llama']);
    const { status, body } = await post(app, DISCOVER, { keyId: key.id });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/come from the catalog/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('refuses a Premium-gated provider (catalog rows not yet free) without calling it', async () => {
    const key = await addKey(app, 'radeon');
    const mock = stubProvider(['x']);
    const { status } = await post(app, DISCOVER, { keyId: key.id });
    expect(status).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });

  it('registers picked chat models as discovered rows and reports non-chat ids', async () => {
    const key = await addKey(app, 'longcat');
    const { status, body } = await post(app, REGISTER, {
      keyId: key.id,
      models: ['LongCat-Flash-Chat', 'LongCat-Flash-Chat', 'text-embedding-v1'],
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ platform: 'longcat', created: 1, registered: ['LongCat-Flash-Chat'], skippedNonChat: ['text-embedding-v1'] });
    expect(modelRows('longcat')).toEqual([{ model_id: 'LongCat-Flash-Chat', source: 'discovered' }]);

    // Shows up in the model list as discovered, not catalog.
    const list = await request(app, 'GET', '/api/models');
    expect(list.body.find((m: any) => m.platform === 'longcat')).toMatchObject({ source: 'discovered' });
  });

  it('refuses registration for ineligible and custom keys', async () => {
    const groq = await addKey(app, 'groq');
    expect((await post(app, REGISTER, { keyId: groq.id, models: ['x'] })).status).toBe(400);
    const custom = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('custom', '', 'e', 'i', 't', 'healthy', 1, 'http://127.0.0.1:9/v1')
    `).run();
    expect((await post(app, REGISTER, { keyId: Number(custom.lastInsertRowid), models: ['x'] })).status).toBe(400);
    expect(modelRows('groq').some(r => r.model_id === 'x')).toBe(false);
  });

  it('flags discoverable key rows for the dashboard', async () => {
    await addKey(app, 'siliconflow');
    await addKey(app, 'groq');
    const { body } = await request(app, 'GET', '/api/keys');
    const byPlatform = Object.fromEntries(body.map((k: any) => [k.platform, k.modelDiscovery]));
    expect(byPlatform).toMatchObject({ siliconflow: true, groq: false });
  });

  it('on key save, explains the discovery instead of the Premium advice and fetches in the background', async () => {
    process.env.BUILTIN_MODEL_DISCOVERY = 'auto';
    const mock = stubProvider(['LongCat-Flash-Chat']);
    const key = await addKey(app, 'longcat');
    expect(key.notice).toMatch(/being fetched from longcat's own model list/);
    expect(key.notice).not.toMatch(/Premium/);
    await vi.waitFor(() => expect(modelRows('longcat')).toEqual([{ model_id: 'LongCat-Flash-Chat', source: 'discovered' }]));
    expect(String(mock.mock.calls[0]![0])).toBe('https://api.longcat.chat/openai/v1/models');
  });

  it('keeps the catalog notice for providers discovery does not cover', async () => {
    const key = await addKey(app, 'routeway');
    expect(key.notice).toMatch(/catalog/);
    expect(key.notice).not.toMatch(/being fetched/);
  });
});
