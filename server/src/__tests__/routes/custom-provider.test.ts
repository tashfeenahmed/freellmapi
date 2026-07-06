import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest } from '../../services/router.js';
import { resolveProvider, getProvider } from '../../providers/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function post(app: Express, path: string, body: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function get(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('resolveProvider (#117)', () => {
  it('builds a custom provider bound to the supplied base URL', () => {
    const p = resolveProvider('custom', 'http://127.0.0.1:8080/v1');
    expect(p).toBeDefined();
    expect(p!.platform).toBe('custom');
    expect((p as any).baseUrl).toBe('http://127.0.0.1:8080/v1');
  });

  it('returns undefined for a custom provider with no base URL', () => {
    expect(resolveProvider('custom', null)).toBeUndefined();
    expect(resolveProvider('custom', '   ')).toBeUndefined();
  });

  it('refuses a custom provider bound to a private remote address', () => {
    expect(resolveProvider('custom', 'http://192.168.1.20:8080/v1')).toBeUndefined();
  });

  it('returns the registered singleton for built-in platforms', () => {
    expect(resolveProvider('groq')).toBe(getProvider('groq'));
  });
});

describe('POST /api/keys/custom (#117)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('rejects an invalid base URL', async () => {
    const { status } = await post(app, '/api/keys/custom', { baseUrl: 'not-a-url', model: 'm' });
    expect(status).toBe(400);
  });

  it('rejects private-network custom endpoints by default', async () => {
    const { status, body } = await post(app, '/api/keys/custom', {
      baseUrl: 'http://192.168.1.20:11434/v1',
      model: 'm',
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/private|loopback|link-local|unspecified/i);
  });

  it('rejects non-http custom endpoint schemes', async () => {
    const { status, body } = await post(app, '/api/keys/custom', {
      baseUrl: 'file:///etc/passwd',
      model: 'm',
    });
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/http or https/i);
  });

  it('allows remote HTTPS custom endpoints only when explicitly enabled', async () => {
    const previous = process.env.ALLOW_REMOTE_CUSTOM_PROVIDERS;
    process.env.ALLOW_REMOTE_CUSTOM_PROVIDERS = 'true';
    try {
      const { status, body } = await post(app, '/api/keys/custom', {
        baseUrl: 'https://llm.example.com/v1/',
        model: 'remote-model',
      });
      expect(status).toBe(201);
      expect(body.baseUrl).toBe('https://llm.example.com/v1');
    } finally {
      const db = getDb();
      const model = db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'remote-model'").get() as { id: number } | undefined;
      if (model) {
        db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(model.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(model.id);
      }
      db.prepare("DELETE FROM api_keys WHERE platform = 'custom' AND base_url = 'https://llm.example.com/v1'").run();
      if (previous === undefined) {
        delete process.env.ALLOW_REMOTE_CUSTOM_PROVIDERS;
      } else {
        process.env.ALLOW_REMOTE_CUSTOM_PROVIDERS = previous;
      }
    }
  });

  it('registers a custom endpoint, model, and fallback entry', async () => {
    const { status, body } = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:11434/v1/',
      model: 'qwen3:4b',
      displayName: 'Local Qwen3 4B',
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('custom');
    expect(body.baseUrl).toBe('http://127.0.0.1:11434/v1'); // trailing slash trimmed
    expect(body.model).toBe('qwen3:4b');

    const db = getDb();
    const key = db.prepare("SELECT * FROM api_keys WHERE platform = 'custom'").get() as any;
    expect(key.base_url).toBe('http://127.0.0.1:11434/v1');
    const model = db.prepare("SELECT * FROM models WHERE platform = 'custom' AND model_id = 'qwen3:4b'").get() as any;
    expect(model).toBeDefined();
    const fc = db.prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(model.id);
    expect(fc).toBeDefined();
  });

  it('reuses the single custom key when a second model is added', async () => {
    await post(app, '/api/keys/custom', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3:8b' });
    const db = getDb();
    const keys = db.prepare("SELECT * FROM api_keys WHERE platform = 'custom'").all();
    expect(keys.length).toBe(1); // not a second key
    const models = db.prepare("SELECT * FROM models WHERE platform = 'custom'").all();
    expect(models.length).toBe(2);
  });

  it('surfaces baseUrl in the keys listing', async () => {
    const { body } = await get(app, '/api/keys');
    const custom = body.find((k: any) => k.platform === 'custom');
    expect(custom.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('routes a request to the custom model through its base URL', () => {
    // The seeded built-in models have no keys, so the only routable model is
    // the custom one we registered above.
    const route = routeRequest(1000);
    expect(route.platform).toBe('custom');
    expect((route.provider as any).baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(['qwen3:4b', 'llama3:8b']).toContain(route.modelId);
  });
});
