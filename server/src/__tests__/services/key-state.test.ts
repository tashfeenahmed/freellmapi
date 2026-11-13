import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { encrypt } from '../../lib/crypto.js';
import { getDb, initDb } from '../../db/index.js';
import { isGatedApiPath, mintDashboardToken } from '../helpers/auth.js';

// API key health (M01). Three confirmed-invalid probes in a row auto-disable a
// key. The streak used to live in health.ts alone, so an operator re-enabling
// the key (or pasting a new credential) left it in place and the very next
// failed probe disabled the key again.

const validateKey = vi.hoisted(() => vi.fn());

vi.mock('../../providers/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../providers/index.js')>()),
  resolveProvider: () => ({ name: 'Mistral', validateKey }),
}));

const { checkKeyHealth } = await import('../../services/health.js');
const { createApp } = await import('../../app.js');
const { isUsableKey, USABLE_KEY_SQL } = await import('../../services/key-state.js');

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  server.close();
  return res.status;
}

let nextId = 7000;
function seedKey(): number {
  const id = ++nextId;
  const e = encrypt(`mistral-key-state-${id}`);
  getDb().prepare(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
    VALUES (?, 'mistral', 'key-state', ?, ?, ?, 1, 'unknown')
  `).run(id, e.encrypted, e.iv, e.authTag);
  return id;
}

function row(id: number) {
  return getDb().prepare('SELECT enabled, status, last_health_error FROM api_keys WHERE id = ?').get(id) as {
    enabled: number; status: string; last_health_error: string | null;
  };
}

async function failChecks(id: number, n: number) {
  for (let i = 0; i < n; i++) await checkKeyHealth(id);
}

describe('invalid-probe streak', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    validateKey.mockReset();
    validateKey.mockResolvedValue({ valid: false, error: 'Mistral key validation failed (HTTP 401)' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('auto-disables after three confirmed-invalid probes', async () => {
    const id = seedKey();
    await failChecks(id, 2);
    expect(row(id).enabled).toBe(1);
    await failChecks(id, 1);
    expect(row(id).enabled).toBe(0);
  });

  it('starts the streak over when an operator re-enables the key', async () => {
    const id = seedKey();
    await failChecks(id, 3);
    expect(await request('PATCH', `/api/keys/${id}`, { enabled: true })).toBe(200);
    await failChecks(id, 1);
    expect(row(id).enabled).toBe(1);
  });

  it('starts the streak over when the whole platform is re-enabled', async () => {
    const id = seedKey();
    await failChecks(id, 3);
    expect(await request('PATCH', '/api/keys/platform/mistral', { enabled: true })).toBe(200);
    await failChecks(id, 1);
    expect(row(id).enabled).toBe(1);
  });

  it('starts the streak over when the credential is replaced', async () => {
    const id = seedKey();
    await failChecks(id, 3);
    expect(await request('PATCH', `/api/keys/${id}`, { key: 'mistral-a-brand-new-credential' })).toBe(200);
    expect(row(id)).toEqual({ enabled: 1, status: 'unknown', last_health_error: null });
    await failChecks(id, 1);
    expect(row(id).enabled).toBe(1);
  });
});

describe('isUsableKey', () => {
  it('accepts enabled healthy or unchecked keys only', () => {
    expect(isUsableKey({ enabled: 1, status: 'healthy' })).toBe(true);
    expect(isUsableKey({ enabled: 1, status: 'unknown' })).toBe(true);
    expect(isUsableKey({ enabled: true, status: 'healthy' })).toBe(true);
    expect(isUsableKey({ enabled: 0, status: 'healthy' })).toBe(false);
    expect(isUsableKey({ enabled: 1, status: 'invalid' })).toBe(false);
    expect(isUsableKey({ enabled: 1, status: 'error' })).toBe(false);
    expect(isUsableKey({ enabled: 1, status: 'rate_limited' })).toBe(false);
  });

  it('matches the SQL predicate the routers use', () => {
    expect(USABLE_KEY_SQL).toBe("enabled = 1 AND status IN ('healthy', 'unknown')");
  });
});
