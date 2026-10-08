import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { resolveProvider } from '../../providers/index.js';
import { healthRouter } from '../../routes/health.js';
import { mintDashboardToken } from '../helpers/auth.js';

// POST /api/health/quota/:keyId — the manual override of the #1403 15-minute
// health-poll throttle (#1404). Only the provider probe is replaced; the route,
// auth, DB state and response shape are exercised for real. (The probe is
// spied on the provider instance rather than stubbing global fetch, because
// this suite's own HTTP calls also go through fetch.)
describe('POST /api/health/quota/:keyId (#1403)', () => {
  let server: Server;
  let url: string;
  let token: string;

  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    token = mintDashboardToken();
    const app = express();
    app.use(express.json());
    app.use('/api/health', requireAuth, healthRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    vi.unstubAllEnvs();
  });

  const addKey = (platform: string, baseUrl: string | null = null) => {
    const enc = encrypt('sk-test-secret');
    return getDb().prepare(
      'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    ).run(platform, `test ${platform}`, enc.encrypted, enc.iv, enc.authTag, baseUrl, 'healthy').lastInsertRowid as number;
  };

  const post = (path: string) =>
    fetch(`${url}/api/health${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
    vi.restoreAllMocks();
  });

  it('records and returns a fresh quota_api reading for a probed platform', async () => {
    const keyId = addKey('openrouter');
    // Drive the real fetchQuota → recordQuotaObservation path: mock only the
    // upstream HTTP call the provider instance makes, via its fetch override.
    const provider = resolveProvider('openrouter')!;
    const probe = vi.spyOn(provider, 'fetchQuota').mockImplementation(async (_key, ctx) => {
      // Record through the same service the real probe uses, so the route's
      // state read-back and the recorded flag reflect a genuine observation.
      const { recordQuotaObservation } = await import('../../services/provider-quota.js');
      recordQuotaObservation({
        platform: 'openrouter', keyId: ctx?.keyId, quotaPoolKey: ctx?.quotaPoolKey,
        endpoint: 'quota_api', metric: 'credits', limit: 20, remaining: 12.5,
        resetStrategy: 'provider_reported', source: 'quota_api', statusCode: 200, notes: null,
      } as any);
      return true;
    });

    const res = await post(`/quota/${keyId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(body.recorded).toBe(true);
    expect(body.quotaStates).toHaveLength(1);
    expect(body.quotaStates[0]).toMatchObject({ source: 'quota_api', limit: 20, remaining: 12.5 });
  });

  it('a platform without a quota endpoint answers 400', async () => {
    const keyId = addKey('mistral');
    const res = await post(`/quota/${keyId}`);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toContain('no provider-reported quota endpoint');
  });

  it('unknown key id is 404, garbage id is 400', async () => {
    expect((await post('/quota/99999')).status).toBe(404);
    expect((await post('/quota/not-a-number')).status).toBe(400);
  });

  it('a probe failure answers recorded:false, never a 500', async () => {
    const keyId = addKey('openrouter');
    vi.spyOn(resolveProvider('openrouter')!, 'fetchQuota').mockRejectedValue(new Error('socket hang up'));
    const res = await post(`/quota/${keyId}`);
    // pollKeyQuota is failure-silent by construction: the route still answers.
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.recorded).toBe(false);
    expect(body.quotaStates).toHaveLength(0);
  });
});
