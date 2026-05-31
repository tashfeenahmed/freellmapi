import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function request(app: Express, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

  const text = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return { status: res.status, body: json, headers: res.headers };
}

describe('Proxy per-IP rate limiting (#35 item #6)', () => {
  const originalRpm = process.env.PROXY_RATE_LIMIT_RPM;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterAll(() => {
    if (originalRpm === undefined) delete process.env.PROXY_RATE_LIMIT_RPM;
    else process.env.PROXY_RATE_LIMIT_RPM = originalRpm;
  });

  it('returns 429 once the per-minute cap is exceeded', async () => {
    // Limiter reads the env at createApp() time, so set it before building.
    process.env.PROXY_RATE_LIMIT_RPM = '3';
    const app = createApp();

    // First 3 requests pass the limiter (they 401 on auth, but the limiter is
    // upstream of auth, so each one still counts against the window).
    for (let i = 0; i < 3; i++) {
      const res = await request(app);
      expect(res.status).not.toBe(429);
    }

    // The 4th trips the limit.
    const limited = await request(app);
    expect(limited.status).toBe(429);
    expect(limited.body.error.type).toBe('rate_limit_error');
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(limited.headers.get('x-ratelimit-limit')).toBe('3');
  });

  it('does not rate-limit when PROXY_RATE_LIMIT_RPM=0', async () => {
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    const app = createApp();

    for (let i = 0; i < 5; i++) {
      const res = await request(app);
      expect(res.status).not.toBe(429);
    }
  });
});
