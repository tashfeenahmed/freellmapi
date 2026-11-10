import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import { authRouter } from '../../routes/auth.js';
import { initDb, getDb } from '../../db/index.js';
import { generateSetupCode, getSetupCode } from '../../lib/setup-code.js';

// FIX 1: first-run setup is frictionless from the local machine (loopback) but
// a remote caller must present the one-time setup code minted at boot. The real
// connection here is always loopback, so a middleware overrides req.socket with
// the address under test. Forwarded headers are honoured only through the
// app's `trust proxy` setting (TRUST_PROXY), which the optional second argument
// sets the same way createApp() does.

function appWithRemote(remoteAddr: string, trustProxy: boolean | number | string[] = false): Express {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress: remoteAddr }, configurable: true });
    next();
  });
  app.use('/api/auth', authRouter);
  return app;
}

async function postSetup(app: Express, body: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const CREDS = { email: 'admin@example.com', password: 'supersecret' };

describe('First-run setup code gate (FIX 1)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    // Reset to an unclaimed dashboard and mint a fresh code for each case.
    const db = getDb();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM users').run();
    generateSetupCode();
  });

  it('allows setup from IPv4 loopback without a code', async () => {
    const { status, body } = await postSetup(appWithRemote('127.0.0.1'), CREDS);
    expect(status).toBe(201);
    expect(typeof body.token).toBe('string');
  });

  it('allows setup from IPv6 loopback without a code', async () => {
    const { status } = await postSetup(appWithRemote('::1'), CREDS);
    expect(status).toBe(201);
  });

  it('allows setup from an IPv4-mapped IPv6 loopback without a code', async () => {
    const { status } = await postSetup(appWithRemote('::ffff:127.0.0.1'), CREDS);
    expect(status).toBe(201);
  });

  it('rejects remote setup with no code (403 setup_code_required)', async () => {
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), CREDS);
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
    // No account was created.
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects remote setup with a wrong code', async () => {
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), { ...CREDS, setupCode: 'WRONGCODE9' });
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
  });

  it('allows remote setup with the correct code', async () => {
    const code = getSetupCode();
    expect(code).toBeTruthy();
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), { ...CREDS, setupCode: code });
    expect(status).toBe(201);
    expect(typeof body.token).toBe('string');
  });

  // The documented reverse-proxy deployment (Caddy/nginx/Traefik on the same
  // host, docs/en/proxy/OVERVIEW.md) makes every request a loopback socket, so
  // the socket test alone said "local" for the entire internet and any visitor
  // could claim an unclaimed dashboard with no code. A forwarded hop can never
  // GRANT locality, but a non-loopback one withdraws it.
  it('rejects a loopback socket whose forwarded hop is remote', async () => {
    const { status, body } = await postSetup(
      appWithRemote('127.0.0.1'),
      CREDS,
      { 'X-Forwarded-For': '203.0.113.7' },
    );
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  // Without TRUST_PROXY nothing in X-Forwarded-For can be verified: the client
  // writes it. A proxied request is therefore never local, even one that
  // claims 127.0.0.1. (This used to pass, which was the bypass below.)
  it('requires the code for a proxied request when TRUST_PROXY is unset', async () => {
    const { status, body } = await postSetup(
      appWithRemote('127.0.0.1'),
      CREDS,
      { 'X-Forwarded-For': '127.0.0.1' },
    );
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
  });

  it('allows a same-host proxy that forwards a local browser when TRUST_PROXY=1', async () => {
    const { status } = await postSetup(
      appWithRemote('127.0.0.1', 1),
      CREDS,
      { 'X-Forwarded-For': '127.0.0.1' },
    );
    expect(status).toBe(201);
  });

  describe('DISABLE_LOCAL_TRUST=true', () => {
    beforeEach(() => { process.env.DISABLE_LOCAL_TRUST = 'true'; });
    afterEach(() => { delete process.env.DISABLE_LOCAL_TRUST; });

    // A bare nginx `proxy_pass` adds no forwarding header, so every visitor
    // looks like a direct loopback client. The switch is the only defense.
    it('requires the code even from a direct loopback socket', async () => {
      const { status, body } = await postSetup(appWithRemote('127.0.0.1'), CREDS);
      expect(status).toBe(403);
      expect(body.error.type).toBe('setup_code_required');
      expect((getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c).toBe(0);
    });

    it('still accepts the setup code', async () => {
      const { status } = await postSetup(appWithRemote('127.0.0.1'), { ...CREDS, setupCode: getSetupCode() });
      expect(status).toBe(201);
    });
  });

  describe('spoofed loopback through a same-host reverse proxy (regression)', () => {
    const expectRefused = async (app: Express, headers: Record<string, string>) => {
      const { status, body } = await postSetup(app, CREDS, headers);
      expect(status).toBe(403);
      expect(body.error.type).toBe('setup_code_required');
      const count = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      expect(count).toBe(0);
    };

    // nginx `$proxy_add_x_forwarded_for` appends the real client after
    // whatever the client sent, so the first entry is attacker-written.
    it('rejects an attacker-written first hop (nginx append), TRUST_PROXY unset', async () => {
      await expectRefused(appWithRemote('127.0.0.1'), { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' });
    });

    it('rejects an attacker-written first hop (nginx append), TRUST_PROXY=1', async () => {
      await expectRefused(appWithRemote('127.0.0.1', 1), { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' });
    });

    it('rejects an attacker-written first hop with a trusted loopback proxy list', async () => {
      await expectRefused(appWithRemote('127.0.0.1', ['loopback']), { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' });
    });

    // TRUST_PROXY=true trusts every hop, so req.ip is the left-most entry: the
    // one the client wrote. It can never prove locality.
    it('rejects any proxied request when TRUST_PROXY=true', async () => {
      await expectRefused(appWithRemote('127.0.0.1', true), { 'X-Forwarded-For': '127.0.0.1' });
      await expectRefused(appWithRemote('127.0.0.1', true), { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' });
    });

    // A proxy that names the client only in X-Real-IP / Forwarded has no
    // X-Forwarded-For chain for TRUST_PROXY to verify.
    it('rejects a proxied request identified only by X-Real-IP or Forwarded', async () => {
      await expectRefused(appWithRemote('127.0.0.1', 1), { 'X-Real-IP': '203.0.113.7' });
      await expectRefused(appWithRemote('127.0.0.1'), { 'X-Real-IP': '127.0.0.1' });
      await expectRefused(appWithRemote('127.0.0.1'), { Forwarded: 'for=127.0.0.1' });
    });

    // nginx forwarding only X-Real-IP passes the client's own X-Forwarded-For
    // through untouched; under TRUST_PROXY=1 that spoof used to resolve as
    // the client.
    it('rejects a spoofed X-Forwarded-For that contradicts the proxy-stated X-Real-IP', async () => {
      await expectRefused(appWithRemote('127.0.0.1', 1), { 'X-Real-IP': '203.0.113.7', 'X-Forwarded-For': '127.0.0.1' });
      await expectRefused(appWithRemote('127.0.0.1', ['loopback']), { 'X-Real-IP': '203.0.113.7', 'X-Forwarded-For': '127.0.0.1' });
    });

    it('never grants locality to a remote socket, whatever the headers say', async () => {
      await expectRefused(appWithRemote('203.0.113.7', true), { 'X-Forwarded-For': '127.0.0.1' });
    });
  });

  it('accepts the setup code through a proxy with a remote forwarded hop', async () => {
    const code = getSetupCode();
    expect(code).toBeTruthy();
    const { status } = await postSetup(
      appWithRemote('127.0.0.1'),
      { ...CREDS, setupCode: code },
      { 'X-Forwarded-For': '203.0.113.7' },
    );
    expect(status).toBe(201);
  });

  it('still 409s a second setup once an account exists (remote, even with a code)', async () => {
    // Claim locally first.
    expect((await postSetup(appWithRemote('127.0.0.1'), CREDS)).status).toBe(201);
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), { email: 'second@example.com', password: 'supersecret', setupCode: getSetupCode() ?? 'x' });
    expect(status).toBe(409);
    expect(body.error.type).toBe('setup_complete');
  });
});
