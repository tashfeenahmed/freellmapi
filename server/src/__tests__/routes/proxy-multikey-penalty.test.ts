import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Mock the provider so we can script 429s without real upstream calls.
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

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy, hasOtherUsableKey, getAllPenalties } = await import('../../services/router.js');
const { setCooldown } = await import('../../services/ratelimit.js');

async function post(app: Express, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};
const err429 = () => Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 });

interface Setup { modelDbId: number; modelId: string; keyA: number; keyB: number }

// Each test uses a DISTINCT groq model so the module-global in-memory rate-limit
// state (cooldowns, round-robin, penalties — keyed by model) can't leak between
// tests, mirroring how ratelimit.test.ts uses unique identifiers per case.
function setup(rank: number, onlyModel = false): Setup {
  const db = getDb();
  setRoutingStrategy('priority');
  db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  db.prepare('DELETE FROM rate_limit_usage').run();

  const models = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY id").all() as { id: number; model_id: string }[];
  const model = models[rank];
  if (onlyModel) db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('UPDATE models SET enabled = 1, rpm_limit = NULL, rpd_limit = NULL, tpm_limit = NULL, tpd_limit = NULL WHERE id = ?').run(model.id);

  const ids: number[] = [];
  for (const label of ['a', 'b']) {
    const { encrypted, iv, authTag } = encrypt(`groq-${rank}-${label}`);
    const info = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
    `).run(`${rank}-${label}`, encrypted, iv, authTag);
    ids.push(Number(info.lastInsertRowid));
  }
  return { modelDbId: model.id, modelId: model.model_id, keyA: ids[0], keyB: ids[1] };
}

describe('hasOtherUsableKey (#454)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('returns true when a sibling key is free', () => {
    const s = setup(0);
    expect(hasOtherUsableKey(s.modelDbId, s.keyA)).toBe(true);
  });

  it('returns false when the only sibling is on cooldown', () => {
    const s = setup(1);
    setCooldown('groq', s.modelId, s.keyB, 5 * 60 * 1000);
    expect(hasOtherUsableKey(s.modelDbId, s.keyA)).toBe(false);
  });

  it('returns false when the only sibling is already ruled out this request (skipKeys)', () => {
    const s = setup(2);
    const skip = new Set<string>([`groq:${s.modelId}:${s.keyB}`]);
    expect(hasOtherUsableKey(s.modelDbId, s.keyA, skip)).toBe(false);
  });

  it('is symmetric: excluding one key finds the other when it is free, none when it is benched', () => {
    const s = setup(3);
    expect(hasOtherUsableKey(s.modelDbId, s.keyB)).toBe(true); // keyA free
    setCooldown('groq', s.modelId, s.keyA, 5 * 60 * 1000);
    expect(hasOtherUsableKey(s.modelDbId, s.keyB)).toBe(false); // keyA benched, keyB excluded
  });
});

describe('one key\'s 429 must not demote the whole model (#454)', () => {
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
  });

  it('does NOT record a model-level penalty when the first key 429s but a sibling succeeds', async () => {
    const s = setup(4, true);
    chatCompletion
      .mockRejectedValueOnce(err429())    // key A
      .mockResolvedValueOnce(GOOD_RESULT); // key B

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    expect(status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    // The model must NOT be penalized — only one key hit the limit.
    expect(getAllPenalties().some(p => p.modelDbId === s.modelDbId)).toBe(false);
  });

  it('DOES record the model-level penalty once the last usable key 429s', async () => {
    const s = setup(5, true);
    chatCompletion.mockRejectedValue(err429()); // both keys 429

    const { status } = await post(app, { messages: [{ role: 'user', content: 'hi' }] }, key);

    // Chain exhausts after both keys fail.
    expect(status).toBe(429);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    // The model IS penalized: the 429 exhausted it, not just one key.
    expect(getAllPenalties().some(p => p.modelDbId === s.modelDbId)).toBe(true);
  });
});
