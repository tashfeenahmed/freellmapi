import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Item 1 of the fallback hardening: an upstream 401 (invalid provider key) is
// KEY-fatal, not request-fatal. Live-verified bug: it returned a 502
// immediately, never rotating to the provider's healthy sibling key, and the
// bad key stayed in rotation failing ~50% of traffic until the 5-minute health
// cycle. Now the loop rotates past the key, benches it, and fires an immediate
// targeted revalidation; an all-auth exhaustion is reported distinctly from a
// rate-limit exhaustion (item 2: with the attempt trail + X-Fallback-Attempts).

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({ checkKeyHealth: mockCheckKeyHealth }));

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy, getAllPenalties } = await import('../../services/router.js');

async function post(app: Express, path: string, body: any, key: string, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* SSE */ }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};
const err401 = () => Object.assign(new Error('Groq API error 401: Invalid API Key'), { status: 401 });
const err429 = () => Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 });

interface Setup { modelDbId: number; modelId: string; keyA: number; keyB: number }

// Distinct groq model per test so module-global rate-limit state (cooldowns,
// round-robin, penalties — keyed by model) can't leak between tests.
function setup(rank: number): Setup {
  const db = getDb();
  setRoutingStrategy('priority');
  db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  db.prepare('DELETE FROM rate_limit_usage').run();

  const models = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY id").all() as { id: number; model_id: string }[];
  const model = models[rank];
  db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('UPDATE models SET enabled = 1, rpm_limit = NULL, rpd_limit = NULL, tpm_limit = NULL, tpd_limit = NULL WHERE id = ?').run(model.id);

  const ids: number[] = [];
  for (const label of ['a', 'b']) {
    const { encrypted, iv, authTag } = encrypt(`groq-auth-${rank}-${label}`);
    const info = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
    `).run(`auth-${rank}-${label}`, encrypted, iv, authTag);
    ids.push(Number(info.lastInsertRowid));
  }
  return { modelDbId: model.id, modelId: model.model_id, keyA: ids[0], keyB: ids[1] };
}

describe('upstream 401 rotates to the sibling key instead of 502 (item 1)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    mockCheckKeyHealth.mockReset();
    mockCheckKeyHealth.mockResolvedValue('invalid');
  });

  it('fails over to the healthy sibling key and revalidates the bad one', async () => {
    const s = setup(0);
    chatCompletion
      .mockRejectedValueOnce(err401())     // first key: invalid
      .mockResolvedValueOnce(GOOD_RESULT); // sibling key: healthy

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'auth rotation test' }],
    }, key);

    expect(status).toBe(200); // previously an immediate 502 with the sibling key stranded
    expect(body.choices[0].message.content).toBe('ok');
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    // Immediate targeted revalidation fired for the failing key (one of the two).
    expect(mockCheckKeyHealth).toHaveBeenCalledTimes(1);
    expect([s.keyA, s.keyB]).toContain(mockCheckKeyHealth.mock.calls[0][0]);
    // A key problem is not a model problem: no model-level penalty.
    expect(getAllPenalties().some(p => p.modelDbId === s.modelDbId)).toBe(false);
    // The bad key is benched (roughly the health-cycle window) so it leaves
    // rotation even before the revalidation lands.
    const benched = getDb().prepare(
      'SELECT expires_at_ms FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?',
    ).get('groq', s.modelId, mockCheckKeyHealth.mock.calls[0][0]) as { expires_at_ms: number };
    expect(benched.expires_at_ms - Date.now()).toBeGreaterThan(3 * 60 * 1000);
  });

  it('all-auth exhaustion returns a distinct 502 with the attempt trail (items 1+2)', async () => {
    setup(1);
    chatCompletion.mockRejectedValue(err401()); // both keys invalid

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'all keys invalid test' }],
    }, key);

    expect(status).toBe(502); // NOT a misleading 429 rate-limit exhaustion
    expect(body.error.type).toBe('provider_error');
    expect(body.error.message).toContain('failed authentication');
    expect(body.error.message).toContain('Attempt trail:');
    expect(body.error.message).toContain('auth');
    expect(headers.get('x-fallback-attempts')).toBe('2');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('anthropic surface: all-auth exhaustion is Anthropic-shaped (api_error)', async () => {
    setup(2);
    chatCompletion.mockRejectedValue(err401());

    const { status, body, headers } = await post(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 32,
      messages: [{ role: 'user', content: 'anthropic auth exhaustion test' }],
    }, key, { 'anthropic-version': '2023-06-01' });

    expect(status).toBe(502);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('api_error'); // 'provider_error' remapped for the Anthropic wire
    expect(body.error.message).toContain('failed authentication');
    expect(headers.get('x-fallback-attempts')).toBe('2');
  });

  it('Google-style 400 bad key rotates + revalidates and never blames the client request (#268)', async () => {
    // Google reports a dead/expired key as HTTP 400 "API key not valid", NOT a
    // 401. Before the fix that classified as a provider bad-request, so an
    // exhaustion could surface to the client as 400 "All routed providers
    // rejected the request as invalid" — blaming the request for a bad key.
    const googleBadKey = () => Object.assign(
      new Error('Google API error 400: API key not valid. Please pass a valid API key.'),
      { status: 400 },
    );
    setup(4);
    chatCompletion
      .mockRejectedValueOnce(googleBadKey())   // first key: dead Google-style key
      .mockResolvedValueOnce(GOOD_RESULT);     // sibling key: healthy

    const first = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'google bad key rotation test' }],
    }, key);

    expect(first.status).toBe(200);            // rotated, not a client-blaming 400
    expect(first.headers.get('x-fallback-attempts')).toBe('1');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(mockCheckKeyHealth).toHaveBeenCalledTimes(1); // immediate revalidation fired

    // Now the surviving key dies the same way: exhaustion must be the distinct
    // auth 502, never the invalid-request 400.
    chatCompletion.mockRejectedValue(googleBadKey());
    const second = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'google bad key exhaustion test' }],
    }, key);

    expect(second.status).toBe(502);
    expect(second.status).not.toBe(400);
    expect(second.body.error.type).toBe('provider_error');
    expect(second.body.error.message).toContain('failed authentication');
    expect(second.body.error.message).not.toContain('rejected the request as invalid');
  });
});

describe('exhaustion error quality: attempt trail + reset hint + header (item 2)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    mockCheckKeyHealth.mockReset();
    mockCheckKeyHealth.mockResolvedValue('healthy');
  });

  it('a rate-limit exhaustion body names each attempt and the soonest reset', async () => {
    const s = setup(3);
    chatCompletion.mockRejectedValue(err429()); // both keys rate-limited

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'trail quality test' }],
    }, key);

    expect(status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
    // Previously: terse "All models rate-limited after N attempts. Last error: X".
    expect(body.error.message).toContain('after 2 attempts');
    expect(body.error.message).toContain('Attempt trail:');
    expect(body.error.message).toContain(`groq/${s.modelId} key1: rate_limited`);
    expect(body.error.message).toContain(`groq/${s.modelId} key2: rate_limited`);
    // The cooldowns just recorded make a soonest-reset hint available.
    expect(body.error.message).toContain('Soonest cooldown reset');
    // X-Fallback-Attempts now stamps ERROR responses too (was success-only).
    expect(headers.get('x-fallback-attempts')).toBe('2');
  });
});
