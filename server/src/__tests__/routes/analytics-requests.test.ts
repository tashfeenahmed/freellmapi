import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

function insertCall(createdAt: string, clientIp: string | null, clientUserAgent: string | null, status = 'success') {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at, client_ip, client_user_agent)
    VALUES ('test', 'test-model', ?, 10, 5, 42, NULL, ?, ?, ?)
  `).run(status, createdAt, clientIp, clientUserAgent);
}

describe('GET /api/analytics/requests', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
  });

  it('returns one row per call, newest first, with caller identity', async () => {
    insertCall('2026-07-06 10:00:00', '192.168.0.3', 'curl/8.6.0');
    insertCall('2026-07-06 11:00:00', '192.168.0.15', 'python-httpx/0.27');
    insertCall('2026-07-06 12:00:00', null, null);

    const { status, body } = await request(app, '/api/analytics/requests?range=7d');
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.rows.map((r: any) => r.clientIp)).toEqual([null, '192.168.0.15', '192.168.0.3']);
    expect(body.rows[1]).toMatchObject({
      platform: 'test',
      modelId: 'test-model',
      status: 'success',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 42,
      clientIp: '192.168.0.15',
      clientUserAgent: 'python-httpx/0.27',
    });
    // created_at is emitted as ISO-8601 UTC so the dashboard localizes it.
    expect(body.rows[1].createdAt).toBe('2026-07-06T11:00:00Z');
  });

  it('paginates with limit/offset and clamps limit to 500', async () => {
    for (let i = 0; i < 5; i++) insertCall(`2026-07-06 0${i}:00:00`, '10.0.0.1', 'ua');

    const page = await request(app, '/api/analytics/requests?range=7d&limit=2&offset=2');
    expect(page.body.total).toBe(5);
    expect(page.body.rows).toHaveLength(2);
    expect(page.body.rows[0].createdAt).toBe('2026-07-06T02:00:00Z');

    const clamped = await request(app, '/api/analytics/requests?range=7d&limit=99999');
    expect(clamped.body.rows).toHaveLength(5);
  });

  it('records the request-scoped caller identity through logRequest', async () => {
    const { clientContextMiddleware } = await import('../../lib/client-context.js');
    const req = { headers: { 'user-agent': 'vitest-client/1.0' }, socket: { remoteAddress: '192.168.0.99' } } as any;
    await new Promise<void>(resolve => {
      clientContextMiddleware(req, {} as any, () => {
        logRequest('test', 'test-model', 1, 'success', 1, 2, 3, null);
        resolve();
      });
    });

    const row = getDb().prepare('SELECT client_ip, client_user_agent FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row).toEqual({ client_ip: '192.168.0.99', client_user_agent: 'vitest-client/1.0' });
  });
});
