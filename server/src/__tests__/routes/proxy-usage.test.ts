import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { hashClientProfileKey } from '../../lib/system-prompt.js';

// GET /v1/usage (#1568): OpenRouter (GET /api/v1/auth/key) and LiteLLM
// (/key/info) let a key-holder see its own consumption; until now the only
// way to answer "what ate my tokens" was opening the dashboard. The payload
// must come from key_monthly_usage — the SAME ledger the monthly caps enforce
// — so the numbers can never disagree with a 429 the client just got.

let server: Server;
let baseUrl: string;
let token: string;
const PROFILE_TOKEN = 'sk-cp-' + 'a'.repeat(48);

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  const secret = encrypt('synthetic-usage-test-key');
  const keyId = Number(db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
    VALUES ('groq', 'usage-test', ?, ?, ?, 1, 'healthy')`).run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
  const model = (db.prepare("SELECT model_id FROM models WHERE platform = 'groq' LIMIT 1").get() as { model_id: string }).model_id;
  // Two successes (counted) and one error (never counted) via the ledger trigger.
  db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
    VALUES ('groq', ?, ?, 'success', 100, 40, 1)`).run(model, keyId);
  db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
    VALUES ('groq', ?, ?, 'success', 7, 3, 1)`).run(model, keyId);
  db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
    VALUES ('groq', ?, ?, 'error', 9999, 9999, 1)`).run(model, keyId);
  token = getUnifiedApiKey();
  const profileSecret = encrypt(PROFILE_TOKEN);
  db.prepare(`INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled)
    VALUES ('downstream', ?, ?, ?, ?, 1)`).run(hashClientProfileKey(PROFILE_TOKEN), profileSecret.encrypted, profileSecret.iv, profileSecret.authTag);
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));

describe('GET /v1/usage', () => {
  it('reports month-to-date usage from the budget ledger, split by platform', async () => {
    const res = await fetch(`${baseUrl}/v1/usage`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.object).toBe('usage');
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(typeof body.resetsAt).toBe('string');
    // Only the two successes count; the error row never enters the ledger.
    expect(body.requests).toBe(2);
    expect(body.tokens).toBe(150);
    const groq = body.byPlatform.find((p: any) => p.platform === 'groq');
    expect(groq).toBeTruthy();
    expect(groq.requests).toBe(2);
    expect(groq.tokens).toBe(150);
  });

  it('refuses a client-profile key: the ledger is install-wide, not per client', async () => {
    const res = await fetch(`${baseUrl}/v1/usage`, { headers: { Authorization: `Bearer ${PROFILE_TOKEN}` } });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.requests).toBeUndefined();
  });

  it('breaks usage down per provider key with its monthly caps (#1568 follow-up)', async () => {
    // A second key WITH caps, plus spend, so the response must show both keys
    // separately and echo the caps exactly as checkMonthlyBudget enforces them.
    const db = getDb();
    const secret = encrypt('synthetic-capped-key');
    const keyId = Number(db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status, monthly_request_cap, monthly_token_cap)
      VALUES ('openrouter', 'capped', ?, ?, ?, 1, 'healthy', 100, 250000)`).run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
    const model = (db.prepare("SELECT model_id FROM models WHERE platform = 'openrouter' LIMIT 1").get() as { model_id: string }).model_id;
    db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
      VALUES ('openrouter', ?, ?, 'success', 50, 10, 1)`).run(model, keyId);

    const res = await fetch(`${baseUrl}/v1/usage`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const capped = body.byKey.find((k: any) => k.keyId === keyId);
    expect(capped).toBeTruthy();
    expect(capped.platform).toBe('openrouter');
    expect(capped.label).toBe('capped');
    expect(capped.enabled).toBe(true);
    expect(capped.requests).toBe(1);
    expect(capped.tokens).toBe(60);
    expect(capped.requestCap).toBe(100);
    expect(capped.tokenCap).toBe(250000);
    // The uncapped groq key reports null caps, not 0 (0 would read as "cap of zero").
    const uncapped = body.byKey.find((k: any) => k.platform === 'groq');
    expect(uncapped.requestCap).toBeNull();
    expect(uncapped.tokenCap).toBeNull();
    // byKey sums to the same totals as byPlatform.
    const sum = body.byKey.reduce((acc: number, k: any) => acc + k.tokens, 0);
    expect(sum).toBe(body.tokens);
  });

  it('rejects a missing or bogus key like every other /v1 route', async () => {
    const anonymous = await fetch(`${baseUrl}/v1/usage`);
    expect(anonymous.status).toBe(401);
    const bogus = await fetch(`${baseUrl}/v1/usage`, { headers: { Authorization: 'Bearer ***' } });
    expect(bogus.status).toBe(401);
  });
});
