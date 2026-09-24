import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';

// Two independent guards are supposed to stand in front of POST
// /api/auth/login: the per-email lockout in routes/auth.ts and the per-IP
// admin limiter mounted on /api in app.ts. Both used to miss.

const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery staple';

let app: Express;

async function login(email: string, password: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    await res.text();
    return { status: res.status, headers: res.headers };
  } finally {
    server.close();
  }
}

describe('login brute-force throttling', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM sessions').run();
    getDb().prepare('DELETE FROM users').run();
    createUser(EMAIL, PASSWORD);
  });

  // The lockout bucket has to be keyed on the same spelling verifyCredentials
  // resolves the user by (services/auth.ts normalizeEmail = trim+lowercase).
  // Keyed on `.toLowerCase()` alone, every whitespace variant of the address
  // authenticated against the real row from its own fresh five-try bucket, so
  // the lockout could be side-stepped indefinitely.
  it('counts whitespace-padded spellings of an address in one bucket', async () => {
    for (let i = 0; i < 5; i++) {
      const attempt = await login(EMAIL, `wrong-${i}`);
      expect(attempt.status).toBe(401);
    }
    expect((await login(EMAIL, 'wrong-again')).status).toBe(429);

    // Same account, padded spellings — must hit the same locked bucket.
    for (const padded of [` ${EMAIL}`, `${EMAIL} `, `\t${EMAIL}`, `\n${EMAIL}`, `  ${EMAIL}  `]) {
      expect((await login(padded, 'wrong')).status).toBe(429);
    }

    // And the padded spelling must not be able to sign in past the lockout
    // with the RIGHT password either — it is the same account.
    expect((await login(` ${EMAIL}`, PASSWORD)).status).toBe(429);
  });

  // app.ts mounts createAdminRateLimiter() on /api and its comment names auth
  // brute force as the reason. Express runs middleware in registration order,
  // so the limiter has to be registered before the /api/auth mount or the
  // login route answers and ends the response before the limiter is entered.
  it('routes login through the per-IP admin limiter', async () => {
    // A fresh address, so the lockout the previous test armed (the bucket map
    // is module state and outlives the DB reset) cannot mask the header check.
    const attempt = await login('someone-else@example.com', 'wrong');
    expect(attempt.status).toBe(401);
    expect(attempt.headers.get('x-ratelimit-limit')).toBeTruthy();
  });
});
