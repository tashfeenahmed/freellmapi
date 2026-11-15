import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { type Express } from 'express';
import { keysRouter } from '../../routes/keys.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// #786: the desktop build has no user-set password, so reveal/export skip the
// re-verification there — but only for a caller on the machine itself. The
// desktop app can bind 0.0.0.0 (its LAN-access toggle), and a LAN client of that
// server must still re-enter the password or the second factor is gone for the
// whole network. The real connection here is always loopback, so a middleware
// overrides req.socket with the address under test (the route reads
// req.socket.remoteAddress, never req.ip or X-Forwarded-For).

let token: string;

function appWithRemote(remoteAddr: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress: remoteAddr }, configurable: true });
    next();
  });
  app.use('/api/keys', requireAuth, keysRouter);
  return app;
}

async function call(app: Express, path: string, method: 'GET' | 'POST') {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: body as any };
}

async function addKey(): Promise<number> {
  const app = appWithRemote('127.0.0.1');
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: 'groq', key: 'gsk_the_real_secret' }),
  });
  const body = await res.json() as { id: number };
  server.close();
  return body.id;
}

describe('Desktop re-auth bypass is loopback-only (#786)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    delete process.env.FREEAPI_DESKTOP;
  });

  afterAll(() => {
    delete process.env.FREEAPI_DESKTOP;
  });

  describe('reveal', () => {
    it('reveals without a password for a loopback caller on the desktop build', async () => {
      process.env.FREEAPI_DESKTOP = '1';
      const id = await addKey();
      const { status, body } = await call(appWithRemote('127.0.0.1'), `/api/keys/${id}/reveal`, 'POST');
      expect(status).toBe(200);
      expect(body.key).toBe('gsk_the_real_secret');
    });

    it('accepts IPv6 and IPv4-mapped loopback forms', async () => {
      process.env.FREEAPI_DESKTOP = '1';
      const id = await addKey();
      for (const addr of ['::1', '::ffff:127.0.0.1', '127.0.0.53']) {
        const { status } = await call(appWithRemote(addr), `/api/keys/${id}/reveal`, 'POST');
        expect(status, addr).toBe(200);
      }
    });

    it('still demands the password from a LAN caller on the desktop build', async () => {
      process.env.FREEAPI_DESKTOP = '1';
      const id = await addKey();
      const { status, body } = await call(appWithRemote('192.168.1.42'), `/api/keys/${id}/reveal`, 'POST');
      expect(status).toBe(403);
      expect(body.error.type).toBe('authentication_error');
      expect(body.key).toBeUndefined();
    });

    it('demands the password from a loopback caller when the env is unset', async () => {
      const id = await addKey();
      const { status, body } = await call(appWithRemote('127.0.0.1'), `/api/keys/${id}/reveal`, 'POST');
      expect(status).toBe(403);
      expect(body.key).toBeUndefined();
    });
  });

  describe('export', () => {
    it('exports without a password for a loopback caller on the desktop build', async () => {
      process.env.FREEAPI_DESKTOP = '1';
      await addKey();
      const { status, body } = await call(appWithRemote('127.0.0.1'), '/api/keys/export?format=json', 'GET');
      expect(status).toBe(200);
      expect(body.keys.length).toBe(1);
    });

    it('still demands the password from a LAN caller on the desktop build', async () => {
      process.env.FREEAPI_DESKTOP = '1';
      await addKey();
      const { status, body } = await call(appWithRemote('192.168.1.42'), '/api/keys/export?format=json', 'GET');
      expect(status).toBe(403);
      expect(body.error.type).toBe('authentication_error');
      expect(body.keys).toBeUndefined();
    });

    it('demands the password from a loopback caller when the env is unset', async () => {
      await addKey();
      const { status } = await call(appWithRemote('127.0.0.1'), '/api/keys/export?format=json', 'GET');
      expect(status).toBe(403);
    });
  });

  it('does not take X-Forwarded-For as proof of being local', async () => {
    process.env.FREEAPI_DESKTOP = '1';
    const id = await addKey();
    const app = appWithRemote('192.168.1.42');
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/${id}/reveal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '127.0.0.1' },
    });
    server.close();
    expect(res.status).toBe(403);
  });

  it.each([
    ['a remote client behind a same-host appending proxy', '127.0.0.1, 203.0.113.9'],
    ['an empty first hop', ', 203.0.113.9'],
  ])('demands the password from %s (#1884)', async (_name, forwarded) => {
    process.env.FREEAPI_DESKTOP = '1';
    const id = await addKey();
    // The socket is the local proxy; the right-most hop is the real client.
    const app = appWithRemote('127.0.0.1');
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/${id}/reveal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': forwarded },
    });
    server.close();
    expect(res.status).toBe(403);
  });
});
