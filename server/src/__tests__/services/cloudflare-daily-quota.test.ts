import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { benchCloudflareAccount, cloudflareAccountId, isCloudflareNeuronsExhausted } from '../../services/cloudflare-daily-quota.js';
import { clearCooldownsForKey, getActiveCooldownsForKeys, isOnCooldown, clearAllCooldowns } from '../../services/ratelimit.js';

// Cloudflare Workers AI's free 10K neurons/day is shared by every model and
// every token of one ACCOUNT, so a daily neurons 429 benches the whole account
// (as ordinary, visible, clearable cooldown rows) while a different Cloudflare
// account stays available for fallback.

const NEURONS_MSG = 'Cloudflare API error 429: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan';
const DAILY = { status: 429, message: NEURONS_MSG };
const HOUR = 60 * 60_000;

function insertKey(value: string): number {
  const { encrypted, iv, authTag } = encrypt(value);
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('cloudflare', 'test', ?, ?, ?, 'healthy', 1)",
  ).run(encrypted, iv, authTag).lastInsertRowid);
}

function cloudflareModels(): string[] {
  return (getDb().prepare("SELECT model_id FROM models WHERE platform = 'cloudflare' AND enabled = 1").all() as { model_id: string }[])
    .map(r => r.model_id);
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare("DELETE FROM api_keys WHERE platform = 'cloudflare'").run();
  clearAllCooldowns();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cloudflare shared daily neurons allowance', () => {
  it('parses the account id and only matches a daily neurons 429', () => {
    expect(cloudflareAccountId('ACCOUNT-A:token')).toBe('account-a');
    expect(cloudflareAccountId('no-separator')).toBeNull();
    expect(cloudflareAccountId(':token')).toBeNull();
    expect(isCloudflareNeuronsExhausted(DAILY)).toBe(true);
    expect(isCloudflareNeuronsExhausted({ status: 429, message: 'Too Many Requests' })).toBe(false);
    expect(isCloudflareNeuronsExhausted({ status: 402, message: NEURONS_MSG })).toBe(false);
  });

  it('benches every model on every token of the same account, not another account', () => {
    const a1 = insertKey('account-a:token-one');
    const a2 = insertKey('account-a:token-two');
    const b1 = insertKey('account-b:token-three');
    const models = cloudflareModels();
    expect(models.length).toBeGreaterThan(1);

    expect(benchCloudflareAccount('account-a:token-one', DAILY, HOUR, 'authoritative')).toBe(models.length * 2);

    for (const m of models) {
      expect(isOnCooldown('cloudflare', m, a1)).toBe(true);
      expect(isOnCooldown('cloudflare', m, a2)).toBe(true);
      expect(isOnCooldown('cloudflare', m, b1)).toBe(false);
    }
  });

  it('ignores transient 429s and other errors', () => {
    const a2 = insertKey('account-a:token-two');
    expect(benchCloudflareAccount('account-a:token-one', { status: 429, message: 'Too Many Requests' }, HOUR, 'heuristic')).toBe(0);
    expect(benchCloudflareAccount('account-a:token-one', { status: 500, message: NEURONS_MSG }, HOUR, 'heuristic')).toBe(0);
    expect(getActiveCooldownsForKeys([a2]).get(a2) ?? []).toEqual([]);
  });

  it('uses the duration it is given, shows on the key, and Clear cooldowns lifts it', () => {
    const a2 = insertKey('account-a:token-two');
    const before = Date.now();
    benchCloudflareAccount('account-a:token-one', DAILY, HOUR, 'authoritative');

    const active = getActiveCooldownsForKeys([a2]).get(a2) ?? [];
    expect(active.length).toBe(cloudflareModels().length);
    for (const c of active) {
      expect(c.expiresAtMs).toBeGreaterThanOrEqual(before + HOUR);
      expect(c.expiresAtMs).toBeLessThanOrEqual(Date.now() + HOUR);
    }

    expect(clearCooldownsForKey(a2)).toBe(active.length);
    expect(getActiveCooldownsForKeys([a2]).get(a2) ?? []).toEqual([]);
  });
});

describe('Cloudflare account bench through /v1/chat/completions', () => {
  let app: Express;

  async function post(body: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: json };
  }

  beforeAll(() => {
    app = createApp();
  });

  it('a neurons 429 on account A benches all of A and the request is served by account B', async () => {
    const a1 = insertKey('account-a:token-one');
    const a2 = insertKey('account-a:token-two');
    const b1 = insertKey('account-b:token-three');
    const model = cloudflareModels()[0];
    const realFetch = globalThis.fetch;
    const upstream: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.cloudflare.com/')) return realFetch(input, init);
      upstream.push(url);
      if (url.includes('/accounts/account-a/')) {
        return new Response(JSON.stringify({ errors: [{ message: 'you have used up your daily free allocation of 10,000 neurons' }] }), { status: 429 });
      }
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'from account b' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const { status, body } = await post({ model, messages: [{ role: 'user', content: 'hi' }] });
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('from account b');
    // Account A was tried exactly once: its sibling token was benched with it.
    expect(upstream.filter(u => u.includes('/accounts/account-a/'))).toHaveLength(1);

    for (const m of cloudflareModels()) {
      expect(isOnCooldown('cloudflare', m, a1)).toBe(true);
      expect(isOnCooldown('cloudflare', m, a2)).toBe(true);
      expect(isOnCooldown('cloudflare', m, b1)).toBe(false);
    }
  });
});
