import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  rotateSecretsAsync,
  applyRotationAsync,
  encryptWith,
  decryptWith,
} from '../../scripts/rotate-encryption-key.js';

const OLD_HEX = 'a'.repeat(64);
const NEW_HEX = 'b'.repeat(64);
const OLD_KEY = Buffer.from(OLD_HEX, 'hex');
const NEW_KEY = Buffer.from(NEW_HEX, 'hex');

const API_KEY_SECRET = 'sk-live-rotate-me';

async function seedDb(): Promise<void> {
  process.env.ENCRYPTION_KEY = OLD_HEX;
  const db = await initDb(':memory:');
  await db.query('DELETE FROM credentials');

  const keyEnc = encryptWith(OLD_KEY, API_KEY_SECRET);
  await db.query(`
    INSERT INTO credentials (provider_id, label, encrypted_key, encrypted_value, iv, auth_tag, circuit_state, enabled)
    VALUES (1, 'cli-test', $1, $2, $3, $4, 'HEALTHY', true)
  `, [keyEnc.encrypted, keyEnc.encrypted, keyEnc.iv, keyEnc.authTag]);
}

describe('rotate-encryption-key CLI functionality', () => {
  beforeEach(async () => {
    await seedDb();
  });

  it('rotates every stored secret to the new key and leaves the old key unable to read them', async () => {
    const db = getDb();
    const result = await rotateSecretsAsync(db, OLD_KEY, NEW_KEY);
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBeGreaterThan(0);

    await applyRotationAsync(db, result.rows);

    const res = await db.query('SELECT encrypted_value, iv, auth_tag FROM credentials WHERE label = $1', ['cli-test']);
    const row = res.rows[0];

    expect(decryptWith(NEW_KEY, row.encrypted_value, row.iv, row.auth_tag)).toBe(API_KEY_SECRET);
    expect(() => decryptWith(OLD_KEY, row.encrypted_value, row.iv, row.auth_tag)).toThrow();
  });

  it('reports an error when the old key is wrong', async () => {
    const db = getDb();
    const wrongKey = Buffer.from('c'.repeat(64), 'hex');
    const result = await rotateSecretsAsync(db, wrongKey, NEW_KEY);
    expect(result.rows).toHaveLength(0);
    expect(result.error).toMatch(/cannot decrypt/);
  });
});
