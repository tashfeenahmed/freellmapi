import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
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

describe('Custom Provider Endpoints', () => {
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
  
    beforeAll(() => {
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      initDb(':memory:');
      // Isolate tests to use global fallback_config
      getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
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

  it('does not overwrite an existing endpoint key when a later submit omits apiKey', async () => {
    const first = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:7777/v1',
      model: 'secret-model-a',
      apiKey: 'keep-this-key',
    });
    expect(first.status).toBe(201);

    const second = await post(app, '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:7777/v1',
      model: 'secret-model-b',
    });
    expect(second.status).toBe(201);

    const key = getDb().prepare(`
      SELECT id, encrypted_key, iv, auth_tag
        FROM api_keys
       WHERE platform = 'custom' AND base_url = 'http://127.0.0.1:7777/v1'
    `).get() as { id: number; encrypted_key: string; iv: string; auth_tag: string };
    expect(decrypt(key.encrypted_key, key.iv, key.auth_tag)).toBe('keep-this-key');

    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom' AND key_id = ?)").run(key.id);
    db.prepare("DELETE FROM models WHERE platform = 'custom' AND key_id = ?").run(key.id);
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(key.id);
  });

  it('routes a request to the custom model through its base URL', () => {
    // The seeded built-in models have no keys, so the only routable model is
    // the custom one we registered above.
    const route = routeRequest(1000);
    expect(route.platform).toBe('custom');
    expect((route.provider as any).baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(['qwen3:4b', 'llama3:8b']).toContain(route.modelId);
  });

  it('deleting the custom key cascades its models out of the fallback chain (#189)', async () => {
    const db = getDb();
    const key = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom'").get() as { id: number };
    const customModelIds = (db.prepare("SELECT id FROM models WHERE platform = 'custom'").all() as { id: number }[]).map(r => r.id);
    expect(customModelIds.length).toBe(2); // qwen3:4b + llama3:8b from earlier tests
    const builtinModels = (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform != 'custom'").get() as { n: number }).n;

    const { status } = await del(app, `/api/keys/${key.id}`);
    expect(status).toBe(200);

    // Custom models and their fallback entries are gone — not orphaned.
    expect((db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'custom'").get() as { n: number }).n).toBe(0);
    const placeholders = customModelIds.map(() => '?').join(',');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id IN (${placeholders})`).get(...customModelIds) as { n: number }).n).toBe(0);
    // Built-in catalog rows are untouched.
    expect((db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform != 'custom'").get() as { n: number }).n).toBe(builtinModels);
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
    expect((db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number }).n).toBe(1);
    const fc = db.prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(body.modelDbId);
    expect(fc).toBeDefined();
  });

  it('surfaces a clear error when the custom endpoint speaks NDJSON, not OpenAI (#189)', async () => {
    // Real upstream that answers like Ollama's native /api/chat: HTTP 200,
    // newline-delimited JSON documents — res.json() in the provider would die
    // with "Unexpected non-whitespace character after JSON at position …".
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

    // Point the custom provider at the NDJSON upstream and pin its model.
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

  // #212: adding a second custom provider used to overwrite the first one's
  // endpoint — one shared key row held THE base_url. Now each endpoint gets
  // its own key row and models bind to their endpoint via models.key_id.
  describe('multiple custom providers (#212)', () => {
    beforeAll(async () => {
      // Sweep custom state left by the tests above for a deterministic start.
      const db = getDb();
      db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
      db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
      db.prepare('DELETE FROM api_keys').run();
      db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();

      const a = await post(app, '/api/keys/custom', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3:8b', label: 'Ollama box' });
      const b = await post(app, '/api/keys/custom', { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen3:4b', label: 'LM Studio' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });

    it('keeps a separate key row per endpoint instead of overwriting', () => {
      const db = getDb();
      const keys = db.prepare("SELECT id, base_url FROM api_keys WHERE platform = 'custom' ORDER BY id").all() as any[];
      expect(keys.length).toBe(2);
      expect(keys.map(k => k.base_url).sort()).toEqual(['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'].sort());
    });

    it('binds each model to its own endpoint key', () => {
      const db = getDb();
      const llama = db.prepare("SELECT m.key_id, k.base_url FROM models m JOIN api_keys k ON k.id = m.key_id WHERE m.platform = 'custom' AND m.model_id = 'llama3:8b'").get() as any;
      const qwen = db.prepare("SELECT m.key_id, k.base_url FROM models m JOIN api_keys k ON k.id = m.key_id WHERE m.platform = 'custom' AND m.model_id = 'qwen3:4b'").get() as any;
      expect(llama.base_url).toBe('http://127.0.0.1:11434/v1');
      expect(qwen.base_url).toBe('http://127.0.0.1:1234/v1');
    });

    it('routes each model through ITS endpoint, never the other one', () => {
      const db = getDb();
      const llamaId = (db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'llama3:8b'").get() as any).id;
      const qwenId = (db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'qwen3:4b'").get() as any).id;

      const llamaRoute = routeRequest(1000, undefined, llamaId);
      expect(llamaRoute.modelId).toBe('llama3:8b');
      expect((llamaRoute.provider as any).baseUrl).toBe('http://127.0.0.1:11434/v1');

      const qwenRoute = routeRequest(1000, undefined, qwenId);
      expect(qwenRoute.modelId).toBe('qwen3:4b');
      expect((qwenRoute.provider as any).baseUrl).toBe('http://127.0.0.1:1234/v1');
    });

    it('re-submitting an existing endpoint updates it instead of adding a third', async () => {
      const { status } = await post(app, '/api/keys/custom', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'mistral:7b', label: 'Ollama box renamed' });
      expect(status).toBe(201);
      const db = getDb();
      expect((db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as any).n).toBe(2);
      const key = db.prepare("SELECT label FROM api_keys WHERE platform = 'custom' AND base_url = 'http://127.0.0.1:11434/v1'").get() as any;
      expect(key.label).toBe('Ollama box renamed');
    });

    it('deleting one endpoint removes only ITS models from catalog and chain', async () => {
      const db = getDb();
      const ollamaKey = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = 'http://127.0.0.1:11434/v1'").get() as any;

      const { status } = await del(app, `/api/keys/${ollamaKey.id}`);
      expect(status).toBe(200);

      const remainingModels = (db.prepare("SELECT model_id FROM models WHERE platform = 'custom'").all() as any[]).map(r => r.model_id);
      expect(remainingModels).toEqual(['qwen3:4b']); // llama3:8b + mistral:7b cascaded with their key
      const keys = db.prepare("SELECT base_url FROM api_keys WHERE platform = 'custom'").all() as any[];
      expect(keys.length).toBe(1);
      expect(keys[0].base_url).toBe('http://127.0.0.1:1234/v1');
    });
  });

  // #281: one submit can bind several model ids to a single endpoint, instead
  // of forcing one POST per model.
  describe('multiple models per endpoint (#281)', () => {
    beforeAll(() => {
      const db = getDb();
      db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
      db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
      db.prepare("DELETE FROM api_keys WHERE platform = 'custom'").run();
    });

    it('registers every model in the models array against one endpoint key', async () => {
      const { status, body } = await post(app, '/api/keys/custom', {
        baseUrl: 'http://127.0.0.1:9999/v1',
        models: ['gemma3:1b', { model: 'phi4:14b', displayName: 'Phi 4' }],
        label: 'Multi box',
      });
      expect(status).toBe(201);
      // Back-compat fields echo the first model; `models` carries the full set.
      expect(body.model).toBe('gemma3:1b');
      expect(body.models).toHaveLength(2);
      expect(body.models.map((m: any) => m.model).sort()).toEqual(['gemma3:1b', 'phi4:14b']);
      expect(body.models.find((m: any) => m.model === 'phi4:14b').displayName).toBe('Phi 4');

      const db = getDb();
      const keys = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = 'http://127.0.0.1:9999/v1'").all();
      expect(keys.length).toBe(1); // one endpoint, one key
      const models = db.prepare("SELECT model_id FROM models WHERE platform = 'custom' AND key_id = ?").all((keys[0] as any).id) as any[];
      expect(models.map(m => m.model_id).sort()).toEqual(['gemma3:1b', 'phi4:14b']);
      for (const m of body.models) {
        expect(db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(m.modelDbId)).toBeDefined();
      }
    });

    it('dedupes repeated ids and ignores blanks', async () => {
      const { status, body } = await post(app, '/api/keys/custom', {
        baseUrl: 'http://127.0.0.1:9999/v1',
        models: ['dupe:1', 'dupe:1', '   '],
      });
      expect(status).toBe(201);
      expect(body.models).toHaveLength(1);
      expect(body.models[0].model).toBe('dupe:1');
    });

    it('rejects a submit with neither model nor models', async () => {
      const { status } = await post(app, '/api/keys/custom', { baseUrl: 'http://127.0.0.1:9999/v1' });
      expect(status).toBe(400);
    });
  });
});
