import { describe, it, expect, beforeEach } from 'vitest';
import { reloadRoutingRegistry } from '../../services/router-registry.js';
import { getPostgresPool } from '../../db/postgres.js';

describe('RouterRegistry — Credential Decryption Security', () => {
  beforeEach(async () => {
    const pool = getPostgresPool();
    await pool.query('DELETE FROM credentials');
    await pool.query('DELETE FROM providers');
  });

  it('disables credential and sets circuitState to DISABLED when decryption fails', async () => {
    const pool = getPostgresPool();
    const providerRes = await pool.query(
      `INSERT INTO providers (provider_key, display_name, enabled, priority)
       VALUES ('groq', 'Groq', true, 10) RETURNING id`
    );
    const providerId = providerRes.rows[0].id;

    // Insert a credential with invalid ciphertext/auth_tag so decryption throws
    await pool.query(
      `INSERT INTO credentials (provider_id, credential_name, encrypted_value, iv, auth_tag, enabled, priority)
       VALUES ($1, 'bad-cred', 'invalid-ciphertext', 'invalid-iv', 'invalid-tag', true, 10)`,
      [providerId]
    );

    const registry = await reloadRoutingRegistry();
    const creds = registry.getAllCredentials();

    expect(creds.length).toBe(1);
    const cred = creds[0];

    expect(cred.decryptedKey).toBe('');
    expect(cred.decryptedKey).not.toBe('invalid-ciphertext');
    expect(cred.enabled).toBe(false);
    expect(cred.runtime.circuitState).toBe('DISABLED');
    expect(cred.runtime.lastHealthError).toBe('Decryption failed');
  });
});
