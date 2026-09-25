import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { reloadRoutingRegistry } from '../../services/router-registry.js';

async function request(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, { method, headers });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function insertHealthyKey(platform: string) {
  const secret = encrypt(`${platform}-test-key`);
  const pool = getDb();
  const providerRes = await pool.query('SELECT id FROM providers WHERE provider_key = $1', [platform]);
  let providerId = providerRes.rows[0]?.id;
  if (!providerId) {
    const newProv = await pool.query('INSERT INTO providers (provider_key, name, enabled) VALUES ($1, $1, true) RETURNING id', [platform]);
    providerId = newProv.rows[0].id;
  }
  await pool.query(`
    INSERT INTO credentials (provider_id, label, encrypted_key, iv, auth_tag, circuit_state, enabled)
    VALUES ($1, 'test', $2, $3, $4, 'HEALTHY', true)
  `, [providerId, secret.encrypted, secret.iv, secret.authTag]);
  await reloadRoutingRegistry();
}

// These tests share one in-memory DB and run top-to-bottom: the "no upstreams"
// assertions must precede the key insert.
describe('status & interop endpoints (#433)', () => {
  let app: Express;
  let unifiedKey = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    app = createApp();
    unifiedKey = getUnifiedApiKey();
  });

  it('GET /livez returns 200 with status, version, and uptime', async () => {
    const { status, body } = await request(app, 'GET', '/livez');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime_s).toBe('number');
  });

  it('GET /readyz returns 503 no_upstreams_configured when nothing is set up', async () => {
    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(503);
    expect(body.reason).toBe('no_upstreams_configured');
  });

  it('GET /v1/providers rejects a missing/invalid key with 401', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers');
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('GET /v1/providers returns empty providers and zero counts before any key', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers', {
      Authorization: `Bearer ${unifiedKey}`,
    });
    expect(status).toBe(200);
    expect(body.providers).toEqual([]);
    expect(body.counts).toEqual({ healthy: 0, rate_limited: 0, invalid: 0, unknown: 0 });
  });

  it('GET /readyz returns 200 once a healthy upstream exists', async () => {
    await insertHealthyKey('groq');
    const { status, body } = await request(app, 'GET', '/readyz');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.ready_upstreams).toBeGreaterThanOrEqual(1);
  });

  it('GET /v1/providers reports the healthy upstream', async () => {
    const { status, body } = await request(app, 'GET', '/v1/providers', {
      'x-api-key': unifiedKey,
    });
    expect(status).toBe(200);
    const groq = body.providers.find((p: { platform: string }) => p.platform === 'groq');
    expect(groq).toBeDefined();
    expect(groq.status).toBe('healthy');
    expect(groq.keys).toBe(1);
    expect(body.counts.healthy).toBeGreaterThanOrEqual(1);
  });

  it('GET /v1/models?ready=true filters to servable models (auth required)', async () => {
    const unauth = await request(app, 'GET', '/v1/models?ready=true');
    expect(unauth.status).toBe(401);

    const full = await request(app, 'GET', '/v1/models', { 'x-api-key': unifiedKey });
    const ready = await request(app, 'GET', '/v1/models?ready=true', { 'x-api-key': unifiedKey });
    expect(ready.status).toBe(200);
    expect(ready.body.object).toBe('list');
    // Every non-virtual model in the filtered list is actually available, and the
    // filter never returns more than the unfiltered catalog.
    const realModels = ready.body.data.filter((m: { id: string }) => m.id !== 'auto' && m.id !== 'fusion');
    for (const m of realModels) expect(m.available).toBe(true);
    expect(ready.body.data.length).toBeLessThanOrEqual(full.body.data.length);
  });
});
