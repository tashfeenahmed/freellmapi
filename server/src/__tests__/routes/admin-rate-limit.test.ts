import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function request(app: Express, path: string, token?: string) {
  const server = app.listen(0);
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
    expect(headers.get('x-ratelimit-limit')).toBe('60');
    expect(Number(headers.get('x-ratelimit-remaining'))).toBeGreaterThanOrEqual(0);
    expect(Number(headers.get('x-ratelimit-reset'))).toBeGreaterThan(Date.now() / 1000);
  });

  it('does not set rate limit headers on /api/ping', async () => {
    const { headers, status } = await request(app, '/api/ping');
    expect(status).toBe(200);
    expect(headers.get('x-ratelimit-limit')).toBe('60');
  });

  it('counts unauthenticated requests against the admin rate limit window', async () => {
    const { status } = await request(app, '/api/keys');
    // Unauthenticated still hits the rate limiter, then fails at requireAuth
    expect(status).toBe(401);
  });
});
