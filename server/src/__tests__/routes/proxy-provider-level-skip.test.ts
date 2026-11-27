import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// #788: a provider-level failure (5xx, timeout, dead socket) is about the
// PROVIDER, not the key that happened to catch it. Failover used to burn one
// hop per sibling key — and then one per sibling MODEL of the same sick
// platform — before it ever reached the next provider. The router now honors a
// request-scoped skipPlatforms set, so the first 503 moves the chain on.
// Key-scoped failures (401, 429) must keep rotating to the sibling key.
//
// End-to-end through the real router so the skip is proven where candidates are
// actually enumerated, not just in the loop's bookkeeping.

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
const err503 = () => Object.assign(new Error('Groq API error 503: Service Unavailable'), { status: 503 });
const err401 = () => Object.assign(new Error('Groq API error 401: Invalid API Key'), { status: 401 });

// The decrypted key text ("<platform>-<label>") identifies every dispatched
// attempt — chatCompletion's first argument. Which of a platform's keys the
// round-robin cursor lands on first is not part of the contract, so the
// platform sequence is what these tests assert on.
const keysUsed = (): string[] => chatCompletion.mock.calls.map(call => String(call[0]));
const platformsUsed = (): string[] => keysUsed().map(k => k.split('-')[0]);

// Two groq models on two groq keys, ranked ahead of one cerebras model: the
// pre-#788 chain would spend FOUR hops inside groq before reaching cerebras.
function setup(): void {
  const db = getDb();
  setRoutingStrategy('priority');
  db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  db.prepare('DELETE FROM rate_limit_usage').run();
  db.prepare('UPDATE models SET enabled = 0').run();

  const pick = (platform: string, limit: number) => db.prepare(
    'SELECT id FROM models WHERE platform = ? ORDER BY id LIMIT ?',
  ).all(platform, limit) as { id: number }[];
  const chain = [...pick('groq', 2), ...pick('cerebras', 1)];
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

describe('provider-level failures skip the whole platform (#788)', () => {
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

  it('a 503 on the first groq key fails over to cerebras, not to groq key b', async () => {
    chatCompletion
      .mockRejectedValueOnce(err503())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(platformsUsed()).toEqual(['groq', 'cerebras']);
  });

  it('a groq-wide outage burns two hops, not four', async () => {
    // Both groq keys x both groq models used to be four separate attempts.
    chatCompletion.mockRejectedValue(err503());

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(502); // upstream failures, not a rate-limit exhaustion
    expect(platformsUsed()).toEqual(['groq', 'cerebras']);
  });

  it('a 401 still rotates to the sibling groq key (key-scoped, unchanged)', async () => {
    chatCompletion
      .mockRejectedValueOnce(err401())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(platformsUsed()).toEqual(['groq', 'groq']);
    const [first, second] = keysUsed();
    expect(second).not.toBe(first); // the sibling key, not a retry of the dead one
  });

  it('a 503 on custom relay A fails over to custom relay B rather than skipping all custom endpoints (#2023)', async () => {
    const db = getDb();
    const { encrypted: encA, iv: ivA, authTag: tagA } = encrypt('custom-key-a');
    const { encrypted: encB, iv: ivB, authTag: tagB } = encrypt('custom-key-b');

    const keyAId = db.prepare(`
      INSERT INTO api_keys (platform, label, base_url, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('custom', 'relay-a', 'http://127.0.0.1:18091/v1', ?, ?, ?, 'healthy', 1)
    `).run(encA, ivA, tagA).lastInsertRowid;

    const keyBId = db.prepare(`
      INSERT INTO api_keys (platform, label, base_url, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('custom', 'relay-b', 'http://127.0.0.1:18092/v1', ?, ?, ?, 'healthy', 1)
    `).run(encB, ivB, tagB).lastInsertRowid;

    const m1Id = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, key_id, endpoint_scope, enabled)
      VALUES ('custom', 'relay-model', 'Relay Model A', 1, 1, ?, 'http://127.0.0.1:18091/v1', 1)
    `).run(keyAId).lastInsertRowid;

    const m2Id = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, key_id, endpoint_scope, enabled)
      VALUES ('custom', 'relay-model', 'Relay Model B', 1, 1, ?, 'http://127.0.0.1:18092/v1', 1)
    `).run(keyBId).lastInsertRowid;

    db.prepare('UPDATE fallback_config SET priority = priority + 10').run();
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(m1Id);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)').run(m2Id);

    chatCompletion
      .mockRejectedValueOnce(err503())
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(platformsUsed()).toEqual(['custom', 'custom']);
    expect(keysUsed()).toEqual(['custom-key-a', 'custom-key-b']);
  });
});
