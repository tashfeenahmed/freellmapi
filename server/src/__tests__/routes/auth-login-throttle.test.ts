import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';
import { authRouter } from '../../routes/auth.js';
import { getResetCode } from '../../lib/reset-code.js';

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
  // RFC 6585: a 429 must carry Retry-After. The gateway's other 429s (proxy
  // limiter, key exhaustion, monthly budget) all do; the per-email lockout
  // was the one that told the client nothing about when to come back.
  it('lockout 429 carries a Retry-After within the 15-minute window', async () => {
    const EMAIL2 = 'retry-after@example.com';
    for (let i = 0; i < 5; i++) {
      expect((await login(EMAIL2, `wrong-${i}`)).status).toBe(401);
    }
    const locked = await login(EMAIL2, 'wrong');
    expect(locked.status).toBe(429);
    const retryAfter = Number(locked.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  it('routes login through the per-IP admin limiter', async () => {
    // A fresh address, so the lockout the previous test armed (the bucket map
    // is module state and outlives the DB reset) cannot mask the header check.
    const attempt = await login('someone-else@example.com', 'wrong');
    expect(attempt.status).toBe(401);
    expect(attempt.headers.get('x-ratelimit-limit')).toBeTruthy();
  });
});

// The lockout used to be keyed on the address alone, and the address is easy
// to guess (the desktop account is `desktop@localhost`). Five bad guesses from
// anywhere locked the owner out of their own dashboard, correct password and
// all, and repeating them every 15 minutes kept it that way.
describe('login lockout is per client, with an account-wide cap', () => {
  let server: Server;
  let base: string;

  // Behind TRUST_PROXY, req.ip is the forwarded client, so each test can speak
  // for a different machine.
  async function loginFrom(ip: string, email: string, password: string): Promise<number> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email, password }),
    });
    await res.text();
    return res.status;
  }

  async function postFrom(ip: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/auth', authRouter);
    server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => server.close());

  afterEach(() => vi.useRealTimers());

  it('a guesser on one IP cannot lock the owner out from another', async () => {
    const email = 'per-ip-owner@example.com';
    createUser(email, PASSWORD);
    for (let i = 0; i < 5; i++) expect(await loginFrom('203.0.113.9', email, `wrong-${i}`)).toBe(401);
    expect(await loginFrom('203.0.113.9', email, PASSWORD)).toBe(429);

    expect(await loginFrom('198.51.100.7', email, PASSWORD)).toBe(200);
  });

  it('caps guesses for the whole account when the guesser rotates IPs', async () => {
    const email = 'rotating-target@example.com';
    createUser(email, PASSWORD);
    for (let ip = 1; ip <= 10; ip++) {
      for (let i = 0; i < 5; i++) expect(await loginFrom(`203.0.113.${ip}`, email, `wrong-${i}`)).toBe(401);
    }
    // Fifty failures across ten addresses: the account is locked for everyone.
    expect(await loginFrom('192.0.2.77', email, PASSWORD)).toBe(429);
  });

  it('lets a successful password reset lift the lockout', async () => {
    const email = 'reset-unlocks@example.com';
    getDb().prepare('DELETE FROM users').run();
    createUser(email, PASSWORD);
    for (let ip = 1; ip <= 10; ip++) {
      for (let i = 0; i < 5; i++) await loginFrom(`198.18.0.${ip}`, email, `wrong-${i}`);
    }
    expect(await loginFrom('192.0.2.88', email, PASSWORD)).toBe(429);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await postFrom('192.0.2.88', '/api/auth/forgot-password', {})).status).toBe(200);
    const reset = await postFrom('192.0.2.88', '/api/auth/reset-password', { resetCode: getResetCode(), newPassword: 'brand-new-password' });
    expect(reset.status).toBe(200);

    expect(await loginFrom('192.0.2.88', email, 'brand-new-password')).toBe(200);
  });

  it('forgets failures older than the lockout window', async () => {
    const email = 'slow-typist@example.com';
    createUser(email, PASSWORD);
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 4; i++) expect(await loginFrom('198.51.100.20', email, `typo-${i}`)).toBe(401);
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    for (let i = 0; i < 4; i++) expect(await loginFrom('198.51.100.20', email, `typo-${i}`)).toBe(401);

    expect(await loginFrom('198.51.100.20', email, PASSWORD)).toBe(200);
  });
});
