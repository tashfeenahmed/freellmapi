import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { HEADROOM_RAMP_START_KEY, HEADROOM_FLOOR_KEY } from '../../services/router.js';

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

// GET/PUT /api/settings/headroom (#899): tunable proactive-demotion thresholds
// for the free-quota headroom guardrail.
describe('/api/settings/headroom', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports nulls (scoring.ts defaults) before anything is configured', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/headroom', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ rampStart: null, floor: null });
  });

  it('stores and returns the configured thresholds', async () => {
    const put = await request(app, 'PUT', '/api/settings/headroom', { rampStart: 0.5, floor: 0.3 }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ rampStart: 0.5, floor: 0.3 });
    expect(getSetting(HEADROOM_RAMP_START_KEY)).toBe('0.5');
    expect(getSetting(HEADROOM_FLOOR_KEY)).toBe('0.3');

    const get = await request(app, 'GET', '/api/settings/headroom', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('supports partial updates, leaving the other threshold untouched', async () => {
    await request(app, 'PUT', '/api/settings/headroom', { rampStart: 0.5, floor: 0.3 }, token);
    const put = await request(app, 'PUT', '/api/settings/headroom', { rampStart: 0.6 }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ rampStart: 0.6, floor: 0.3 });
  });

  it('null clears a threshold back to the default', async () => {
    await request(app, 'PUT', '/api/settings/headroom', { rampStart: 0.5, floor: 0.3 }, token);
    const put = await request(app, 'PUT', '/api/settings/headroom', { floor: null }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ rampStart: 0.5, floor: null });
    expect(getSetting(HEADROOM_FLOOR_KEY)).toBeUndefined();
  });

  const rejected: Array<[string, any]> = [
    ['an out-of-range rampStart', { rampStart: 1.5 }],
    ['a negative rampStart', { rampStart: -0.1 }],
    ['an out-of-range floor', { floor: 2 }],
    ['a string instead of a number', { rampStart: '0.5' }],
  ];

  for (const [label, payload] of rejected) {
    it(`rejects ${label} with a 400 and leaves the settings untouched`, async () => {
      await request(app, 'PUT', '/api/settings/headroom', { rampStart: 0.5, floor: 0.3 }, token);
      const { status, body } = await request(app, 'PUT', '/api/settings/headroom', payload, token);
      expect(status).toBe(400);
      expect(body.error.type).toBe('invalid_request_error');
      expect(getSetting(HEADROOM_RAMP_START_KEY)).toBe('0.5');
      expect(getSetting(HEADROOM_FLOOR_KEY)).toBe('0.3');
    });
  }
});
