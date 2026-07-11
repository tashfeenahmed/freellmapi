import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let token: string;

async function exportJson(app: Express, password?: string) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (password) headers['x-reauth-password'] = password;
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/export?format=json`, { headers });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function addKey(app: Express) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  await fetch(`http://127.0.0.1:${addr.port}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: 'groq', key: 'gsk_testkey123' }),
  });
  server.close();
}

describe('Key export — password re-verification', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('returns 403 when no password header is provided', async () => {
    await addKey(app);
    const { status, body } = await exportJson(app);
    expect(status).toBe(403);
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('Password verification');
  });

  it('returns 403 when the password is wrong', async () => {
    await addKey(app);
    const { status } = await exportJson(app, 'wrongpassword');
    expect(status).toBe(403);
  });

  it('returns 200 when the correct password is provided', async () => {
    await addKey(app);
    const { status, body } = await exportJson(app, 'password123');
    expect(status).toBe(200);
    expect(body.keys).toBeDefined();
    expect(body.keys.length).toBe(1);
  });
});
