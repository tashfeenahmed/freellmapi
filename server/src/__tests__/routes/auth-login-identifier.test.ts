import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import { authRouter } from '../../routes/auth.js';
import { initDb, getDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';

// The desktop app seeds its hidden account as `desktop@localhost`
// (desktop/src/server-host.ts). That address has no TLD, so while /login shared
// the signup schema's z.email() every sign-in on a desktop install was rejected
// with "A valid email is required" before the password was ever checked — which
// also made the reset-then-sign-in-from-a-browser workaround in #807 impossible.
// Logging in is a lookup, so the address is matched, not validated.

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRouter);
  return a;
}

async function postLogin(body: unknown) {
  const server = app().listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data as any };
}

describe('login accepts the identifier the desktop app actually seeds', () => {
  beforeAll(() => {
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM sessions').run();
    getDb().prepare('DELETE FROM users').run();
  });

  it('signs in an account whose email has no TLD', async () => {
    createUser('desktop@localhost', 'a-long-random-password');
    const res = await postLogin({ email: 'desktop@localhost', password: 'a-long-random-password' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('still rejects the wrong password for that account, with the credential error', async () => {
    createUser('desktop@localhost', 'a-long-random-password');
    const res = await postLogin({ email: 'desktop@localhost', password: 'not-the-password' });
    expect(res.status).toBe(401);
    // Not a 400 about the address shape — the address was fine, the password was not.
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('signs in an account created under an older, shorter password policy', async () => {
    createUser('someone@example.com', 'short');
    const res = await postLogin({ email: 'someone@example.com', password: 'short' });
    expect(res.status).toBe(200);
  });

  it('still requires both fields', async () => {
    const res = await postLogin({ email: '', password: '' });
    expect(res.status).toBe(400);
  });
});
