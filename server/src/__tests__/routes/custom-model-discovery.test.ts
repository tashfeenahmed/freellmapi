import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { setCooldown, isOnCooldown } from '../../services/ratelimit.js';
import { PROBE_MAX_TOKENS } from '../../services/model-discovery.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// #488: a relay's model list changes weekly, so the endpoint's own /models
// route is the source of truth for what the USER's key can reach. This is
// discovery on the operator's OWN endpoint with the operator's OWN key — it
// never touches the published provider catalog.

const ENDPOINT = 'http://127.0.0.1:18099/v1';
const DISCOVER = '/api/keys/custom/discover-models';
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

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubRelay(payload: unknown, status = 200) {
  const mock = vi.fn(async () => jsonResponse(payload, status));
  globalThis.fetch = mock as any;
  return mock;
}

function customKeyIds(baseUrl = ENDPOINT): number[] {
  return (getDb().prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ? ORDER BY id")
    .all(baseUrl) as { id: number }[]).map(r => r.id);
}

function chatModel(modelId: string) {
  return getDb().prepare(`
    SELECT id, key_id, intelligence_rank, speed_rank, size_label, source
      FROM models WHERE platform = 'custom' AND model_id = ?
  `).get(modelId) as
    { id: number; key_id: number | null; intelligence_rank: number; speed_rank: number; size_label: string; source: string } | undefined;
}

describe('custom endpoint model discovery (#488)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('requires dashboard auth', async () => {
    stubRelay({ data: [{ id: 'relay-a' }] });
    const { status } = await request(app, 'POST', DISCOVER, { baseUrl: ENDPOINT }, false);
    expect(status).toBe(401);
  });

  it('lists the endpoint models and flags the ones already registered', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const mock = stubRelay({
      object: 'list',
      data: [{ id: 'relay-a', owned_by: 'acme' }, { id: 'relay-b', owned_by: 'acme' }],
    });

    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT });

    expect(status).toBe(200);
    expect(body.baseUrl).toBe(ENDPOINT);
    expect(body.keyId).toBe(customKeyIds()[0]);
    expect(body.models).toEqual([
      { id: 'relay-a', ownedBy: 'acme', registered: true },
      { id: 'relay-b', ownedBy: 'acme', registered: false },
    ]);
    expect(body.registeredCount).toBe(1);

    // Reuses the key-validation fetch: GET ${baseUrl}/models with the stored bearer.
    expect(String(mock.mock.calls[0]![0])).toBe(`${ENDPOINT}/models`);
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer relay-secret');
  });

  it('accepts a key id instead of a base url', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;
    stubRelay({ data: [{ id: 'relay-b' }] });

    const { status, body } = await post(app, DISCOVER, { keyId });
    expect(status).toBe(200);
    expect(body.baseUrl).toBe(ENDPOINT);
    expect(body.models.map((m: any) => m.id)).toEqual(['relay-b']);
  });

  it('discovers against an endpoint that is not registered yet', async () => {
    stubRelay({ data: [{ id: 'relay-b' }] });
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'fresh-secret' });
    expect(status).toBe(200);
    expect(body.keyId).toBeNull();
    expect(body.models).toEqual([{ id: 'relay-b', ownedBy: null, registered: false }]);
    expect(customKeyIds()).toHaveLength(0); // discovery never writes
  });

  it('parses a non-standard relay envelope', async () => {
    stubRelay({ models: [{ name: 'qwen3:4b' }, { name: 'llama3:8b' }] });
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(200);
    expect(body.models.map((m: any) => m.id)).toEqual(['llama3:8b', 'qwen3:4b']);
  });

  it('reports an unreachable endpoint as 502', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as any;
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(502);
    expect(String(body.error.message)).toMatch(/could not reach/i);
  });

  it('passes an upstream 401 through as 401', async () => {
    stubRelay({ error: { message: 'invalid api key' } }, 401);
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'bad' });
    expect(status).toBe(401);
    expect(String(body.error.message)).toMatch(/invalid api key/i);
  });

  it('rejects a catalog body that blows past the size cap', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"data":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) },
    })) as any;
    const { status } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(502);
  });

  it('reports a relay that answers with no model list', async () => {
    stubRelay({ hello: 'world' });
    const { status, body } = await post(app, DISCOVER, { baseUrl: ENDPOINT, apiKey: 'k' });
    expect(status).toBe(502);
    expect(String(body.error.message)).toMatch(/model list/i);
  });

  it('rejects a request with neither baseUrl nor keyId', async () => {
    const { status } = await post(app, DISCOVER, {});
    expect(status).toBe(400);
  });
});

describe('bulk registration of discovered models (#488)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registers a selection against the endpoint binding and reports what was new', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'first-secret' });
    // A second credential for the same endpoint (#640/#619): models bind to the
    // endpoint, and the pool rotates underneath that binding.
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'second-secret' });
    const [firstKeyId, secondKeyId] = customKeyIds();

    const { status, body } = await post(app, '/api/keys/custom', {
      keyId: secondKeyId,
      models: ['relay-a', 'relay-b', 'relay-c'],
    });

    expect(status).toBe(201);
    expect(body.keyId).toBe(secondKeyId);
    expect(body.baseUrl).toBe(ENDPOINT);
    expect(body.models.map((m: any) => [m.model, m.created])).toEqual([
      ['relay-a', false], ['relay-b', true], ['relay-c', true],
    ]);
    expect(body.created).toBe(2);
    expect(body.alreadyRegistered).toBe(1);

    // relay-a keeps its original binding; the new ones bind to the submitted key.
    expect(chatModel('relay-a')!.key_id).toBe(firstKeyId);
    expect(chatModel('relay-b')!.key_id).toBe(secondKeyId);
    expect(chatModel('relay-c')!.key_id).toBe(secondKeyId);
    expect(chatModel('relay-b')!.source).toBe('user');
  });

  it('does not duplicate a model that is already registered', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'first-secret' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, models: ['relay-a', 'relay-a', 'relay-b'] });

    const rows = getDb().prepare("SELECT model_id FROM models WHERE platform = 'custom' ORDER BY model_id")
      .all() as { model_id: string }[];
    expect(rows.map(r => r.model_id)).toEqual(['relay-a', 'relay-b']);
  });

  it('rejects a keyId that is not a custom endpoint', async () => {
    const { body: added } = await post(app, '/api/keys', { platform: 'groq', key: 'gsk_test' });
    const { status } = await post(app, '/api/keys/custom', { keyId: added.id, models: ['relay-a'] });
    expect(status).toBe(400);
  });

  it('rejects a baseUrl that contradicts the submitted keyId', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'first-secret' });
    const { status } = await post(app, '/api/keys/custom', {
      keyId: customKeyIds()[0], baseUrl: 'http://127.0.0.1:18098/v1', models: ['relay-b'],
    });
    expect(status).toBe(400);
  });
});

describe('median seeding for custom models (#488)', () => {
  let app: Express;

  function seedCatalog() {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    const insert = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                          rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
      VALUES ('groq', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', 1)
    `);
    const rows: Array<[string, number, number]> = [
      ['Small', 40, 4], ['Medium', 20, 3], ['Large', 10, 2], ['Frontier', 2, 1], ['Frontier', 1, 5],
    ];
    rows.forEach(([label, intel, speed], i) => insert.run(`cat-${i}`, `Cat ${i}`, intel, speed, label));
  }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    seedCatalog();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('seeds a bulk-registered custom model at the catalog median', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, models: ['relay-a', 'relay-b'], apiKey: 'k' });
    for (const id of ['relay-a', 'relay-b']) {
      const row = chatModel(id)!;
      expect(row.size_label).toBe('Large');
      expect(row.intelligence_rank).toBe(10);
      expect(row.speed_rank).toBe(3);
    }
  });

  it('seeds a singly-added custom model the same way', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-solo', apiKey: 'k' });
    const row = chatModel('relay-solo')!;
    expect(row.size_label).toBe('Large');
    expect(row.intelligence_rank).toBe(10);
    expect(row.speed_rank).toBe(3);
  });

  it('never overwrites ranks the operator has since tuned', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'k' });
    const modelDbId = chatModel('relay-a')!.id;
    getDb().prepare('UPDATE models SET intelligence_rank = 1, speed_rank = 1, size_label = ? WHERE id = ?')
      .run('Frontier', modelDbId);

    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, models: ['relay-a', 'relay-b'], apiKey: 'k' });

    const kept = chatModel('relay-a')!;
    expect([kept.intelligence_rank, kept.speed_rank, kept.size_label]).toEqual([1, 1, 'Frontier']);
    expect(chatModel('relay-b')!.size_label).toBe('Large');
  });

  it('probe fires one chat request at the REGISTERED model and records a success sample (#685 follow-up)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;
    setCooldown('custom', 'relay-a', keyId, 60_000);

    // A registered model means the probe already knows what to hit: one POST
    // /chat/completions, no discovery GET. Were discovery consulted, it would
    // put 'aaa-first' ahead of the registered 'relay-a'.
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'aaa-first' }, { id: 'relay-a' }] });
      }
      return jsonResponse({
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        created: 0,
        model: 'relay-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    expect(status).toBe(200);
    expect(body.modelId).toBe('relay-a');
    expect(typeof body.latencyMs).toBe('number');

    // One round trip: the registered model id makes the discovery GET pointless.
    expect(mock.mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(0);
    const chatCall = mock.mock.calls.find(([u]) => String(u).endsWith('/chat/completions'))!;
    expect(chatCall).toBeTruthy();
    expect((chatCall[1] as RequestInit).method).toBe('POST');
    const chatBody = JSON.parse(String((chatCall[1] as RequestInit).body)) as any;
    expect(chatBody.max_tokens).toBe(PROBE_MAX_TOKENS);
    expect(chatBody.model).toBe('relay-a');

    // The successful probe wrote a request row the stats cache can fold in,
    // token counts included.
    const row = getDb().prepare(
      "SELECT status, input_tokens, output_tokens, latency_ms FROM requests WHERE platform = 'custom' AND model_id = 'relay-a' ORDER BY id DESC LIMIT 1",
    ).get() as { status: string; input_tokens: number; output_tokens: number; latency_ms: number };
    expect(row.status).toBe('success');
    expect(row.input_tokens).toBe(3);
    expect(row.output_tokens).toBe(1);

    // A real completion outranks a health ping: the cooldown is lifted.
    expect(isOnCooldown('custom', 'relay-a', keyId)).toBe(false);
  });

  // #903: relays that enforce `max_tokens > 2` rejected the old probe with a
  // 400 before it could measure anything, so the endpoint looked broken when
  // only the probe's own cap was wrong.
  it('probe clears the max_tokens floor relays enforce (#903)', async () => {
    expect(PROBE_MAX_TOKENS).toBeGreaterThan(2);

    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;

    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { max_tokens?: number } : {};
      // Mirror the upstream that reported #903.
      if ((body.max_tokens ?? 0) <= 2) {
        return jsonResponse({ error: { message: 'max_tokens must be greater than 2' } }, 400);
      }
      return jsonResponse({
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        created: 0,
        model: 'relay-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });
    expect(status).toBe(200);
    expect(body.modelId).toBe('relay-a');
  });

  it('probe falls back to discovery when the endpoint has no registered model (#685 follow-up)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;
    getDb().prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    getDb().prepare("DELETE FROM models WHERE platform = 'custom'").run();

    const mock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'relay-b', owned_by: 'acme' }] });
      }
      return jsonResponse({
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        created: 0,
        model: 'relay-b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    expect(status).toBe(200);
    expect(body.modelId).toBe('relay-b');
    expect(mock.mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(1);
    const chatBody = JSON.parse(String((mock.mock.calls.find(([u]) => String(u).endsWith('/chat/completions'))![1] as RequestInit).body)) as any;
    expect(chatBody.model).toBe('relay-b');
  });

  it('probe failure surfaces the reason, records no sample and keeps the cooldown (#685 follow-up)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;
    setCooldown('custom', 'relay-a', keyId, 60_000);

    const mock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'relay-a' }] });
      }
      return jsonResponse({ error: { message: 'upstream exploded' } }, 502);
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    expect(status).toBe(502);
    expect(String(body.error.message)).toContain('upstream exploded');
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM requests WHERE platform = 'custom'").get() as { c: number }).c;
    expect(count).toBe(0);
    expect(isOnCooldown('custom', 'relay-a', keyId)).toBe(true);
  });

  it('probe reports reasoning=true when the reasoning probe answer is correct (#874)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;

    // Ping (max_tokens 1) → reasoning probe (max_tokens 16) → tool probe (tools).
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'relay-a' }] });
      }
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as any;
      if (reqBody.max_tokens === 16) {
        return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
          choices: [{ index: 0, message: { role: 'assistant', content: '63' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      }
      if (reqBody.tools) {
        return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } });
      }
      return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    expect(status).toBe(200);
    expect(body.modelId).toBe('relay-a');
    expect(body.reasoning).toBe(true);
    expect(body.toolCalls).toBe(false);
  });

  it('probe reports toolCalls and writes supports_tools back to the model row (#874)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;
    // Start from an explicit "no tool support" flag so the write-back is provable.
    getDb().prepare("UPDATE models SET supports_tools = 0 WHERE platform = 'custom' AND model_id = 'relay-a'").run();

    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'relay-a' }] });
      }
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as any;
      if (reqBody.tools) {
        return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } });
      }
      if (reqBody.max_tokens === 16) {
        return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
          choices: [{ index: 0, message: { role: 'assistant', content: 'wrong answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      }
      return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    expect(status).toBe(200);
    expect(body.toolCalls).toBe(true);
    const row = getDb().prepare("SELECT supports_tools FROM models WHERE platform = 'custom' AND model_id = 'relay-a'").get() as { supports_tools: number };
    expect(row.supports_tools).toBe(1);
  });

  it('probe without tool-call evidence leaves supports_tools untouched (#874)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;
    getDb().prepare("UPDATE models SET supports_tools = 0 WHERE platform = 'custom' AND model_id = 'relay-a'").run();

    // All three probes answer plain text with finish_reason 'stop' — no tool
    // evidence anywhere, so supports_tools must stay 0 (only positive writes).
    const mock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'relay-a' }] });
      }
      return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    expect(status).toBe(200);
    expect(body.toolCalls).toBe(false);
    const row = getDb().prepare("SELECT supports_tools FROM models WHERE platform = 'custom' AND model_id = 'relay-a'").get() as { supports_tools: number };
    expect(row.supports_tools).toBe(0);
  });

  it('reports the ping round trip as latency, not the sum of the capability probes (#874)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;

    // The ping answers instantly; both capability probes are deliberately slow.
    // `latencyMs` measures the endpoint's per-request speed and feeds the
    // bandit's speed axis, so it must reflect the PING alone — timing it after
    // the capability probes would report roughly three round trips.
    const SLOW_PROBE_MS = 300;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'relay-a' }] });
      }
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as any;
      if (reqBody.tools || reqBody.max_tokens === 16) {
        await new Promise(resolve => setTimeout(resolve, SLOW_PROBE_MS));
      }
      return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    expect(status).toBe(200);
    // Both capability probes ran (so this is not a "the probes did not fire" pass).
    expect(mock.mock.calls.filter(([u]) => String(u).endsWith('/chat/completions'))).toHaveLength(3);
    expect(body.latencyMs).toBeLessThan(SLOW_PROBE_MS);
    // The recorded sample carries the same ping-only number.
    const sample = getDb().prepare("SELECT latency_ms FROM requests WHERE platform = 'custom'").get() as { latency_ms: number };
    expect(sample.latency_ms).toBeLessThan(SLOW_PROBE_MS);
  });

  it('scopes the supports_tools write-back to the probed endpoint key pool (#874)', async () => {
    // Two unrelated custom endpoints that happen to serve the SAME model id —
    // a very common case with OpenAI-compatible relays. Probing one must not
    // claim tool support for the other.
    const OTHER_ENDPOINT = 'http://127.0.0.1:18098/v1';
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'shared-model', apiKey: 'relay-secret' });
    await post(app, '/api/keys/custom', { baseUrl: OTHER_ENDPOINT, model: 'shared-model', apiKey: 'other-secret' });
    const probedKeyId = customKeyIds(ENDPOINT)[0]!;
    const otherKeyId = customKeyIds(OTHER_ENDPOINT)[0]!;
    getDb().prepare("UPDATE models SET supports_tools = 0 WHERE platform = 'custom' AND model_id = 'shared-model'").run();

    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'shared-model' }] });
      }
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as any;
      if (reqBody.tools) {
        return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'shared-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } });
      }
      return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'shared-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId: probedKeyId });

    expect(status).toBe(200);
    expect(body.toolCalls).toBe(true);
    const flagFor = (keyId: number) => (getDb().prepare(
      "SELECT supports_tools FROM models WHERE platform = 'custom' AND model_id = 'shared-model' AND key_id = ?",
    ).get(keyId) as { supports_tools: number }).supports_tools;
    expect(flagFor(probedKeyId)).toBe(1);
    expect(flagFor(otherKeyId)).toBe(0);
  });

  it('leaves capability flags absent (unknown) when the capability probes fail (#874)', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-a', apiKey: 'relay-secret' });
    const keyId = customKeyIds()[0]!;

    // The ping succeeds, both capability probes blow up. "Unknown" is not the
    // same claim as "no": the response must OMIT the flags so the UI can say so.
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'relay-a' }] });
      }
      const reqBody = JSON.parse(String(init?.body ?? '{}')) as any;
      if (reqBody.tools || reqBody.max_tokens === 16) {
        throw new Error('capability probe exploded');
      }
      return jsonResponse({ id: 'c', object: 'chat.completion', created: 0, model: 'relay-a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    });
    globalThis.fetch = mock as any;

    const { status, body } = await post(app, '/api/keys/custom/probe', { keyId });

    // The ping is still the sample-of-record — a broken capability probe never
    // fails the probe as a whole.
    expect(status).toBe(200);
    expect(body.modelId).toBe('relay-a');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('toolCalls');
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM requests WHERE platform = 'custom'").get() as { c: number }).c;
    expect(count).toBe(1);
  });
});
