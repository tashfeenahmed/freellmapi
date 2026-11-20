import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { checkKeyHealth } from '../../services/health.js';

describe('Zhipu global validation health', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not mark an unverified key healthy or disable it when the global probe is rate-limited', async () => {
    const encrypted = encrypt('zhipu-global-health-test-key');
    const inserted = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES ('zhipu', 'global-health-test', ?, ?, ?, 1, 'unknown')
    `).run(encrypted.encrypted, encrypted.iv, encrypted.authTag);
    const keyId = Number(inserted.lastInsertRowid);
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const host = new URL(String(url)).hostname;
      if (host === 'open.bigmodel.cn') return new Response('{"error":{"message":"wrong console"}}', { status: 401 });
      if (host === 'api.z.ai') return new Response('{}', { status: 429, headers: { 'Retry-After': '3' } });
      throw new Error(`unexpected host: ${host}`);
    });
    for (let i = 0; i < 4; i += 1) expect(await checkKeyHealth(keyId)).toBe('unknown');
    const row = getDb().prepare('SELECT status, enabled, last_healthy_at, last_health_error FROM api_keys WHERE id = ?').get(keyId) as any;
    expect(row.status).toBe('unknown');
    expect(row.enabled).toBe(1);
    expect(row.last_healthy_at).toBeNull();
    expect(row.last_health_error).toContain('429');
  });
});
