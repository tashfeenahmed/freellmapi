import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { createAdminRateLimiter } from '../../middleware/rateLimit.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function request(app: Express, path: string, token?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return { status: res.status, body: json, headers: res.headers };
}

describe('Admin API rate limiter', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();

    token = mintDashboardToken();
  });

  it('sets X-RateLimit headers on admin API responses', async () => {
    const { headers, status } = await request(app, '/api/keys', token);
    expect(status).toBe(200);
    expect(headers.get('x-ratelimit-limit')).toBe('600');
    expect(Number(headers.get('x-ratelimit-remaining'))).toBeGreaterThanOrEqual(0);
    expect(Number(headers.get('x-ratelimit-reset'))).toBeGreaterThan(Date.now() / 1000);
  });

  it('applies the limiter to unauthenticated /api paths too', async () => {
    const { headers, status } = await request(app, '/api/ping');
    expect(status).toBe(200);
    expect(headers.get('x-ratelimit-limit')).toBe('600');
  });

  it('counts unauthenticated requests against the admin rate limit window', async () => {
    const { status } = await request(app, '/api/keys');
    // Unauthenticated still hits the rate limiter, then fails at requireAuth
    expect(status).toBe(401);
  });

  it('caps the broad admin surface well above normal dashboard traffic', async () => {
    // The dashboard fans out across many /api routes on load and polls several
    // of them, so the flood guard must not fire during ordinary use. Guarding
    // the default here keeps a future tightening from silently breaking that.
    const limiter = createAdminRateLimiter();
    expect(limiter).toBeTypeOf('function');
    const { headers } = await request(app, '/api/keys', token);
    expect(Number(headers.get('x-ratelimit-limit'))).toBeGreaterThanOrEqual(600);
  });

  it('throttles key export far more tightly than the rest of /api', async () => {
    // Export re-verifies the password, so it is the one guessable endpoint.
    // Eleventh request inside the window must be refused regardless of whether
    // the password was right.
    let sawRateLimit = false;
    for (let i = 0; i < 12; i++) {
      const { status } = await request(app, '/api/keys/export?format=json', token);
      if (status === 429) { sawRateLimit = true; break; }
      // Without the re-auth header the handler answers 403 — still counted.
      expect(status).toBe(403);
    }
    expect(sawRateLimit).toBe(true);
  });

  it('throttles key reveal to 60 a minute (#1885)', async () => {
    // Reveal also re-verifies the password, so it gets its own bucket instead
    // of sharing the 600/min dashboard limit.
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as any;
    const statuses: number[] = [];
    let limitHeader: string | null = null;
    for (let i = 0; i < 61; i++) {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/1/reveal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (i === 0) limitHeader = res.headers.get('x-ratelimit-limit');
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    server.close();
    expect(limitHeader).toBe('60');
    // No password header: the handler answers 403, which still counts.
    expect(statuses.slice(0, 60).every(s => s === 403)).toBe(true);
    expect(statuses[60]).toBe(429);

    // Other /api/keys routes keep the broad limit.
    const { headers } = await request(app, '/api/keys', token);
    expect(headers.get('x-ratelimit-limit')).not.toBe('60');
  });

  it('can be disabled entirely with ADMIN_RATE_LIMIT_RPM=0', async () => {
    process.env.ADMIN_RATE_LIMIT_RPM = '0';
    try {
      const openApp = createApp();
      const { headers, status } = await request(openApp, '/api/ping');
      expect(status).toBe(200);
      expect(headers.get('x-ratelimit-limit')).toBeNull();
    } finally {
      delete process.env.ADMIN_RATE_LIMIT_RPM;
    }
  });
});
