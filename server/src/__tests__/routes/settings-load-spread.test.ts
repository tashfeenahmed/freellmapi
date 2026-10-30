import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { LOAD_SPREAD_KEY } from '../../services/router.js';

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

// GET/PUT /api/settings/load-spread: how strongly in-flight requests push new
// ones to the next model in the chain.
describe('/api/settings/load-spread', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports 0 (disabled) before anything is configured', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/load-spread', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ spread: 0 });
  });

  it('stores and returns the configured strength', async () => {
    const put = await request(app, 'PUT', '/api/settings/load-spread', { spread: 0.5 }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ spread: 0.5 });
    expect(getSetting(LOAD_SPREAD_KEY)).toBe('0.5');

    const get = await request(app, 'GET', '/api/settings/load-spread', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('clears back to disabled with null', async () => {
    await request(app, 'PUT', '/api/settings/load-spread', { spread: 0.5 }, token);
    const put = await request(app, 'PUT', '/api/settings/load-spread', { spread: null }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ spread: 0 });
    expect(getSetting(LOAD_SPREAD_KEY)).toBeUndefined();
  });

  it('rejects an out-of-range or missing strength', async () => {
    expect((await request(app, 'PUT', '/api/settings/load-spread', { spread: 1.5 }, token)).status).toBe(400);
    expect((await request(app, 'PUT', '/api/settings/load-spread', {}, token)).status).toBe(400);
  });
});
