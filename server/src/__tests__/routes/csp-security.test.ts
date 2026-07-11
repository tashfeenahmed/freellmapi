import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function getHeaders(app: Express, path: string): Promise<Headers> {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  server.close();
  return res.headers;
}

describe('CSP security headers', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('sets the Content-Security-Policy header on every response', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy');
    expect(csp).toBeTruthy();
  });

  it('restricts default-src to self', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
  });

  it('restricts script-src to self', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
  });

  it('allows inline styles for React hydration', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('does not set HSTS (local-only proxy)', async () => {
    const headers = await getHeaders(app, '/api/ping');
    expect(headers.get('strict-transport-security')).toBeNull();
  });
});
