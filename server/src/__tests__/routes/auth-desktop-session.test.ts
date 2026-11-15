import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express, { type Express } from 'express';
import { authRouter } from '../../routes/auth.js';
import { initDb, getDb } from '../../db/index.js';
import { validateSession, userCount } from '../../services/auth.js';

// #1399: the desktop app's dashboard opened in a normal browser tab must sign
// in without a form. POST /api/auth/desktop-session mints the install's session,
// but only for the desktop embedder, over loopback, with a localhost Host
// header, and never for another site's page. The real connection here is
// always loopback, so a middleware overrides req.socket for the remote cases.

function app(remoteAddr = '127.0.0.1'): Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress: remoteAddr }, configurable: true });
    next();
  });
  a.use('/api/auth', authRouter);
  return a;
}

// node:http rather than fetch: the Host header is the thing under test, and
// fetch does not let a caller set it.
async function call(a: Express, method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}) {
  const server = a.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

describe('POST /api/auth/desktop-session (#1399)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM sessions').run();
    getDb().prepare('DELETE FROM users').run();
    process.env.FREEAPI_DESKTOP = '1';
  });

  afterAll(() => {
    delete process.env.FREEAPI_DESKTOP;
  });

  it('mints a working session for a local browser tab and creates the hidden account on first run', async () => {
    expect(userCount()).toBe(0);
    const status = await call(app(), 'GET', '/api/auth/status');
    expect(status.body).toMatchObject({ authenticated: false, desktop: true });

    const res = await call(app(), 'POST', '/api/auth/desktop-session', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:31415' });
    expect(res.status).toBe(200);
    expect(validateSession(res.body.token)?.email).toBe('desktop@localhost');
    expect(userCount()).toBe(1);
  });

  it('accepts localhost and [::1] host names', async () => {
    for (const host of ['localhost:31415', '[::1]:31415']) {
      const res = await call(app(), 'POST', '/api/auth/desktop-session', { host });
      expect(res.status, host).toBe(200);
    }
  });

  it('refuses web and Docker installs (no FREEAPI_DESKTOP)', async () => {
    delete process.env.FREEAPI_DESKTOP;
    expect((await call(app(), 'GET', '/api/auth/status')).body.desktop).toBe(false);
    expect((await call(app(), 'POST', '/api/auth/desktop-session')).status).toBe(403);
  });

  it('refuses a LAN caller when the app binds 0.0.0.0', async () => {
    expect((await call(app('192.168.1.20'), 'POST', '/api/auth/desktop-session')).status).toBe(403);
    expect((await call(app('192.168.1.20'), 'GET', '/api/auth/status')).body.desktop).toBe(false);
  });

  it('refuses a request relayed by a local reverse proxy from a remote client', async () => {
    const res = await call(app(), 'POST', '/api/auth/desktop-session', { 'x-forwarded-for': '203.0.113.9' });
    expect(res.status).toBe(403);
  });

  // #1884: an appending local proxy leaves the caller's own header in front of the
  // hop it adds, so the front of the list must never be the deciding value.
  it('refuses a proxied request that claims a loopback client in front of the proxy hop', async () => {
    const res = await call(app(), 'POST', '/api/auth/desktop-session', {
      'x-forwarded-for': '127.0.0.1, 203.0.113.9',
    });
    expect(res.status).toBe(403);
    // The refused request must not have created the install's account either.
    expect(userCount()).toBe(0);
  });

  it('refuses a DNS-rebinding page (non-local Host header)', async () => {
    const res = await call(app(), 'POST', '/api/auth/desktop-session', { host: 'evil.example:31415' });
    expect(res.status).toBe(403);
  });

  it('refuses another site firing a request at localhost', async () => {
    expect((await call(app(), 'POST', '/api/auth/desktop-session', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call(app(), 'POST', '/api/auth/desktop-session', { origin: 'https://evil.example' })).status).toBe(403);
    expect(userCount()).toBe(0);
  });
});
