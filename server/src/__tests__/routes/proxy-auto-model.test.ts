import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('Virtual "auto" model', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    // Unification is always on: /v1/models lists one entry per logical model
    // (owned_by = freellmapi, id = canonical slug) that aggregates availability
    // across its providers. This suite asserts the availability tagging (#242)
    // and context-window advertising (#282) under that unified shape.
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_auto_model_test',
      label: 'auto-model',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists "auto" as the first /v1/models entry', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data[0]).toMatchObject({
      id: 'auto',
      object: 'model',
      owned_by: 'freellmapi',
    });
    // Real catalog models still follow.
    expect(body.data.length).toBeGreaterThan(1);
  });

  it('fails when authentication is missing or wrong', async () => {
    const { status: status1 } = await request(app, 'GET', '/v1/models');
    expect(status1).toBe(401);

    const { status: status2 } = await request(app, 'GET', '/v1/models', undefined, { Authorization: 'Bearer wrongkey' });
    expect(status2).toBe(401);
  });

  it('returns unique model ids from /v1/models', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);

    const ids = body.data.map((model: { id: string }) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // #242: default returns the whole catalog, each entry annotated with whether
  // it's currently usable (connected) and, if not, why.
  it('returns the whole catalog by default, each tagged with availability (#242)', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    expect(body.data[0]).toMatchObject({ id: 'auto', available: true, unavailable_reason: null });

    const models = body.data.filter((m: any) => m.id !== 'auto');
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.available).toBe('boolean');
      if (m.available) expect(m.unavailable_reason).toBeNull();
      else expect(['no_key', 'disabled']).toContain(m.unavailable_reason);
    }
    // Every logical model is owned_by freellmapi (unified). Only a groq key is
    // seeded, so at least one model is available (served by groq) and at least
    // one model with no provider key is listed but unavailable.
    expect(models.every((m: any) => m.owned_by === 'freellmapi')).toBe(true);
    expect(models.some((m: any) => m.available)).toBe(true);
    expect(models.some((m: any) => !m.available && m.unavailable_reason === 'no_key')).toBe(true);
  });

  it('?available=true narrows to only connected models (#242)', async () => {
    const filtered = await request(app, 'GET', '/v1/models?available=true', undefined, authHeaders());
    expect(filtered.status).toBe(200);
    const filteredModels = filtered.body.data.filter((m: any) => m.id !== 'auto');
    expect(filteredModels.length).toBeGreaterThan(0);
    expect(filteredModels.every((m: any) => m.available === true)).toBe(true);

    // The unfiltered list is strictly larger — the keyless models reappear.
    const all = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    const allModels = all.body.data.filter((m: any) => m.id !== 'auto');
    expect(allModels.length).toBeGreaterThan(filteredModels.length);
  });

  it('marks a fully-disabled model with unavailable_reason "disabled" (#242)', async () => {
    const db = getDb();
    const row = db.prepare("SELECT display_name FROM models WHERE platform='groq' AND enabled=1 LIMIT 1").get() as { display_name: string } | undefined;
    expect(row).toBeDefined();
    // A unified model stays available while ANY of its providers is enabled, so
    // disable every provider that serves this logical model (same display_name).
    db.prepare('UPDATE models SET enabled=0 WHERE display_name=?').run(row!.display_name);
    try {
      const { body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
      const disabled = body.data.filter((m: any) => m.id !== 'auto' && m.unavailable_reason === 'disabled');
      expect(disabled.length).toBeGreaterThan(0);
      expect(disabled.every((m: any) => m.available === false)).toBe(true);
    } finally {
      db.prepare('UPDATE models SET enabled=1 WHERE display_name=?').run(row!.display_name);
    }
  });

  // #282: clients read a model's context window from /v1/models; advertise it
  // under both `context_window` and the OpenRouter-convention `context_length`,
  // and give "auto" the largest window among connected models so clients don't
  // fall back to a conservative ~16k default and truncate long inputs.
  it('advertises context_length and a non-null auto context window (#282)', async () => {
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);

    const auto = body.data.find((m: any) => m.id === 'auto');
    expect(auto.context_window).toBe(auto.context_length);
    expect(typeof auto.context_window).toBe('number');
    expect(auto.context_window).toBeGreaterThan(0);

    // Every real model mirrors context_window into context_length.
    const connected = body.data.filter((m: any) => m.id !== 'auto' && m.available);
    expect(connected.length).toBeGreaterThan(0);
    for (const m of connected) {
      expect(m.context_length).toBe(m.context_window);
    }

    // Auto's advertised ceiling is the max window among connected models.
    const maxConnected = Math.max(
      ...connected.filter((m: any) => m.context_window != null).map((m: any) => m.context_window),
    );
    expect(auto.context_window).toBe(maxConnected);
  });

  it('treats model:"auto" as auto-route instead of a 400', async () => {
    const origFetch = global.fetch;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-auto',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'routed via auto' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('routed via auto');
  });

  it('still rejects an unknown model with model_not_found', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
  });
});
