import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { seedDecisionModels } from '../helpers/decision-models.js';
import { stubPublicDns } from '../helpers/dns.js';

// Fake relay hosts must resolve for the URL guard (#1875).
beforeEach(() => stubPublicDns());

// Custom/local decision providers (#1777).
//
// A custom decision endpoint speaks a proposed generic contract — POST
// {base_url}/decide with { model, prompt, choices, context } — and answers
// { decision, confidence, reasoning }. It is a PROPOSAL, not a maintainer
// declaration: no existing decision provider shares a wire shape (halx,
// aisense, blockrun, apinex, beatapi, cloudflare, openrouter all differ), so
// the PR body says so plainly and the maintainer may adjust the contract.
// The adapter asks one question per call: a single decision value cannot
// answer several distinct questions, and per-question calls keep each
// answer's probabilities honest.

const realFetch = globalThis.fetch;
let dashToken = '';

async function call(app: Express, method: string, path: string, opts: { body?: unknown; auth?: 'dash' | 'api' | null } = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = opts.auth === undefined ? (path.startsWith('/api') ? 'dash' : 'api') : opts.auth;
  if (auth === 'dash') headers.Authorization = `Bearer ${dashToken}`;
  if (auth === 'api') headers.Authorization = `Bearer ${getUnifiedApiKey()}`;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

type UpstreamCall = { url: string; body: any; auth: string | null };

function mockDecide(handler: (call: UpstreamCall) => { status: number; json: unknown }): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    const urlStr = String(url);
    if (!urlStr.startsWith('https://decide.example.com')) {
      throw new Error(`unexpected upstream call to ${urlStr}`);
    }
    const c: UpstreamCall = {
      url: urlStr,
      body: JSON.parse(String(init.body)),
      auth: new Headers(init.headers).get('Authorization'),
    };
    calls.push(c);
    const { status, json } = handler(c);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return calls;
}

async function registerDecision(app: Express, apiKey?: string) {
  const body: Record<string, unknown> = {
    baseUrl: 'https://decide.example.com/v1',
    model: 'my-decider',
    modality: 'decision',
  };
  if (apiKey !== undefined) body.apiKey = apiKey;
  return call(app, 'POST', '/api/media/custom', { body });
}

describe('custom decision providers (#1777)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedDecisionModels();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registers a custom decision provider through POST /api/media/custom', async () => {
    const created = await registerDecision(app, 'decide-secret');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ platform: 'custom', model: 'my-decider', modality: 'decision' });
    const models = await call(app, 'GET', '/v1/decisions/models');
    expect(models.body.data.find((m: any) => m.id === 'my-decider')).toMatchObject({
      provider: 'custom', available: true,
    });
  });

  it('routes a choice question through the mock custom endpoint', async () => {
    expect((await registerDecision(app, 'decide-secret')).status).toBe(201);
    const calls = mockDecide(() => ({
      status: 200,
      json: { decision: 'code', confidence: 0.9, reasoning: 'It is a stack trace.' },
    }));
    const res = await call(app, 'POST', '/v1/decisions', {
      body: {
        state: 'fix: TypeError: Cannot read properties of undefined',
        questions: { tier: { type: 'choice', instructions: 'Which tier?', criteria: { light: 'chat', code: 'coding' } } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'decision', model: 'my-decider', provider: 'custom',
    });
    expect(res.body.answers.tier).toMatchObject({
      type: 'choice', choice: 'code', confidence: 0.9,
      probabilities: { light: 0.1, code: 0.9 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://decide.example.com/v1/decide');
    expect(calls[0].body).toMatchObject({
      model: 'my-decider',
      prompt: expect.stringContaining('Which tier?'),
      choices: ['light', 'code'],
    });
    expect(calls[0].auth).toBe('Bearer decide-secret');
  });

  it('routes a noul and a score question, one call per question', async () => {
    expect((await registerDecision(app, 'decide-secret')).status).toBe(201);
    const calls = mockDecide((c) => {
      if (c.body.choices.includes('yes')) return { status: 200, json: { decision: 'yes', confidence: 0.8 } };
      return { status: 200, json: { decision: '2', confidence: 0.7, reasoning: 'High severity.' } };
    });
    const res = await call(app, 'POST', '/v1/decisions', {
      body: {
        state: 'the checkout page 500s on submit',
        questions: {
          urgent: { type: 'noul', instructions: 'Is this urgent?' },
          severity: { type: 'score', instructions: 'Rate severity', criteria: ['low', 'medium', 'high'] },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.answers.urgent).toMatchObject({ type: 'noul', noul: 0.8 });
    expect(res.body.answers.severity).toMatchObject({ type: 'score', score: 2, confidence: 0.7 });
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.body.choices)).toEqual([['yes', 'no'], ['0', '1', '2']]);
  });

  it('serves a keyless local relay without inventing a credential', async () => {
    expect((await registerDecision(app)).status).toBe(201);
    const calls = mockDecide(() => ({ status: 200, json: { decision: 'light', confidence: 0.6 } }));
    const res = await call(app, 'POST', '/v1/decisions', {
      body: {
        state: 'hello',
        questions: { tier: { type: 'choice', instructions: 'Which tier?', criteria: { light: 'chat', code: 'coding' } } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.answers.tier.choice).toBe('light');
    expect(calls).toHaveLength(1);
    // Keyless custom endpoints store the repo's sentinel credential, exactly
    // like the custom search relay does — no fake key is manufactured here.
    expect(calls[0].auth).toBe('Bearer no-key');
  });

  it('fails closed when the endpoint is down — no silent fallback, no fabricated answer', async () => {
    expect((await registerDecision(app, 'decide-secret')).status).toBe(201);
    const calls = mockDecide(() => ({ status: 500, json: { error: 'boom' } }));
    const res = await call(app, 'POST', '/v1/decisions', {
      body: {
        state: 'fix: TypeError',
        questions: { tier: { type: 'choice', instructions: 'Which tier?', criteria: { light: 'chat', code: 'coding' } } },
      },
    });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/decision error/);
    expect(res.body).not.toHaveProperty('answers');
    expect(calls).toHaveLength(1);
  });

  it('rejects a decision value outside the question options instead of returning it', async () => {
    expect((await registerDecision(app, 'decide-secret')).status).toBe(201);
    mockDecide(() => ({ status: 200, json: { decision: 'neither', confidence: 0.9 } }));
    const res = await call(app, 'POST', '/v1/decisions', {
      body: {
        state: 'fix: TypeError',
        questions: { tier: { type: 'choice', instructions: 'Which tier?', criteria: { light: 'chat', code: 'coding' } } },
      },
    });
    expect(res.status).toBe(502);
    expect(res.body).not.toHaveProperty('answers');
  });
});
