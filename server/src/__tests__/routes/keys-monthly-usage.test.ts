import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('GET /api/keys monthly budget usage', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('exposes caps, current-month usage and the reset timestamp per key', async () => {
    const created = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_usage_test_key_123456',
    });
    expect(created.status).toBe(201);
    const keyId = created.body.id as number;
    const patched = await request(app, 'PATCH', `/api/keys/${keyId}`, {
      monthlyRequestCap: 1000,
      monthlyTokenCap: 500000,
    });
    expect(patched.status).toBe(200);

    // One successful request this month → the durable usage ledger (trigger)
    // must show up alongside the caps.
    getDb().prepare(
      `INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
       VALUES ('groq', 'llama-3.3-70b', ?, 'success', 120, 80, 42)`,
    ).run(keyId);

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    const row = body.find((k: { id: number }) => k.id === keyId);
    expect(row.monthlyRequestCap).toBe(1000);
    expect(row.monthlyTokenCap).toBe(500000);
    expect(row.monthlyUsage.requests).toBe(1);
    expect(row.monthlyUsage.tokens).toBe(200);
    // ISO timestamp of the next UTC month boundary.
    const resets = Date.parse(row.monthlyUsage.resetsAt);
    expect(Number.isFinite(resets)).toBe(true);
    const d = new Date(resets);
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  it('reports zero usage for a key with no traffic and unlimited caps', async () => {
    const created = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_usage_test_key_654321',
    });
    const { body } = await request(app, 'GET', '/api/keys');
    const row = body.find((k: { id: number }) => k.id === created.body.id);
    expect(row.monthlyRequestCap).toBe(0);
    expect(row.monthlyTokenCap).toBe(0);
    expect(row.monthlyUsage.requests).toBe(0);
    expect(row.monthlyUsage.tokens).toBe(0);
  });

  it('ignores failed requests in the usage counters', async () => {
    const created = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_usage_test_key_failed',
    });
    getDb().prepare(
      `INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
       VALUES ('groq', 'llama-3.3-70b', ?, 'error', 0, 0, 10)`,
    ).run(created.body.id);
    const { body } = await request(app, 'GET', '/api/keys');
    const row = body.find((k: { id: number }) => k.id === created.body.id);
    expect(row.monthlyUsage.requests).toBe(0);
  });
});
