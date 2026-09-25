import '../env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { getPostgresPool, closePostgresPool } from '../db/postgres.js';
import { encrypt, decrypt, isEncryptionKeyInitialized, initEncryptionKey } from '../lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_PATH = path.resolve(__dirname, '../../../data/freeapi.db');
const runtimeRequire = createRequire(import.meta.url);

async function migrate() {
  const sqlitePath = process.env.FREEAPI_DB_PATH?.trim() || DEFAULT_SQLITE_PATH;

  if (!fs.existsSync(sqlitePath)) {
    console.log(`[migration] No SQLite database found at ${sqlitePath}. Nothing to migrate.`);
    return;
  }

  console.log(`[migration] Found SQLite database at ${sqlitePath}. Starting migration to PostgreSQL...`);

  let sqliteDb: any;
  try {
    const BetterSqlite = runtimeRequire('better-sqlite3');
    sqliteDb = new BetterSqlite(sqlitePath);
  } catch (err: any) {
    console.error('[migration] better-sqlite3 not available to read old database:', err?.message);
    return;
  }

  if (!isEncryptionKeyInitialized()) {
    initEncryptionKey();
  }

  const pgPool = getPostgresPool();
  const stats = {
    providers: 0,
    credentials: 0,
    models: 0,
    settings: 0,
    clientProfiles: 0,
  };

  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    // 1. Migrate settings
    try {
      const settings = sqliteDb.prepare('SELECT key, value FROM settings').all();
      for (const row of settings) {
        if (row.key === 'encryption_key') continue; // Do not migrate local key to db
        await client.query(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [row.key, row.value]
        );
        stats.settings++;
      }
    } catch (e: any) {
      console.warn('[migration] Notice on settings migration:', e?.message);
    }

    // 2. Migrate providers & api_keys -> providers & credentials
    const providerMap = new Map<string, number>();

    // Seed/find existing providers
    const existingProviders = await client.query('SELECT id, provider_key FROM providers');
    for (const row of existingProviders.rows) {
      providerMap.set(row.provider_key, row.id);
    }

    try {
      const keys = sqliteDb.prepare('SELECT * FROM api_keys').all();
      for (const key of keys) {
        let providerId = providerMap.get(key.platform);
        if (!providerId) {
          const pRes = await client.query(
            `INSERT INTO providers (provider_key, display_name, base_url, enabled, priority)
             VALUES ($1, $2, $3, true, 5)
             ON CONFLICT (provider_key) DO UPDATE SET updated_at = NOW()
             RETURNING id`,
            [key.platform, key.platform.toUpperCase(), key.base_url || null]
          );
          providerId = Number(pRes.rows[0].id);
          if (providerId) {
            providerMap.set(key.platform, providerId);
          }
          stats.providers++;
        }

        // Re-encrypt credential with current key
        let encryptedValue = key.encrypted_key;
        let iv = key.iv;
        let authTag = key.auth_tag;

        try {
          // Verify decrypt
          const plaintext = decrypt(key.encrypted_key, key.iv, key.auth_tag);
          const recrypted = encrypt(plaintext);
          encryptedValue = recrypted.encrypted;
          iv = recrypted.iv;
          authTag = recrypted.authTag;
        } catch {
          // If decryption fails with current key, keep original ciphertext
        }

        await client.query(
          `INSERT INTO credentials (
             provider_id, credential_name, encrypted_value, iv, auth_tag,
             credential_type, enabled, priority, model_scope
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            providerId,
            key.label || '',
            encryptedValue,
            iv,
            authTag,
            key.keyless ? 'keyless' : 'api_key',
            key.enabled !== 0,
            0,
            key.model_scope_json ? JSON.parse(key.model_scope_json) : null,
          ]
        );
        stats.credentials++;
      }
    } catch (e: any) {
      console.warn('[migration] Notice on api_keys migration:', e?.message);
    }

    // 3. Migrate models
    try {
      const models = sqliteDb.prepare('SELECT * FROM models').all();
      for (const m of models) {
        let providerId = providerMap.get(m.platform);
        if (!providerId) {
          const pRes = await client.query(
            `INSERT INTO providers (provider_key, display_name, enabled, priority)
             VALUES ($1, $2, true, 5)
             ON CONFLICT (provider_key) DO UPDATE SET updated_at = NOW()
             RETURNING id`,
            [m.platform, m.platform.toUpperCase()]
          );
          providerId = Number(pRes.rows[0].id);
          if (providerId) {
            providerMap.set(m.platform, providerId);
          }
          stats.providers++;
        }

        await client.query(
          `INSERT INTO models (
             provider_id, model_id, canonical_name, display_name, enabled,
             context_window, max_output_tokens, supports_streaming, supports_tools,
             supports_vision, supports_structured_output, supports_reasoning, priority
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (provider_id, model_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             enabled = EXCLUDED.enabled,
             context_window = EXCLUDED.context_window,
             updated_at = NOW()`,
          [
            providerId,
            m.model_id,
            m.model_id,
            m.display_name || m.model_id,
            m.enabled !== 0,
            m.context_window || null,
            null,
            true,
            m.supports_tools === 1,
            m.supports_vision === 1,
            false,
            false,
            m.intelligence_rank || 0,
          ]
        );
        stats.models++;
      }
    } catch (e: any) {
      console.warn('[migration] Notice on models migration:', e?.message);
    }

    // 4. Migrate client profiles
    try {
      const profiles = sqliteDb.prepare('SELECT * FROM client_profiles').all();
      for (const p of profiles) {
        await client.query(
          `INSERT INTO client_profiles (name, api_key, system_prompt, enabled)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (api_key) DO UPDATE SET
             name = EXCLUDED.name,
             system_prompt = EXCLUDED.system_prompt,
             enabled = EXCLUDED.enabled,
             updated_at = NOW()`,
          [p.name, p.api_key, p.system_prompt || null, p.enabled !== 0]
        );
        stats.clientProfiles++;
      }
    } catch (_e: any) {
      // client_profiles table may not exist in older SQLite DBs
    }

    await client.query('COMMIT');
    console.log('[migration] SQLite -> PostgreSQL Migration Complete!');
    console.log(`[migration] Statistics:
  - Providers migrated/updated: ${stats.providers}
  - Credentials migrated: ${stats.credentials}
  - Models migrated/updated: ${stats.models}
  - Settings migrated: ${stats.settings}
  - Client profiles migrated: ${stats.clientProfiles}`);
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[migration] Migration failed:', err?.message ?? err);
    throw err;
  } finally {
    client.release();
    sqliteDb.close();
    await closePostgresPool();
  }
}

migrate().catch((err) => {
  console.error('[migration] Fatal error:', err);
  process.exit(1);
});
