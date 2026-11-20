import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const validateKey = vi.fn();
vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    resolveProvider: () => ({ name: 'fake', validateKey }),
  };
});

const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const {
  checkKeyHealth,
  markKeyHealthyFromRequest,
  clearLastHealthyStampState,
} = await import('../../services/health.js');

/**
 * #1516 Part 1, display-only slice: a key that only ever passed the /models
 * catalog probe must not read as fully verified. verification_basis records
 * what the healthy verdict rests on — 'models_only' from a probe,
 * 'inference_verified' once the key served a real request — and changes no
 * routing. A probe never downgrades an inference-verified key (weaker
 * evidence must not overwrite stronger evidence); an invalid verdict clears
 * the basis; a transport error leaves it alone.
 */
describe('verification_basis (#1516, display-only)', () => {
  let nextId = 8300;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    validateKey.mockReset();
    clearLastHealthyStampState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function seedKey(status: string, basis: string | null = null): number {
    const id = ++nextId;
    const enc = encrypt(`verify-basis-${id}`);
    getDb().prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, verification_basis)
      VALUES (?, 'mistral', ?, ?, ?, ?, 1, ?, ?)
    `).run(id, `vb-${id}`, enc.encrypted, enc.iv, enc.authTag, status, basis);
    return id;
  }

  function row(id: number): { status: string; verification_basis: string | null } {
    return getDb().prepare('SELECT status, verification_basis FROM api_keys WHERE id = ?')
      .get(id) as any;
  }

  it('a valid probe records models_only on a never-verified key', async () => {
    const id = seedKey('unknown');
    validateKey.mockResolvedValue(true);

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(row(id).verification_basis).toBe('models_only');
  });

  it('a valid probe never downgrades an inference-verified key', async () => {
    const id = seedKey('healthy', 'inference_verified');
    validateKey.mockResolvedValue(true);

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(row(id).verification_basis).toBe('inference_verified');
  });

  it('an invalid verdict clears the basis', async () => {
    const id = seedKey('healthy', 'inference_verified');
    validateKey.mockResolvedValue(false);

    expect(await checkKeyHealth(id)).toBe('invalid');
    expect(row(id).verification_basis).toBeNull();
  });

  it('a transport error leaves the basis alone', async () => {
    const id = seedKey('healthy', 'models_only');
    validateKey.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.mistral.ai'));

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(row(id).verification_basis).toBe('models_only');
  });

  it('a served request upgrades models_only to inference_verified', () => {
    const id = seedKey('healthy', 'models_only');
    markKeyHealthyFromRequest(id);
    expect(row(id).verification_basis).toBe('inference_verified');
  });

  it('a served request stamps the basis even on an already-healthy key', () => {
    const id = seedKey('healthy');
    expect(row(id).verification_basis).toBeNull();

    markKeyHealthyFromRequest(id);

    expect(row(id).verification_basis).toBe('inference_verified');
    expect(row(id).status).toBe('healthy');
  });

  it('the traffic stamp is throttled in memory, like last_healthy_at', () => {
    const id = seedKey('healthy', 'models_only');

    // First call upgrades; a second immediate call must skip the write. Prove
    // it by resetting the column in between: only a real second write would
    // refill it.
    markKeyHealthyFromRequest(id);
    expect(row(id).verification_basis).toBe('inference_verified');
    getDb().prepare('UPDATE api_keys SET verification_basis = ? WHERE id = ?').run('models_only', id);

    markKeyHealthyFromRequest(id);
    expect(row(id).verification_basis).toBe('models_only');

    // After clearing the throttle state, the next call upgrades again.
    clearLastHealthyStampState();
    markKeyHealthyFromRequest(id);
    expect(row(id).verification_basis).toBe('inference_verified');
  });
});
