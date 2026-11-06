import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { seedDecisionModels } from '../helpers/decision-models.js';

// HTTP surface of decision models: POST /v1/decisions (and the /v1/systemone
// alias) and GET /v1/decisions/models for API callers, /api/decisions/* for the
// dashboard's Models → Decision page.

const realFetch = globalThis.fetch;
let dashToken = '';

function addKey(platform: string, raw: string): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
  return Number(row.lastInsertRowid);
}

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

const ANSWERS = { tier: { type: 'choice', choice: 'code', probabilities: { light: 0.1, code: 0.9 }, confidence: 0.8 } };
const BODY = {
  state: 'fix: TypeError: Cannot read properties of undefined',
  questions: { tier: { type: 'choice', instructions: 'Which tier?', criteria: { light: 'chat', code: 'coding' } } },
};

describe('decision routes', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedDecisionModels();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    app = createApp();
    dashToken = mintDashboardToken();
    addKey('cloudflare', 'acct:tok');
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ success: true, result: { answers: ANSWERS, usage: { input_tokens: 42, output_tokens: 0 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('POST /v1/decisions needs the unified key', async () => {
    const res = await call(app, 'POST', '/v1/decisions', { body: BODY, auth: null });
    expect(res.status).toBe(401);
  });

  it('POST /v1/decisions returns the answers and the model that served them', async () => {
    const res = await call(app, 'POST', '/v1/decisions', { body: BODY });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: 'decision',
      model: '@cf/cloudflare/clef-flash',
      provider: 'cloudflare',
      answers: ANSWERS,
      usage: { input_tokens: 42, output_tokens: 0 },
    });
  });

  it('POST /v1/systemone is an alias', async () => {
    const res = await call(app, 'POST', '/v1/systemone', { body: BODY });
    expect(res.status).toBe(200);
    expect(res.body.answers).toEqual(ANSWERS);
  });

  it('accepts extraction fields and rejects mixed/unsupported extraction schemas', async () => {
    getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES ('cloudflare','@cf/cloudflare/clairic','Clairic','decision',20,1,'free')").run();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: {
      model: 'clairic', answers: { total: { type: 'number', value: 1080 } }, usage: { input_tokens: 288 }, truncated: false,
    } }), { status: 200 })) as typeof fetch;
    const body = { model: '@cf/cloudflare/clairic', state: 'Total $1080', fields: { total: { type: 'number', unit: 'USD' } } };
    const good = await call(app, 'POST', '/v1/decisions', { body });
    expect(good.status).toBe(200);
    expect(good.body.answers.total.value).toBe(1080);
    expect(good.body.truncated).toBe(false);
    for (const bad of [{ ...body, questions: BODY.questions }, { ...body, state: {} }, { ...body, fields: {} }, { ...body, fields: { total: { type: 'unsupported' } } }]) {
      expect((await call(app, 'POST', '/v1/decisions', { body: bad })).status).toBe(400);
    }
  });

  it('validates the body', async () => {
    const noState = await call(app, 'POST', '/v1/decisions', { body: { questions: BODY.questions } });
    expect(noState.status).toBe(400);
    const badType = await call(app, 'POST', '/v1/decisions', {
      body: { state: 'x', questions: { q: { type: 'essay', instructions: 'write' } } },
    });
    expect(badType.status).toBe(400);
    const noQuestions = await call(app, 'POST', '/v1/decisions', { body: { state: 'x', questions: {} } });
    expect(noQuestions.status).toBe(400);
  });

  it('GET /v1/decisions/models lists the enabled models and whether a key exists', async () => {
    const res = await call(app, 'GET', '/v1/decisions/models');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: '@cf/cloudflare/clef-flash', object: 'decision_model', provider: 'cloudflare', name: 'Clef Flash', context_window: 24576, available: true },
      { id: 'inception/mercury-decide:free', object: 'decision_model', provider: 'openrouter', name: 'Mercury Decide (free)', context_window: 65536, available: false },
    ]);
  });

  it('decision models never show up in the chat model list', async () => {
    const res = await call(app, 'GET', '/v1/models');
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map(m => m.id);
    expect(ids).not.toContain('@cf/cloudflare/clef-flash');
    expect(ids).not.toContain('inception/mercury-decide:free');
  });

  it('dashboard lists, toggles and tries decision models', async () => {
    const list = await call(app, 'GET', '/api/decisions/models');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const id = list.body[1].id;
    const patched = await call(app, 'PATCH', `/api/decisions/models/${id}`, { body: { enabled: false } });
    expect(patched.status).toBe(200);
    expect(patched.body.enabled).toBe(false);

    const tried = await call(app, 'POST', '/api/decisions/try', {
      body: { state: 'my react effect runs twice', question: 'Which tier?', options: ['light', 'code'] },
    });
    expect(tried.status).toBe(200);
    expect(tried.body.provider).toBe('cloudflare');
    const sent = JSON.parse(((globalThis.fetch as any).mock.calls[0][1] as RequestInit).body as string);
    expect(sent.questions).toEqual({ answer: { type: 'choice', instructions: 'Which tier?', criteria: { light: null, code: null } } });
  });

  it('dashboard routes need the dashboard session', async () => {
    const res = await call(app, 'GET', '/api/decisions/models', { auth: null });
    expect(res.status).toBe(401);
  });
});
