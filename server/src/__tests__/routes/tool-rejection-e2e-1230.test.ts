import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { setRoutingStrategy, setExploreEnabled } from '../../services/router.js';
import { resetToolCapability } from '../../lib/tool-capability.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { addToActiveChain } from '../helpers/chain.js';

// #1230 end to end, against two REAL local relays. `bad` answers every request
// that carries `tools` with a 400 (but serves plain chat); `good` serves
// everything. Both are custom endpoints, so both default to supports_tools = 1
// and `bad` sits first in the chain. Before the fix every tool request paid
// for a rejected hop on `bad` first, forever.

type Relay = { url: string; hits: { tools: number; plain: number }; close: () => Promise<void> };

function startRelay(rejectTools: boolean): Promise<Relay> {
  const hits = { tools: 0, plain: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (hasTools) hits.tools++; else hits.plain++;
      if (hasTools && rejectTools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'tools is not supported by this model', type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    resolve({ url: `http://127.0.0.1:${port}/v1`, hits, close: () => new Promise<void>(r => server.close(() => r())) });
  }));
}

const TOOLS = [{ type: 'function', function: { name: 'get_time', description: 'now', parameters: { type: 'object', properties: {} } } }];

describe('a relay that rejects tool calls stops costing every tool request a hop (#1230)', () => {
  let app: Express;
  let bad: Relay;
  let good: Relay;
  let dashToken = '';

  async function call(path: string, body: unknown, token: string) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null) as any;
    server.close();
    return { status: res.status, body: data, routedVia: res.headers.get('x-routed-via') ?? '' };
  }

  // Every call is a NEW conversation with all cooldowns cleared, so neither the
  // sticky-session pin nor the short transient bench on `bad` can explain where
  // a request lands: only the chain order and the tool deferral can.
  let turn = 0;
  const chat = (withTools: boolean) => {
    for (const k of getDb().prepare('SELECT id FROM api_keys').all() as { id: number }[]) clearCooldownsForKey(k.id);
    return call('/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: `question ${++turn}: what time is it?` }],
      ...(withTools ? { tools: TOOLS } : {}),
    }, getUnifiedApiKey());
  };

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetToolCapability();
    app = createApp();
    dashToken = mintDashboardToken();
    bad = await startRelay(true);
    good = await startRelay(false);
    // Only the two relays are routable: no other platform has a key.
    expect((await call('/api/keys/custom', { baseUrl: bad.url, model: 'bad-model', apiKey: 'k1', label: 'Bad relay' }, dashToken)).status).toBe(201);
    expect((await call('/api/keys/custom', { baseUrl: good.url, model: 'good-model', apiKey: 'k2', label: 'Good relay' }, dashToken)).status).toBe(201);
    setRoutingStrategy('priority');
    setExploreEnabled(false);
    const id = (m: string) => (getDb().prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = ?").get(m) as { id: number }).id;
    getDb().prepare('UPDATE fallback_config SET priority = priority + 1000').run();
    getDb().prepare('UPDATE profile_models SET priority = priority + 1000').run();
    for (const [m, p] of [['bad-model', 1], ['good-model', 2]] as const) {
      getDb().prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?').run(p, id(m));
      addToActiveChain(id(m), p);
    }
  });

  afterEach(async () => {
    await bad.close();
    await good.close();
    resetToolCapability();
  });

  it('learns from one served tool request and skips the rejected hop afterwards', async () => {
    // Request 1: bad is first, rejects with 400, good serves it.
    const first = await chat(true);
    expect(first.status).toBe(200);
    expect(first.body.choices[0].message.content).toBe('OK');
    expect(bad.hits.tools).toBe(1);
    expect(good.hits.tools).toBe(1);

    // Requests 2 and 3: good proved the request was fine, so bad is tried last
    // and is never reached.
    for (let i = 0; i < 2; i++) expect((await chat(true)).status).toBe(200);
    expect(bad.hits.tools).toBe(1);
    expect(good.hits.tools).toBe(3);

    // Plain chat is untouched: bad is still first in line and serves it.
    const plain = await chat(false);
    expect(plain.status).toBe(200);
    expect(bad.hits.plain).toBe(1);
    expect(good.hits.plain).toBe(0);
  });
});
