import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getAllProviders } from '../../providers/index.js';
import { recordQuotaObservation } from '../../services/provider-quota.js';
import { providerState } from '../../routes/providers.js';
import { mintDashboardToken } from '../helpers/auth.js';

// GET /api/providers: dashboard-authenticated, read-only, and free of secrets.

// Key-shaped fixtures built at runtime so no literal secret sits in the source.
const GOOGLE_KEY = 'AIza' + 'Q'.repeat(35);
const CUSTOM_KEY = 'sk-custom-' + 'z'.repeat(24);
const CUSTOM_URL_SECRET = 'urlpass' + 'w'.repeat(12);
const HEALTH_ERROR_SECRET = 'sk-' + 'h'.repeat(40);

let app: Express;
let dashToken = '';

async function get(path: string, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
  const { port } = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  server.close();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
}

function insertKey(platform: string, key: string, opts: { status?: string; enabled?: number; baseUrl?: string; error?: string } = {}): number {
  const { encrypted, iv, authTag } = encrypt(key);
  const r = getDb().prepare(
    'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, last_health_error, last_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(platform, `${platform}-key`, encrypted, iv, authTag, opts.status ?? 'healthy', opts.enabled ?? 1, opts.baseUrl ?? null, opts.error ?? null, '2026-10-28 12:00:00');
  return Number(r.lastInsertRowid);
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
});

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM requests').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
});

describe('GET /api/providers', () => {
  it('requires a dashboard session; the unified proxy key is not enough', async () => {
    expect((await get('/api/providers')).status).toBe(401);
    expect((await get('/api/providers', { Authorization: `Bearer ${getUnifiedApiKey()}` })).status).toBe(401);
    expect((await get('/api/providers', { Authorization: `Bearer ${dashToken}` })).status).toBe(200);
  });

  it('lists every registered provider with metadata and verification status', async () => {
    const { body } = await get('/api/providers', { Authorization: `Bearer ${dashToken}` });
    const platforms = body.providers.map((p: any) => p.platform).sort();
    expect(platforms).toEqual(getAllProviders().map(p => p.platform).sort());
    for (const p of body.providers) {
      expect(p.verification.status).not.toBe('officially-verified');
      expect(p.verification.verifiedOn).toBeNull();
      expect(p.metadata.officialDocsVerifiedOn).toBeNull();
    }
    expect(body.freeOnly.enabled).toBe(true);
  });

  it('reports state, models and free-only eligibility per provider', async () => {
    insertKey('google', GOOGLE_KEY);
    insertKey('groq', 'gsk_' + 'g'.repeat(30), { status: 'invalid' });
    insertKey('cerebras', 'csk-' + 'c'.repeat(30), { enabled: 0 });
    const { body } = await get('/api/providers', { Authorization: `Bearer ${dashToken}` });
    const by = (id: string) => body.providers.find((p: any) => p.platform === id);

    expect(by('google').state).toBe('connected');
    expect(by('groq').state).toBe('unhealthy');
    expect(by('cerebras').state).toBe('disabled');
    expect(by('mistral').state).toBe('unconfigured');
    expect(by('google').credentialsRequired).toBe(true);
    expect(by('kilo').credentialsRequired).toBe(false);

    const google = by('google');
    expect(google.models.enabled).toBeGreaterThan(0);
    expect(google.automaticRouting.eligible).toBe(true);
    const flash = google.models.items.find((m: any) => m.id === 'gemini-3.5-flash');
    expect(flash).toMatchObject({ freeStatus: 'free', automatic: true });

    expect(by('cohere').automaticRouting).toMatchObject({ eligible: false });
    expect(by('cohere').automaticRouting.reason).toMatch(/trial/);
  });

  it('never returns key material, ciphertext, custom base URLs or unredacted error text', async () => {
    insertKey('google', GOOGLE_KEY, { error: `upstream said: invalid key ${HEALTH_ERROR_SECRET}` });
    insertKey('custom', CUSTOM_KEY, { baseUrl: `https://user:${CUSTOM_URL_SECRET}@llm.example.test/v1` });
    const { text, body } = await get('/api/providers', { Authorization: `Bearer ${dashToken}` });
    for (const secret of [GOOGLE_KEY, CUSTOM_KEY, CUSTOM_URL_SECRET, HEALTH_ERROR_SECRET, 'llm.example.test']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/encrypted_key|auth_tag|"iv"|base_url|baseUrl|proxy_/);
    const key = body.providers.find((p: any) => p.platform === 'google').keys.items[0];
    expect(Object.keys(key).sort()).toEqual(['enabled', 'id', 'label', 'lastCheckedAt', 'lastHealthError', 'lastHealthyAt', 'status']);
  });

  it('only reports quota the provider itself stated', async () => {
    const keyId = insertKey('google', GOOGLE_KEY);
    recordQuotaObservation({ platform: 'google', keyId, metric: 'requests', limit: 20, remaining: 7, source: 'header' });
    recordQuotaObservation({ platform: 'google', keyId, metric: 'tokens', limit: 250000, remaining: 9, source: 'documentation' });
    recordQuotaObservation({ platform: 'google', keyId, metric: 'tokens', limit: 99, remaining: 1, source: 'local_usage', quotaPoolKey: 'x' });
    const { body } = await get('/api/providers', { Authorization: `Bearer ${dashToken}` });
    const quota = body.providers.find((p: any) => p.platform === 'google').providerReportedQuota;
    expect(quota.every((q: any) => ['header', 'quota_api'].includes(q.source))).toBe(true);
    expect(quota.some((q: any) => q.remaining === 7)).toBe(true);
    expect(body.notes.join(' ')).toMatch(/says nothing about remaining quota/);
  });

  it('summarizes the last 24h of traffic and active cooldowns', async () => {
    const db = getDb();
    const keyId = insertKey('google', GOOGLE_KEY);
    const ins = db.prepare("INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, created_at) VALUES ('google', 'gemini-3.5-flash', ?, ?, 1, 1, ?, ?, ?)");
    ins.run(keyId, 'success', 3000, 900, new Date().toISOString().replace('T', ' ').slice(0, 19));
    ins.run(keyId, 'error', 100, null, new Date().toISOString().replace('T', ' ').slice(0, 19));
    ins.run(keyId, 'success', 99999, 1, '2020-01-01 00:00:00'); // outside the window
    db.prepare("INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms) VALUES ('google', 'gemini-3.5-flash', ?, ?)").run(keyId, Date.now() + 60_000);
    const { body } = await get('/api/providers', { Authorization: `Bearer ${dashToken}` });
    const google = body.providers.find((p: any) => p.platform === 'google');
    expect(google.traffic24h).toEqual({ requests: 2, successRate: 0.5, avgLatencyMs: 3000, avgTtfbMs: 900 });
    expect(google.cooldowns.active).toBe(1);
    expect(typeof google.cooldowns.soonestExpiresAt).toBe('string');
  });
});

describe('providerState', () => {
  it.each([
    [[], 'unconfigured'],
    [[{ status: 'healthy', enabled: 0 }], 'disabled'],
    [[{ status: 'invalid', enabled: 1 }, { status: 'error', enabled: 1 }], 'unhealthy'],
    [[{ status: 'invalid', enabled: 1 }, { status: 'unknown', enabled: 1 }], 'connected'],
  ])('%j → %s', (keys, expected) => {
    expect(providerState(keys as any)).toBe(expected);
  });
});
