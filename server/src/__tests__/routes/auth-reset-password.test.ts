import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import { authRouter } from '../../routes/auth.js';
import { initDb } from '../../db/index.js';
import { getResetCode, clearResetCode } from '../../lib/reset-code.js';

// Password reset without an active session (#560). Proof of identity is being
// able to read the server logs, the same trust model first-run setup already
// uses: POST /forgot-password mints a code and prints it, and the operator
// enters it on the reset form. The code never crosses the wire, so these tests
// read it from the module rather than from a response body.
//
// Two pieces of module state outlive any single test and neither can be reset:
// the /forgot-password cooldown stamp and the code's minted-at stamp. So the
// clock here only ever moves FORWARD — each test starts an hour after the last.
// Rewinding (which vi.useRealTimers() does after a jump) leaves those stamps in
// the future and every later request 429s.
//
// Only Date is faked; faking timers wholesale would break the real HTTP below.

const COOLDOWN_MS = 10_000;
const TTL_MS = 15 * 60 * 1000;

let clock = Date.UTC(2030, 0, 1);
function jump(ms: number) {
  clock += ms;
  vi.setSystemTime(clock);
}

function makeApp(): Express {
  const app = express();
  // So a test can speak for another machine with X-Forwarded-For.
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

async function post(app: Express, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function get(app: Express, path: string, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

/** Step past the cooldown first, so a test never fails for a reason it isn't about. */
async function forgot(app: Express) {
  jump(COOLDOWN_MS + 1_000);
  return post(app, '/api/auth/forgot-password');
}

const EMAIL = 'owner@example.test';
const PASSWORD = 'original-password';

afterAll(() => vi.useRealTimers());

describe('forgot-password with no account', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.useFakeTimers({ toFake: ['Date'] });
    jump(60 * 60 * 1000);
    initDb(':memory:');
    clearResetCode();
  });

  it('answers 200 so it cannot be used to probe whether an account exists', async () => {
    const { status } = await post(makeApp(), '/api/auth/forgot-password');
    expect(status).toBe(200);
    expect(getResetCode()).toBeNull();
  });
});

describe('password reset by log code', () => {
  let app: Express;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.useFakeTimers({ toFake: ['Date'] });
    jump(60 * 60 * 1000);
    initDb(':memory:');
    clearResetCode();
    app = makeApp();
    const setup = await post(app, '/api/auth/setup', { email: EMAIL, password: PASSWORD });
    expect(setup.status).toBe(201);
  });

  it('never returns the code over HTTP — it only goes to the logs', async () => {
    const { status, body } = await forgot(app);
    expect(status).toBe(200);
    expect(getResetCode()).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(getResetCode());
  });

  it('rejects a wrong code and leaves the password alone', async () => {
    await forgot(app);
    const bad = await post(app, '/api/auth/reset-password', {
      resetCode: 'NOTTHECODE', newPassword: 'attacker-chosen-pw',
    });
    expect(bad.status).toBe(403);
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('rejects a reset when no code has been minted', async () => {
    const { status } = await post(app, '/api/auth/reset-password', {
      resetCode: 'ANYTHINGXX', newPassword: 'attacker-chosen-pw',
    });
    expect(status).toBe(403);
  });

  it('accepts the real code, and the old password stops working', async () => {
    await forgot(app);
    const code = getResetCode() as string;

    expect((await post(app, '/api/auth/reset-password', { resetCode: code, newPassword: 'brand-new-password' })).status).toBe(200);
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: 'brand-new-password' })).status).toBe(200);
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(401);
  });

  it('signs the operator in and names the account, so a forgotten email is no dead end (#1477)', async () => {
    await forgot(app);
    const code = getResetCode() as string;
    const reset = await post(app, '/api/auth/reset-password', { resetCode: code, newPassword: 'brand-new-password' });

    expect(reset.status).toBe(200);
    expect(reset.body.email).toBe(EMAIL);
    expect(typeof reset.body.token).toBe('string');
    const me = await get(app, '/api/auth/me', reset.body.token);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(EMAIL);
  });

  it('returns no session for a wrong code', async () => {
    await forgot(app);
    const bad = await post(app, '/api/auth/reset-password', { resetCode: 'NOTTHECODE', newPassword: 'attacker-chosen-pw' });
    expect(bad.status).toBe(403);
    expect(bad.body.token).toBeUndefined();
    expect(bad.body.email).toBeUndefined();
  });

  it('logs the account email beside the reset code, never over HTTP', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { body } = await forgot(app);
      const printed = log.mock.calls.map(c => String(c[0])).join('\n');
      expect(printed).toContain(`Password-reset code: ${getResetCode()}`);
      expect(printed).toContain(`Account email: ${EMAIL}`);
      expect(JSON.stringify(body)).not.toContain(EMAIL);
    } finally {
      log.mockRestore();
    }
  });

  it('burns the code after one use', async () => {
    await forgot(app);
    const code = getResetCode() as string;
    expect((await post(app, '/api/auth/reset-password', { resetCode: code, newPassword: 'first-reset-pw' })).status).toBe(200);

    const replay = await post(app, '/api/auth/reset-password', { resetCode: code, newPassword: 'second-reset-pw' });
    expect(replay.status).toBe(403);
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: 'first-reset-pw' })).status).toBe(200);
  });

  // /forgot-password is unauthenticated. When each request minted a new code,
  // anyone could void the code the operator was typing, every ten seconds.
  it('keeps the live code when another one is requested', async () => {
    await forgot(app);
    const first = getResetCode() as string;
    await forgot(app);
    expect(first).toBeTruthy();
    expect(getResetCode()).toBe(first);

    expect((await post(app, '/api/auth/reset-password', { resetCode: first, newPassword: 'pw-via-live-code' })).status).toBe(200);
  });

  it('mints a fresh code once the live one has expired', async () => {
    await forgot(app);
    const first = getResetCode() as string;
    jump(TTL_MS + 1_000);
    await forgot(app);
    const second = getResetCode() as string;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    expect((await post(app, '/api/auth/reset-password', { resetCode: second, newPassword: 'pw-via-fresh-code' })).status).toBe(200);
  });

  // One shared cooldown let a single anonymous caller 429 the operator forever.
  it('throttles reset-code requests per client IP, not for everyone', async () => {
    jump(COOLDOWN_MS + 1_000);
    expect((await post(app, '/api/auth/forgot-password', {}, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(200);
    expect((await post(app, '/api/auth/forgot-password', {}, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(429);
    expect((await post(app, '/api/auth/forgot-password', {}, { 'X-Forwarded-For': '198.51.100.7' })).status).toBe(200);
  });

  it('rate-limits back-to-back reset-code requests', async () => {
    expect((await forgot(app)).status).toBe(200);
    const minted = getResetCode();

    const immediate = await post(app, '/api/auth/forgot-password');
    expect(immediate.status).toBe(429);
    // a refused request must not disturb the code already in flight
    expect(getResetCode()).toBe(minted);
  });

  it('expires the code after 15 minutes', async () => {
    await forgot(app);
    const code = getResetCode() as string;

    jump(TTL_MS + 1_000);
    expect((await post(app, '/api/auth/reset-password', { resetCode: code, newPassword: 'too-late-password' })).status).toBe(403);
    expect((await post(app, '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
  });
});
