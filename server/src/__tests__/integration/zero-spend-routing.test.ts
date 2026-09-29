import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { keyFingerprint, ZeroSpendError } from '../../lib/zero-spend.js';
import { routeRequest, routePinnedModel, getAllPenalties, setRoutingStrategy } from '../../services/router.js';
import { checkMonthlyBudget, setMonthlyBudgetCaps } from '../../services/key-budget.js';
import { isOnCooldown } from '../../services/ratelimit.js';
import { runFusion, FusionError } from '../../services/fusion.js';

const fakeKey = 'fake-policy-routing-key';
const nativeFetch = globalThis.fetch;
let dir: string, file: string, base: string, server: Server;
let model: { id: number; model_id: string };
let keyId: number, providerDispatches: number;

function seed(platform: string, credential: string) {
  const { encrypted, iv, authTag } = encrypt(credential);
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, 'healthy', 1)",
  ).run(platform, encrypted, iv, authTag).lastInsertRowid);
}
function approve() {
  writeFileSync(file, JSON.stringify({ version: 1, entries: [{
    platform: 'groq', model: model.model_id, keySha256: keyFingerprint(fakeKey), enabled: true,
    price: 'verified_zero', accountPlan: 'free', overage: 'blocked',
    verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    source: 'https://console.groq.com/docs/billing-faqs', accountEvidence: 'synthetic test only',
    purposes: ['research'], privacy: 'public-only',
  }] }));
}
async function post(path: string, body: unknown) {
  return fetch(base + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getUnifiedApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zero-spend-routing-'));
  file = join(dir, 'synthetic-evidence.json');
  vi.stubEnv('STRICT_ZERO_SPEND', 'true');
  vi.stubEnv('PROVIDER_EVIDENCE_FILE', file);
  vi.stubEnv('FREEAPI_USAGE_PURPOSE', 'research');
  vi.stubEnv('FREEAPI_DATA_CLASS', 'public');
  getDb().prepare('DELETE FROM api_keys').run();
  getDb().prepare('DELETE FROM requests').run();
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  setRoutingStrategy('priority');
  model = getDb().prepare("SELECT id, model_id FROM models WHERE platform='groq' AND enabled=1 LIMIT 1").get() as typeof model;
  keyId = seed('groq', fakeKey);
  providerDispatches = 0;
  // HTTP exercises the actual gateway on loopback. Any missed policy check
  // would reach this stub, increment the counter and fail without real I/O.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return nativeFetch(input, init);
    providerDispatches++;
    throw new Error('Unexpected provider dispatch in synthetic integration test');
  }));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (dirname(dir) !== tmpdir()) throw new Error('Unexpected test directory');
  rmSync(dir, { recursive: true, force: true });
});

describe('opt-in outbound policy and current router', () => {
  it('excludes healthy keys without evidence', () => {
    expect(routePinnedModel(model.id, 32)).toBeNull();
    expect(() => routeRequest()).toThrow(/exhausted/i);
    expect(checkMonthlyBudget(keyId, 32).allowed).toBe(true);
    expect(providerDispatches).toBe(0);
  });
  it('selects the approved credential/model over a higher-priority unapproved provider', () => {
    seed('google', 'other-fake-key');
    approve();
    const route = routeRequest();
    try {
      expect(route.platform).toBe('groq');
      expect(route.modelId).toBe(model.model_id);
      expect(route.keyId).toBe(keyId);
    } finally { route.release?.(); }
  });
  it('does not reserve monthly budget for a policy-rejected credential', () => {
    approve();
    getDb().prepare('UPDATE api_keys SET enabled=0 WHERE id=?').run(keyId);
    const unapprovedKey = seed('groq', 'different-fake-key');
    setMonthlyBudgetCaps(unapprovedKey, { requestCap: 1 });
    expect(routePinnedModel(model.id, 32)).toBeNull();
    expect(checkMonthlyBudget(unapprovedKey, 32).allowed).toBe(true);
  });
  it('retains monthly request reservations and releases them after an approved route', () => {
    approve();
    setMonthlyBudgetCaps(keyId, { requestCap: 1 });
    const route = routePinnedModel(model.id, 32);
    expect(route).not.toBeNull();
    try {
      expect(checkMonthlyBudget(keyId, 32).allowed).toBe(false);
      expect(routePinnedModel(model.id, 32)).toBeNull();
    } finally { route?.release?.(); }
    expect(checkMonthlyBudget(keyId, 32).allowed).toBe(true);
  });
  it('retains monthly token admission checks with otherwise valid policy evidence', () => {
    approve();
    setMonthlyBudgetCaps(keyId, { tokenCap: 50 });
    expect(routePinnedModel(model.id, 51)).toBeNull();
    const route = routePinnedModel(model.id, 32);
    expect(route).not.toBeNull();
    route?.release?.();
  });
  it('rechecks revoked evidence after selection and before the actual adapter dispatch', async () => {
    approve();
    setMonthlyBudgetCaps(keyId, { requestCap: 1 });
    const route = routePinnedModel(model.id, 32)!;
    writeFileSync(file, JSON.stringify({ version: 1, entries: [] }));
    try {
      await expect(route.provider.chatCompletion(route.apiKey, [{ role: 'user', content: 'synthetic' }], route.modelId)).rejects.toBeInstanceOf(ZeroSpendError);
      expect(providerDispatches).toBe(0);
    } finally { route.release?.(); }
    expect(checkMonthlyBudget(keyId, 32).allowed).toBe(true);
  });
  it.each([false, true])('returns a policy 403 for blocked chat input (stream=%s) without retry or health penalties', async stream => {
    approve();
    setMonthlyBudgetCaps(keyId, { requestCap: 1 });
    const response = await post('/v1/chat/completions', {
      model: model.model_id, stream, max_tokens: 32,
      messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'test.pdf', file_data: 'data:application/pdf;base64,dGVzdA==' } }] }],
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(403);
    expect(result).toMatchObject({ error: { type: 'permission_error', code: 'zero_spend_blocked' } });
    expect(providerDispatches).toBe(0);
    expect(isOnCooldown('groq', model.model_id, keyId)).toBe(false);
    expect(getAllPenalties().some(p => p.modelDbId === model.id)).toBe(false);
    expect(checkMonthlyBudget(keyId, 32).allowed).toBe(true);
    expect(getDb().prepare('SELECT status FROM api_keys WHERE id=?').get(keyId)).toEqual({ status: 'healthy' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM requests WHERE key_id=?').get(keyId)).toEqual({ count: 0 });
  });
  it.each([
    ['/v1/completions', { prompt: 'synthetic text', max_tokens: 32 }],
    ['/v1/responses', { input: 'synthetic text', stream: false }],
    ['/v1/responses', { input: 'synthetic text', stream: true }],
    ['/v1/messages', { max_tokens: 32, messages: [{ role: 'user', content: 'synthetic text' }] }],
    ['/v1/messages', { max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'synthetic text' }] }],
  ])('preserves policy rejection semantics on %s', async (path, body) => {
    approve();
    const route = routePinnedModel(model.id, 32)!;
    route.release?.();
    // Inject the race between selection and transmission, using the real
    // adapter after revocation instead of a made-up HTTP provider response.
    const original = route.provider.chatCompletion.bind(route.provider);
    vi.spyOn(route.provider, 'chatCompletion').mockImplementation(async (...args) => {
      writeFileSync(file, JSON.stringify({ version: 1, entries: [] }));
      return original(...args);
    });
    const originalStream = route.provider.streamChatCompletion.bind(route.provider);
    vi.spyOn(route.provider, 'streamChatCompletion').mockImplementation(async function* (...args) {
      writeFileSync(file, JSON.stringify({ version: 1, entries: [] }));
      yield* originalStream(...args);
    });
    const response = await post(path, { ...body, model: model.model_id });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(403);
    expect(result).toMatchObject({ error: { type: 'permission_error' } });
    expect(providerDispatches).toBe(0);
    expect(isOnCooldown('groq', model.model_id, keyId)).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM requests WHERE key_id=?').get(keyId)).toEqual({ count: 0 });
  });
  it('keeps a policy-rejected fusion panel out of provider analytics and releases budget', async () => {
    approve();
    setMonthlyBudgetCaps(keyId, { requestCap: 1 });
    const onPanel = vi.fn();
    await expect(runFusion({
      messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'test.pdf', file_data: 'data:application/pdf;base64,dGVzdA==' } }] }] as any,
      config: { models: [model.model_id], k: 1, strategy: 'synthesize' },
      options: { max_tokens: 32 },
      estimatedTokens: 32, hooks: { onPanel },
    })).rejects.toBeInstanceOf(FusionError);
    expect(onPanel).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: expect.stringContaining('Zero-spend') }));
    expect(providerDispatches).toBe(0);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM requests WHERE key_id=?').get(keyId)).toEqual({ count: 0 });
    expect(checkMonthlyBudget(keyId, 32).allowed).toBe(true);
    expect(isOnCooldown('groq', model.model_id, keyId)).toBe(false);
  });
});
