import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Mock the provider so routing is exercised without real upstream calls.
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
const { setRoutingStrategy, routingReserveTokens, OUTPUT_RESERVE_CAP } = await import('../../services/router.js');

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

describe('routingReserveTokens (#470)', () => {
  it('caps the reserved output at OUTPUT_RESERVE_CAP', () => {
    expect(routingReserveTokens(32000)).toBe(OUTPUT_RESERVE_CAP);
    expect(routingReserveTokens(50)).toBe(50);
    // Omitted / non-positive max_tokens keeps the historical 1000 default (capped).
    expect(routingReserveTokens(undefined)).toBe(Math.min(1000, OUTPUT_RESERVE_CAP));
    expect(routingReserveTokens(0)).toBe(Math.min(1000, OUTPUT_RESERVE_CAP));
    expect(routingReserveTokens(-1)).toBe(Math.min(1000, OUTPUT_RESERVE_CAP));
  });
});

describe('max_tokens no longer starves routing (#470)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();

    const { encrypted, iv, authTag } = encrypt('groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);

    // Only groq is keyed, so make groq the ONLY routable platform and give every
    // groq model a small per-minute TOKEN budget (6k) with a large context
    // window, so the sole thing that can exclude a groq model is the token
    // estimate: a huge client max_tokens must NOT exceed 6k once the reserved
    // output is capped, while a huge INPUT still must.
    db.prepare("UPDATE models SET enabled = 0 WHERE platform != 'groq'").run();
    db.prepare("UPDATE models SET tpm_limit = 6000, tpd_limit = NULL, context_window = 200000 WHERE platform = 'groq'").run();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
  });

  it('routes a tiny prompt with a huge max_tokens (was a false 429 with zero upstream calls)', async () => {
    chatCompletion.mockResolvedValueOnce(GOOD_RESULT);

    const { status, body } = await post(app, {
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32000, // >> the 6k TPM; capped reserve keeps it routable.
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('ok');
    // The model was actually dispatched — not synchronously excluded.
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('still excludes the model when the INPUT itself exceeds the TPM budget', async () => {
    chatCompletion.mockResolvedValueOnce(GOOD_RESULT);

    // ~8k input tokens (32k chars / 4) > the 6k TPM budget → the only enabled
    // model is filtered out before any upstream call.
    const bigPrompt = 'x'.repeat(32_000);
    const { status } = await post(app, {
      messages: [{ role: 'user', content: bigPrompt }],
      max_tokens: 50,
    }, key);

    expect(status).toBe(429);
    expect(chatCompletion).not.toHaveBeenCalled();
  });
});
