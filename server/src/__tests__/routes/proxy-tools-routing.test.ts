import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { encrypt } from '../../lib/crypto.js';

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

const TOOLS_CHAT = {
  messages: [{ role: 'user', content: 'what is the weather in Berlin?' }],
  tools: [WEATHER_TOOL],
};

const TOOLS_RESPONSES = {
  input: 'what is the weather in Berlin?',
  tools: [{
    type: 'function',
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  }],
};

describe('Tools-aware routing', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('flags tool-capable families and leaves the known-bad ones unflagged', () => {
    const db = getDb();
    const flag = (modelId: string) =>
      (db.prepare('SELECT supports_tools FROM models WHERE model_id = ?').get(modelId) as { supports_tools: number } | undefined)?.supports_tools;

    // Verified tool-callers from the live benchmark stay eligible.
    expect(flag('openai/gpt-oss-120b')).toBe(1);
    expect(flag('gemini-2.5-flash')).toBe(1);
    expect(flag('llama-3.3-70b-versatile')).toBe(1);

    // hermes-3 emits tool calls as text — must NOT ride the llama-3 rule.
    const hermes = db.prepare("SELECT supports_tools FROM models WHERE model_id LIKE '%hermes-3%'").all() as { supports_tools: number }[];
    for (const h of hermes) expect(h.supports_tools).toBe(0);

    // gemma must NOT ride the gemini rule.
    const gemma = db.prepare("SELECT supports_tools FROM models WHERE LOWER(model_id) LIKE '%gemma%'").all() as { supports_tools: number }[];
    for (const g of gemma) expect(g.supports_tools).toBe(0);

    // Sanity: the flag splits the catalog (some 1s, some 0s).
    const on = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_tools = 1').get() as { c: number }).c;
    const off = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_tools = 0').get() as { c: number }).c;
    expect(on).toBeGreaterThanOrEqual(5);
    expect(off).toBeGreaterThan(0);
  });

  it('routeRequest skips non-tool models when requireTools is set', () => {
    const db = getDb();
    setRoutingStrategy('priority');
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();

    // One key for google, whose catalog holds both a non-tool model (gemma)
    // and tool-capable ones (gemini). Put gemma at the top of the chain.
    const { encrypted, iv, authTag } = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);

    const gemma = db.prepare("SELECT id FROM models WHERE platform = 'google' AND LOWER(model_id) LIKE '%gemma%' AND enabled = 1").get() as { id: number } | undefined;
    expect(gemma).toBeDefined();
    db.prepare('UPDATE fallback_config SET priority = 0, enabled = 1 WHERE model_db_id = ?').run(gemma!.id);

    // Plain request takes the chain head: gemma.
    const plain = routeRequest(1000);
    expect(plain.modelId.toLowerCase()).toContain('gemma');

    // Tool-bearing request must skip past gemma to a tool-capable model.
    const tooled = routeRequest(1000, undefined, undefined, false, true);
    expect(tooled.modelId.toLowerCase()).not.toContain('gemma');
    const flag = db.prepare('SELECT supports_tools FROM models WHERE id = ?').get(tooled.modelDbId) as { supports_tools: number };
    expect(flag.supports_tools).toBe(1);

    db.prepare('DELETE FROM api_keys').run();
  });

  it('lets a tool request through routing when a tool-capable model is enabled (no 422)', async () => {
    // No provider keys exist, so routing exhausts → 429/503. The point: it is
    // NOT the 422 "no tools model" error, proving the precheck passed.
    const { status, body } = await post(app, '/v1/chat/completions', TOOLS_CHAT, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_tools_model');
  });

  it('rejects a tool request with a clear 422 when no tool-capable model is enabled', async () => {
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_tools = 1').run();

    const { status, body } = await post(app, '/v1/chat/completions', TOOLS_CHAT, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_tools_model');
    expect(body.error.type).toBe('invalid_request_error');

    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_tools = 1').run();
  });

  it('applies the same gate on /v1/responses (Codex path)', async () => {
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_tools = 1').run();

    const { status, body } = await post(app, '/v1/responses', TOOLS_RESPONSES, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_tools_model');

    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_tools = 1').run();
  });

  it('does not apply the tools gate to a plain chat request', async () => {
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_tools = 1').run();
    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_tools_model');
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_tools = 1').run();
  });
});
