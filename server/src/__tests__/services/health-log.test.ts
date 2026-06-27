import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

// Mock the providers module BEFORE importing the service so the test never
// hits the network. Hoisting is handled by vi.mock at module level.
vi.mock('../../providers/index.js', () => ({
  resolveProvider: () => ({
    validateKey: async () => { throw new Error('mocked transport failure'); },
  }),
}));

// Imported lazily so the mock above is wired first.
const { checkKeyHealth } = await import('../../services/health.js');

// The crash watchdog (cron bff5ae167d28, every 12h) greps /tmp/freellmapi.log for
// "[Health] Key N (... transport error" to attribute transport failures to the
// responsible provider. The format is part of an implicit contract — a refactor
// that drops the leading "[Health] Key N (" prefix or removes the platform/base
// context will silently break attribution. These tests pin the format.

const ERROR_RE = /^\[Health\] Key (\d+) \(([^,]+), base=([^)]+)\) transport error: (.+)$/;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

describe('checkKeyHealth transport-error log format', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let lastKeyId = 1000;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function seedKey(platform: string, baseUrl: string | null): number {
    const id = ++lastKeyId;
    const db = initDb(':memory:');
    // Use a real encrypt() call so decrypt() in production code succeeds and the
    // mocked validateKey is what throws — exercising the actual transport-error
    // catch path.
    const enc = encrypt('sk-test-fake-api-key-for-health-log-test');
    db.prepare(
      `INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, base_url)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'healthy', ?)`,
    ).run(id, platform, `test-${platform}-${id}`, enc.encrypted, enc.iv, enc.authTag, baseUrl);
    return id;
  }

  function firstLine(): string {
    const call = consoleSpy.mock.calls[0];
    return String(call[0]) + (call.length > 1 ? ' ' + call.slice(1).map(String).join(' ') : '');
  }

  it('emits a single line including platform and base_url', async () => {
    const id = seedKey('openai-compat', 'https://api.example.com/v1');
    const status = await checkKeyHealth(id);
    expect(status).toBe('error');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const line = firstLine();
    expect(line).toMatch(ERROR_RE);
    const m = line.match(ERROR_RE)!;
    expect(m[1]).toBe(String(id));
    expect(m[2]).toBe('openai-compat');
    expect(m[3]).toBe('https://api.example.com/v1');
    expect(m[4]).toBe('mocked transport failure');
  });

  it('falls back to base=default when base_url is null', async () => {
    const id = seedKey('nvidia', null);
    const status = await checkKeyHealth(id);
    expect(status).toBe('error');

    const line = firstLine();
    expect(line).toMatch(ERROR_RE);
    const m = line.match(ERROR_RE)!;
    expect(m[2]).toBe('nvidia');
    expect(m[3]).toBe('default');
  });

  it('preserves the "[Health] Key N (" prefix that the 12h watchdog greps', async () => {
    const id = seedKey('cloudflare', null);
    await checkKeyHealth(id);
    const line = firstLine();
    // The cron regex in scripts/freellmapi-watchdog.sh is anchored on this prefix.
    expect(line.startsWith(`[Health] Key ${id} (`)).toBe(true);
  });
});