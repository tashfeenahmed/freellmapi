import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import {
  rotateSecretsAsync,
  applyRotationAsync,
  encryptWith,
  decryptWith,
} from '../../scripts/rotate-encryption-key.js';

const OLD_KEY = Buffer.from('a'.repeat(64), 'hex'); // 64 hex chars
const NEW_KEY = Buffer.from('b'.repeat(64), 'hex');

async function seedRows() {
  const db = getDb();
  await db.query('DELETE FROM credentials');
  const keyEnc = encryptWith(OLD_KEY, 'sk-prod-secret-123');
  await db.query(`
    INSERT INTO credentials (provider_id, label, encrypted_key, encrypted_value, iv, auth_tag, circuit_state, enabled)
    VALUES (1, 'test', $1, $2, $3, $4, 'HEALTHY', true)
  `, [keyEnc.encrypted, keyEnc.encrypted, keyEnc.iv, keyEnc.authTag]);
}

describe('rotate-encryption-key: key rotation round-trip', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    await seedRows();
  });

  it('re-encrypts every stored secret so the new key can decrypt it', async () => {
    const result = await rotateSecretsAsync(getDb(), OLD_KEY, NEW_KEY);
    expect(result.error).toBeUndefined();
    expect(result.rows.length).toBeGreaterThan(0);

    await applyRotationAsync(getDb(), result.rows);

    const res = await getDb().query('SELECT id, encrypted_value, iv, auth_tag FROM credentials WHERE id = $1', [result.rows[0].id]);
    const row = res.rows[0];
    expect(decryptWith(NEW_KEY, row.encrypted_value, row.iv, row.auth_tag)).toBe('sk-prod-secret-123');
  });
});

describe('rotate-encryption-key: wrong-key protection', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    await seedRows();
  });

  it('reports an error (and no rows) when the old key cannot decrypt a value', async () => {
    const wrong = Buffer.from('c'.repeat(64), 'hex');
    const result = await rotateSecretsAsync(getDb(), wrong, NEW_KEY);
    expect(result.rows).toHaveLength(0);
    expect(result.error).toMatch(/cannot decrypt/);
  });
});

describe('rotate-encryption-key: aes-256-gcm parity with crypto.ts', () => {
  it('produces ciphertext the server crypto module can open (same params)', async () => {
    const key = Buffer.from('0'.repeat(64), 'hex');
    await initDb(':memory:');

    const serverEnc = encrypt('roundtrip-parity');
    expect(decryptWith(key, serverEnc.encrypted, serverEnc.iv, serverEnc.authTag)).toBe('roundtrip-parity');
    const scriptEnc = encryptWith(key, 'script-parity');
    expect(decrypt(scriptEnc.encrypted, scriptEnc.iv, scriptEnc.authTag)).toBe('script-parity');
  });
});
