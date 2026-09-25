import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../db/index.js';
import { getPostgresPool } from '../../db/postgres.js';
import { encrypt, decrypt } from '../../lib/crypto.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function restoreEnv() {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;

  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}

describe('initDb encryption bootstrapping', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
  });

  afterEach(() => {
    restoreEnv();
  });

  it('loads the encryption key and initializes database settings on boot', async () => {
    process.env.NODE_ENV = 'test';
    const pool = await initDb();
    expect(pool).toBeDefined();

    const encrypted = encrypt('provider-secret');
    const decrypted = decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);
    expect(decrypted).toBe('provider-secret');

    const p = getPostgresPool();
    const res = await p.query('SELECT value FROM settings WHERE key = $1', ['unified_api_key']);
    expect(res.rows.length).toBeGreaterThan(0);
  });
});
