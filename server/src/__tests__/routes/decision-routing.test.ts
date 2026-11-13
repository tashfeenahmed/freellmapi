import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { resetDecisionRoutingCache } from '../../services/routing-decision.js';
import { refreshStatsCache } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { seedDecisionModels } from '../helpers/decision-models.js';

// End to end through the real chat surfaces (#1354): switch the strategy to
// 'decision' over the dashboard API, let a (mocked) decision model pick a
// preset, and check both the header and which model actually served.

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, headers: res.headers };
}

const auth = () => ({ Authorization: `Bearer ${getUnifiedApiKey()}` });

function addKey(platform: string, raw: string): void {
  const secret = encrypt(raw);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'decision-routing', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

// Two chat models at opposite corners: a big slow one and a small fast one.
// Smartest must serve the big one, Fastest the small one.
function addModel(modelId: string, sizeLabel: string, speedRank: number): void {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES ('groq', ?, ?, 1, ?, ?, '~1M', 128000, 1, 0, 1)
  `).run(modelId, modelId, speedRank, sizeLabel).lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, id);
  const profile = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (profile) {
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)').run(Number(profile.value), id, id);
  }
}

// Speed is scored only from observed traffic, so give both models the same
// success record and very different latencies: equally reliable, one fast.
function seedHistory(modelId: string, latencyMs: number, ttfbMs: number): void {
  const insert = getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms)
    VALUES ('groq', ?, 'success', 50, 300, ?, ?)
  `);
  for (let i = 0; i < 20; i++) insert.run(modelId, latencyMs, ttfbMs);
}

let decisionChoice = 'smartest';
let decisionCalls = 0;

function mockUpstreams() {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/ai/run/@cf/cloudflare/clef-flash')) {
      decisionCalls++;
      const probabilities: Record<string, number> = { smartest: 0.02, fastest: 0.02, balanced: 0.02, reliable: 0.02 };
      probabilities[decisionChoice] = 0.94;
      return new Response(JSON.stringify({
        success: true,
        result: { answers: { strategy: { type: 'choice', choice: decisionChoice, probabilities } }, usage: { input_tokens: 200, output_tokens: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('api.groq.com')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origFetch(url as any, init);
  });
}

const servedModel = () =>
  (getDb().prepare('SELECT model_id FROM requests ORDER BY id DESC LIMIT 1').get() as { model_id: string }).model_id;

describe('decision routing over HTTP (#1354)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('UPDATE models SET enabled = 0').run();
    addModel('big-slow', 'Frontier', 11);
    addModel('small-fast', 'Small', 1);
    seedHistory('big-slow', 15_000, 4_000);
    seedHistory('small-fast', 400, 100);
    refreshStatsCache(getDb(), true);
    seedDecisionModels();
    addKey('groq', 'gsk-decision-routing');
    addKey('cloudflare', 'acct:cf-token');
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    resetDecisionRoutingCache();
    app = createApp();
    dashToken = mintDashboardToken();
    decisionChoice = 'smartest';
    decisionCalls = 0;
    mockUpstreams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts the decision strategy and its settings, and reports them', async () => {
    const put = await request('PUT', '/api/fallback/routing', { strategy: 'decision', decisionModel: 'auto', decisionMinProbability: 0.6 });
    expect(put.status).toBe(200);
    expect(put.body.strategy).toBe('decision');
    expect(put.body.decision).toMatchObject({ model: 'auto', minProbability: 0.6, ready: true });
    const get = await request('GET', '/api/fallback/routing');
    expect(get.body.strategy).toBe('decision');
    expect(get.body.decision).toMatchObject({ model: 'auto', minProbability: 0.6, ready: true });
    const bad = await request('PUT', '/api/fallback/routing', { strategy: 'decision', decisionMinProbability: 2 });
    expect(bad.status).toBe(400);
  });

  it('routes each request with the preset the decision model picks', async () => {
    await request('PUT', '/api/fallback/routing', { strategy: 'decision', exploreEnabled: false });

    for (let i = 0; i < 5; i++) {
      decisionChoice = 'smartest';
      const smart = await request('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: `prove a theorem ${i}` }] }, auth());
      expect(smart.status).toBe(200);
      expect(smart.headers.get('x-freellm-routing-strategy')).toBe('smartest');
      expect(servedModel()).toBe('big-slow');

      decisionChoice = 'fastest';
      const fast = await request('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: `what is ${i}+${i}` }] }, auth());
      expect(fast.status).toBe(200);
      expect(fast.headers.get('x-freellm-routing-strategy')).toBe('fastest');
      expect(servedModel()).toBe('small-fast');
    }
    expect(decisionCalls).toBe(10);
  });

  it('works on the Anthropic and Responses surfaces too', async () => {
    await request('PUT', '/api/fallback/routing', { strategy: 'decision', exploreEnabled: false });
    decisionChoice = 'fastest';
    const msgs = await request('POST', '/v1/messages', { max_tokens: 50, messages: [{ role: 'user', content: 'hi there' }] }, auth());
    expect(msgs.status).toBe(200);
    expect(msgs.headers.get('x-freellm-routing-strategy')).toBe('fastest');
    expect(servedModel()).toBe('small-fast');

    decisionChoice = 'smartest';
    const resp = await request('POST', '/v1/responses', { input: 'derive the quadratic formula' }, auth());
    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-freellm-routing-strategy')).toBe('smartest');
    expect(servedModel()).toBe('big-slow');
  });

  it('never asks when another strategy is active, or when the request pins a model', async () => {
    await request('PUT', '/api/fallback/routing', { strategy: 'balanced' });
    const plain = await request('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, auth());
    expect(plain.status).toBe(200);
    expect(plain.headers.get('x-freellm-routing-strategy')).toBeNull();

    await request('PUT', '/api/fallback/routing', { strategy: 'decision' });
    const pinned = await request('POST', '/v1/chat/completions', { model: 'small-fast', messages: [{ role: 'user', content: 'hi' }] }, auth());
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get('x-freellm-routing-strategy')).toBeNull();
    expect(decisionCalls).toBe(0);
  });

  it('still serves the request as Balanced when the decision model is down', async () => {
    await request('PUT', '/api/fallback/routing', { strategy: 'decision' });
    vi.restoreAllMocks();
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/ai/run/')) return new Response('upstream down', { status: 500 });
      if (u.includes('api.groq.com')) {
        return new Response(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 1, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return origFetch(url as any, init);
    });
    const res = await request('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }, auth());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-freellm-routing-strategy')).toBe('balanced; fallback=error');
  });
});
