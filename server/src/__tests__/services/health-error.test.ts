import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../../lib/crypto.js';
import { getDb, initDb } from '../../db/index.js';

const validateKey = vi.hoisted(() => vi.fn());

vi.mock('../../providers/index.js', () => ({
  resolveProvider: () => ({
    name: 'Mistral',
    validateKey,
  }),
}));

const { checkKeyHealth } = await import('../../services/health.js');

describe('persisted key health diagnostics', () => {
  let nextId = 4000;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    validateKey.mockReset();
    vi.restoreAllMocks();
  });

  function seedKey(lastError: string | null = null): number {
    const id = ++nextId;
    const encrypted = encrypt('mistral-health-test-key');
    getDb().prepare(`
      INSERT INTO api_keys
        (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_health_error)
      VALUES (?, 'mistral', 'health-test', ?, ?, ?, 1, 'unknown', ?)
    `).run(id, encrypted.encrypted, encrypted.iv, encrypted.authTag, lastError);
    return id;
  }

  function row(id: number): { status: string; last_health_error: string | null } {
    return getDb().prepare('SELECT status, last_health_error FROM api_keys WHERE id = ?').get(id) as any;
  }

  it('stores and logs a confirmed provider rejection reason', async () => {
    const id = seedKey();
    validateKey.mockResolvedValue({
      valid: false,
      error: 'Mistral key validation failed (HTTP 401): token expired',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await checkKeyHealth(id)).toBe('invalid');
    expect(row(id)).toEqual({
      status: 'invalid',
      last_health_error: 'Mistral key validation failed (HTTP 401): token expired',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('token expired'));
  });

  it('redacts secrets before persisting or logging transport errors', async () => {
    const id = seedKey();
    validateKey.mockRejectedValue(new Error('Bearer secret-token-value-1234567890 failed at https://api.example.test/models'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await checkKeyHealth(id)).toBe('error');
    expect(row(id).last_health_error).toBe('Bearer [redacted] failed at [redacted-url]');
    expect(String(error.mock.calls[0][0])).not.toContain('secret-token-value');
  });

  it('clears the previous reason after a successful probe', async () => {
    const id = seedKey('old failure');
    validateKey.mockResolvedValue(true);

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(row(id)).toEqual({ status: 'healthy', last_health_error: null });
  });
});
