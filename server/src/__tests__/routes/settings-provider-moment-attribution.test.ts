import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { PROVIDER_MOMENT_ATTRIBUTION_KEY } from '../../services/router.js';

// #1347 (PR 1): GET/PUT /api/settings/provider-moment-attribution — the
// dashboard toggle for rate-limit-aware failure attribution. Off by default;
// the ROUTER_PROVIDER_MOMENT_ATTRIBUTION env var pins the behaviour.
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

describe('/api/settings/provider-moment-attribution (#1347 PR 1)', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(PROVIDER_MOMENT_ATTRIBUTION_KEY);
  });

  afterEach(() => {
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
  });

  it('reports disabled (off by default) before anything is configured', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/provider-moment-attribution', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false });
  });

  it('enables and reports the toggle', async () => {
    const put = await request(app, 'PUT', '/api/settings/provider-moment-attribution', { enabled: true }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: true });
    expect(getSetting(PROVIDER_MOMENT_ATTRIBUTION_KEY)).toBe('1');

    const get = await request(app, 'GET', '/api/settings/provider-moment-attribution', undefined, token);
    expect(get.body).toEqual({ enabled: true });
  });

  it('disables again and clears the stored setting', async () => {
    await request(app, 'PUT', '/api/settings/provider-moment-attribution', { enabled: true }, token);
    const put = await request(app, 'PUT', '/api/settings/provider-moment-attribution', { enabled: false }, token);
    expect(put.body).toEqual({ enabled: false });
    expect(getSetting(PROVIDER_MOMENT_ATTRIBUTION_KEY)).toBeUndefined();
  });

  it('rejects a non-boolean body', async () => {
    const { status } = await request(app, 'PUT', '/api/settings/provider-moment-attribution', { enabled: 'yes' }, token);
    expect(status).toBe(400);
  });

  it('the env var pins the behaviour over the stored setting', async () => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '1';
    await request(app, 'PUT', '/api/settings/provider-moment-attribution', { enabled: false }, token);
    const get = await request(app, 'GET', '/api/settings/provider-moment-attribution', undefined, token);
    expect(get.body).toEqual({ enabled: true });

    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '0';
    const put = await request(app, 'PUT', '/api/settings/provider-moment-attribution', { enabled: true }, token);
    expect(put.body).toEqual({ enabled: false });
  });
});
