import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { createSession, validateSession, resetReauthFailures } from '../../services/auth.js';

// #705: the dashboard only ever renders a masked key, and reading one back meant
// exporting every key to a file. Revealing ONE key is the same privilege, so it
// carries the same gate: the session is not enough, the password is re-checked.

let app: Express;
let token: string;

async function request(path: string, password?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (password !== undefined) headers['x-reauth-password'] = password;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method: 'POST', headers });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: body as any };
}

async function addKey(key = 'gsk_testkey123') {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: 'groq', key }),
  });
  const body = await res.json() as { id: number };
  server.close();
  return body.id;
}

describe('Reveal one key — password re-verification (#705)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('returns the plaintext key for the right password', async () => {
    const id = await addKey('gsk_the_real_secret');
    const { status, body } = await request(`/api/keys/${id}/reveal`, 'password123');
    expect(status).toBe(200);
    expect(body.key).toBe('gsk_the_real_secret');
  });

  it('refuses a session that does not re-enter the password', async () => {
    const id = await addKey();
    const { status, body } = await request(`/api/keys/${id}/reveal`);
    expect(status).toBe(403);
    expect(body.error.type).toBe('authentication_error');
    expect(body.key).toBeUndefined();
  });

  it('refuses the wrong password', async () => {
    const id = await addKey();
    const { status, body } = await request(`/api/keys/${id}/reveal`, 'not-the-password');
    expect(status).toBe(403);
    expect(body.key).toBeUndefined();
  });

  it('checks the password before it looks the key up', async () => {
    // An unauthenticated caller learns nothing about which ids exist.
    const { status } = await request('/api/keys/99999/reveal');
    expect(status).toBe(403);
  });

  it('404s an unknown key once the password is accepted', async () => {
    const { status } = await request('/api/keys/99999/reveal', 'password123');
    expect(status).toBe(404);
  });

  it('rejects a non-numeric id', async () => {
    const { status } = await request('/api/keys/abc/reveal', 'password123');
    expect(status).toBe(400);
  });
});

// #1885: reveal re-checks the password, so a stolen session could use it to
// test passwords. Wrong guesses share the change-password strike counter: the
// third one in a row ends the session.
describe('Reveal one key — wrong-password strikes (#1885)', () => {
  let userId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken('strikes@example.com');
    userId = validateSession(token)!.userId;
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    resetReauthFailures();
    token = createSession(userId);
  });

  it('signs the session out on the third wrong password', async () => {
    const id = await addKey();
    expect((await request(`/api/keys/${id}/reveal`, 'guess-1')).status).toBe(403);
    expect((await request(`/api/keys/${id}/reveal`, 'guess-2')).status).toBe(403);
    const third = await request(`/api/keys/${id}/reveal`, 'guess-3');
    expect(third.status).toBe(401);
    expect(third.body.error.type).toBe('authentication_error');
    expect(validateSession(token)).toBeNull();
    // The session is gone, so even the right password no longer works with it.
    expect((await request(`/api/keys/${id}/reveal`, 'password123')).status).toBe(401);
  });

  it('a correct password clears earlier strikes', async () => {
    const id = await addKey();
    await request(`/api/keys/${id}/reveal`, 'guess-1');
    await request(`/api/keys/${id}/reveal`, 'guess-2');
    expect((await request(`/api/keys/${id}/reveal`, 'password123')).status).toBe(200);
    await request(`/api/keys/${id}/reveal`, 'guess-3');
    expect((await request(`/api/keys/${id}/reveal`, 'guess-4')).status).toBe(403);
    expect(validateSession(token)).not.toBeNull();
  });

  it('a missing password is not a strike', async () => {
    const id = await addKey();
    for (let i = 0; i < 4; i++) expect((await request(`/api/keys/${id}/reveal`)).status).toBe(403);
    expect(validateSession(token)).not.toBeNull();
  });

  it('export shares the same strike counter', async () => {
    const id = await addKey();
    await request(`/api/keys/${id}/reveal`, 'guess-1');
    await request(`/api/keys/${id}/reveal`, 'guess-2');
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/export?format=json`, {
      headers: { Authorization: `Bearer ${token}`, 'x-reauth-password': 'guess-3' },
    });
    server.close();
    expect(res.status).toBe(401);
    expect(validateSession(token)).toBeNull();
  });
});
