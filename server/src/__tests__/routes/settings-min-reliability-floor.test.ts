import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { MIN_RELIABILITY_FLOOR_KEY } from '../../services/router.js';

async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

// GET/PUT /api/settings/min-reliability-floor (#filter): tunable floor that
// drops chronically-failing models from routing.
describe('/api/settings/min-reliability-floor', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports null (disabled) before anything is configured', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/min-reliability-floor', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ floor: null });
  });

  it('stores and returns the configured floor', async () => {
    const put = await request(app, 'PUT', '/api/settings/min-reliability-floor', { floor: 0.8 }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ floor: 0.8 });
    expect(getSetting(MIN_RELIABILITY_FLOOR_KEY)).toBe('0.8');

    const get = await request(app, 'GET', '/api/settings/min-reliability-floor', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('clears the floor back to disabled with null', async () => {
    await request(app, 'PUT', '/api/settings/min-reliability-floor', { floor: 0.8 }, token);
    const put = await request(app, 'PUT', '/api/settings/min-reliability-floor', { floor: null }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ floor: null });
    expect(getSetting(MIN_RELIABILITY_FLOOR_KEY)).toBeUndefined();
  });

  it('rejects an out-of-range floor', async () => {
    const put = await request(app, 'PUT', '/api/settings/min-reliability-floor', { floor: 1.5 }, token);
    expect(put.status).toBe(400);
  });
});
