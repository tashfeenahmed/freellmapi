import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
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

async function del(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'DELETE',
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

  it('returns the registered singleton for built-in platforms', () => {
    expect(resolveProvider('groq')).toBe(getProvider('groq'));
  });
});

describe('POST /api/keys/custom (#117)', () => {
  let app: Express;
  let customKeyId: number;

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

  it('registers a custom endpoint, model, and fallback entry', async () => {
    const { status, body } = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:11434/v1/',
      model: 'qwen3:4b',
      displayName: 'Local Qwen3 4B',
    });
    expect(status).toBe(201);
    expect(body.platform).toMatch(/^custom:\d+$/);
    expect(body.baseUrl).toBe('http://127.0.0.1:11434/v1'); // trailing slash stripped
    expect(body.model).toBe('qwen3:4b');
    expect(body.displayName).toBe('Local Qwen3 4B');
    expect(body.maskedKey).toBe('****-key');
    customKeyId = body.keyId;
  });

  it('creates a new key when a second model is added', async () => {
    const { status, body } = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:11434/v1/', // same base URL, but we no longer reuse
      model: 'llama3:8b',
      apiKey: 'sk-different',
    });
    expect(status).toBe(201);
    expect(body.platform).toMatch(/^custom:\d+$/);
    expect(body.platform).not.toBe(`custom:${customKeyId}`);

    const db = getDb();
    const keys = db.prepare("SELECT * FROM api_keys WHERE platform LIKE 'custom:%'").all();
    expect(keys.length).toBe(2); // exactly 2 keys now
    const models = db.prepare("SELECT * FROM models WHERE platform LIKE 'custom:%'").all();
    expect(models.length).toBe(2);
  });

  it('surfaces baseUrl in the keys listing', async () => {
    const { body } = await get(app, '/api/keys');
    const custom = body.find((k: any) => k.platform.startsWith('custom:'));
    expect(custom.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('routes a request to the custom model through its base URL', () => {
    const route = routeRequest(1000);
    expect(route.platform).toMatch(/^custom:\d+$/);
    expect((route.provider as any).baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(['qwen3:4b', 'llama3:8b']).toContain(route.modelId);
  });

  it('deleting the custom key cascades ONLY its own models out of the fallback chain', async () => {
    const db = getDb();
    const key = db.prepare("SELECT id, platform FROM api_keys WHERE platform LIKE 'custom:%' LIMIT 1").get() as { id: number; platform: string };
    const customModelIds = (db.prepare("SELECT id FROM models WHERE platform = ?").all(key.platform) as any[]).map(r => r.id);
    expect(customModelIds.length).toBe(1); // 1 key = 1 model now!

    const builtinModels = (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform NOT LIKE 'custom:%'").get() as any).n;

    const { status } = await del(app, `/api/keys/${key.id}`);
    expect(status).toBe(200);

    const fcRemaining = db.prepare(`SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id IN (${customModelIds.join(',')})`).get() as any;
    expect(fcRemaining.n).toBe(0);

    const modelsRemaining = db.prepare(`SELECT COUNT(*) AS n FROM models WHERE platform = ?`).get(key.platform) as any;
    expect(modelsRemaining.n).toBe(0);

    expect((db.prepare(`SELECT COUNT(*) AS n FROM models WHERE platform NOT LIKE 'custom:%'`).get() as any).n).toBe(builtinModels);
  });

  it('deleting a built-in platform key does NOT cascade its catalog models', async () => {
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', 'x', 'x', 'x', 'unknown', 1)
    `).run();
    const groqModels = (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'groq'").get() as { n: number }).n;
    expect(groqModels).toBeGreaterThan(0);

    const { status } = await del(app, `/api/keys/${r.lastInsertRowid}`);
    expect(status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'groq'").get() as { n: number }).n).toBe(groqModels);
  });

  it('re-adding a custom provider after deletion starts a fresh chain entry', async () => {
    const { status, body } = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'mistral:7b',
    });
    expect(status).toBe(201);
    const db = getDb();
    expect((db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform LIKE 'custom:%'").get() as any).n).toBe(2); // One is still left from earlier
    const fc = db.prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(body.modelDbId) as any;
    expect(fc).toBeDefined();
    expect(fc.priority).toBeGreaterThan(0); // Appended to end of chain
  });

  it('surfaces a clear error when the custom endpoint speaks NDJSON, not OpenAI (#189)', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(
        JSON.stringify({ model: 'qwen3:4b', message: { role: 'assistant', content: 'hi' } }, null, 2) +
        '\n' +
        JSON.stringify({ done: true }) +
        '\n',
      );
    });
    await new Promise<void>(resolve => upstream.listen(0, resolve));
    const upstreamPort = (upstream.address() as any).port;

    const reg = await post(app, '/api/keys/custom', {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: 'ndjson-model',
    });
    expect(reg.status).toBe(201);

    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
      body: JSON.stringify({ model: 'ndjson-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.json().catch(() => null);
    server.close();

    upstream.close();
    expect(res.status).toBe(502);
    expect(JSON.stringify(body)).toMatch(/not OpenAI-compatible/);
    expect(JSON.stringify(body)).not.toMatch(/Unexpected non-whitespace/);
  });
});
