import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// A provider that reports a model as gone — a structured `model_not_found`
// code, or a bare HTTP 404/410 — is a MODEL-level failure, not a key-level
// one: every key for that model fails identically, so the request must skip
// the WHOLE model (its sibling key included) and continue down the chain.
//
// End-to-end through the real router so the skip is proven where candidates
// are actually enumerated: the chain below holds exactly ONE groq model and
// ONE cerebras model, so a model-level skip shows up as the next attempt
// moving to cerebras. If the failure were treated as key-scoped the second
// attempt would stay on groq (the sibling key), and if it were treated as
// provider-level the whole platform would be dropped.

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

const { mockCheckKeyHealth, mockMarkKeyHealthy } = vi.hoisted(() => ({
  mockCheckKeyHealth: vi.fn(),
  mockMarkKeyHealthy: vi.fn(),
}));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: mockMarkKeyHealthy,
}));

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');
const { resetModelRetirementObservations } = await import('../../services/model-retirement.js');

async function post(app: Express, body: any, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

// The machine-readable code is the whole point of this shape, so the message
// deliberately contains NONE of the phrases the classifier also matches on
// ("not found", "404", "410", "gone", "quota", "daily", "degraded"). If the
// structured code were ignored, these errors would NOT be model-level.
const errStructuredModelNotFound = () => Object.assign(
  new Error('Groq API error 422: model route rejected by upstream policy'),
  { status: 422, body: { error: { code: 'model_not_found' } } },
);

// Same discipline for the status-driven shapes: the STATUS is the signal, so
// the text stays neutral.
const errHttp404 = () => Object.assign(
  new Error('Groq upstream rejected the model route'),
  { status: 404 },
);
const errHttp410 = () => Object.assign(
  new Error('Groq upstream withdrew the model route'),
  { status: 410 },
);

// The decrypted key text ("<platform>-<label>") identifies every dispatched
// attempt — chatCompletion's first argument. Which of a platform's keys the
// round-robin cursor lands on first is not part of the contract, so the
// platform sequence is what these tests assert on.
const keysUsed = (): string[] => chatCompletion.mock.calls.map(call => String(call[0]));
const platformsUsed = (): string[] => keysUsed().map(k => k.split('-')[0]);

// ONE groq model (on two sibling keys) and ONE cerebras model: a model-level
// skip must move the request to cerebras, while a key-scoped failure would
// have stayed on groq's second key.
function setup(): void {
  const db = getDb();
  setRoutingStrategy('priority');
  db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  db.prepare('DELETE FROM rate_limit_usage').run();
  // A retirement recorded by an earlier case must not leak into the next one.
  db.prepare('DELETE FROM catalog_model_tombstones').run();
  db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('UPDATE fallback_config SET enabled = 0').run();
  resetModelRetirementObservations();

  const pick = (platform: string, limit: number) => db.prepare(
    'SELECT id FROM models WHERE platform = ? ORDER BY id LIMIT ?',
  ).all(platform, limit) as { id: number }[];
  const chain = [...pick('groq', 1), ...pick('cerebras', 1)];
  const enable = db.prepare(
    'UPDATE models SET enabled = 1, rpm_limit = NULL, rpd_limit = NULL, tpm_limit = NULL, tpd_limit = NULL WHERE id = ?',
  );
  const prioritize = db.prepare('UPDATE fallback_config SET priority = ?, enabled = 1 WHERE model_db_id = ?');
  chain.forEach((m, i) => { enable.run(m.id); prioritize.run(i + 1, m.id); });

  for (const [platform, label] of [['groq', 'a'], ['groq', 'b'], ['cerebras', 'c']] as const) {
    const { encrypted, iv, authTag } = encrypt(`${platform}-${label}`);
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, 'healthy', 1)
    `).run(platform, label, encrypted, iv, authTag);
  }
}

describe('model-level "not found" skips the whole model and continues the chain', () => {
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
    setup();
  });

  it('a structured model_not_found skips the model and the next member serves the request', async () => {
    chatCompletion
      .mockRejectedValueOnce(errStructuredModelNotFound())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    // Model-level: the next attempt is a DIFFERENT platform, not groq's
    // sibling key.
    expect(platformsUsed()).toEqual(['groq', 'cerebras']);
  });

  it('every member reporting model_not_found exhausts with 404 model_not_found and a trail', async () => {
    chatCompletion.mockRejectedValue(errStructuredModelNotFound());

    const { status, body } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(404);
    expect(body?.error?.code).toBe('model_not_found');
    expect(body?.error?.type).toBe('invalid_request_error');
    expect(String(body?.error?.message)).toContain('Attempt trail:');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(platformsUsed()).toEqual(['groq', 'cerebras']);
  });

  it('a provider 404 keeps the chain moving instead of ending the request', async () => {
    chatCompletion
      .mockRejectedValueOnce(errHttp404())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(platformsUsed()).toEqual(['groq', 'cerebras']);
  });

  it('a provider 410 keeps the chain moving instead of ending the request', async () => {
    chatCompletion
      .mockRejectedValueOnce(errHttp410())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(platformsUsed()).toEqual(['groq', 'cerebras']);
  });
});
