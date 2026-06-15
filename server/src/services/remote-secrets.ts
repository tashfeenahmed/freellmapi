import { spawnSync } from 'child_process';
import type Database from 'better-sqlite3';
import { resolveDatabaseUrlEnv } from '../env.js';

type SecretSetting = { key: string; value: string };
type SecretKey = {
  id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  created_at: string;
  last_checked_at: string | null;
  base_url: string | null;
};

type SecretSnapshot = {
  settings: SecretSetting[];
  apiKeys: SecretKey[];
};

function runRemoteCommand(action: 'status' | 'pull' | 'push', payload?: SecretSnapshot): any {
  const databaseUrl = resolveDatabaseUrlEnv();
  if (!databaseUrl) {
    return null;
  }

  const script = `
    import { Pool } from 'pg';

    const action = process.argv[1];
    const env = process.env;
    const rawInput = await new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => data += chunk);
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', reject);
    });
    const input = rawInput ? JSON.parse(rawInput) : {};

    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL === 'disable'
        ? undefined
        : { rejectUnauthorized: env.DATABASE_SSL === 'strict' },
    });

    async function ensureSchema() {
      await pool.query(\`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      \`);
      await pool.query(\`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY,
          platform TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          encrypted_key TEXT NOT NULL,
          iv TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'unknown',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          last_checked_at TEXT,
          base_url TEXT
        )
      \`);
    }

    async function pull() {
      await ensureSchema();
      const [settings, apiKeys] = await Promise.all([
        pool.query('SELECT key, value FROM settings ORDER BY key'),
        pool.query('SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at, last_checked_at, base_url FROM api_keys ORDER BY id'),
      ]);
      console.log(JSON.stringify({ settings: settings.rows, apiKeys: apiKeys.rows }));
    }

    async function push() {
      await ensureSchema();
      await pool.query('BEGIN');
      try {
        for (const row of input.settings ?? []) {
          await pool.query(\`
            INSERT INTO settings (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          \`, [row.key, row.value]);
        }
        for (const row of input.apiKeys ?? []) {
          await pool.query(\`
            INSERT INTO api_keys
              (id, platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at, last_checked_at, base_url)
            VALUES
              ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO UPDATE SET
              platform = EXCLUDED.platform,
              label = EXCLUDED.label,
              encrypted_key = EXCLUDED.encrypted_key,
              iv = EXCLUDED.iv,
              auth_tag = EXCLUDED.auth_tag,
              status = EXCLUDED.status,
              enabled = EXCLUDED.enabled,
              created_at = EXCLUDED.created_at,
              last_checked_at = EXCLUDED.last_checked_at,
              base_url = EXCLUDED.base_url
          \`, [
            row.id, row.platform, row.label, row.encrypted_key, row.iv, row.auth_tag,
            row.status, row.enabled, row.created_at, row.last_checked_at, row.base_url,
          ]);
        }
        await pool.query('COMMIT');
        console.log(JSON.stringify({ ok: true }));
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      } finally {
        await pool.end();
      }
    }

    async function status() {
      await ensureSchema();
      const [settings, apiKeys] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS count FROM settings'),
        pool.query('SELECT COUNT(*)::int AS count FROM api_keys'),
      ]);
      console.log(JSON.stringify({ settings: settings.rows[0].count, apiKeys: apiKeys.rows[0].count }));
    }

    try {
      if (action === 'pull') await pull();
      else if (action === 'push') await push();
      else await status();
    } finally {
      if (action !== 'push') await pool.end().catch(() => {});
    }
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, action], {
    input: payload ? JSON.stringify(payload) : '',
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(`Remote secret sync failed (${action}): ${stderr || result.error?.message || 'unknown error'}`);
  }

  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : null;
}

export function hasRemoteSecretsStore(): boolean {
  return !!resolveDatabaseUrlEnv();
}

function readLocalSecretSnapshot(db: Database.Database): SecretSnapshot {
  const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all() as SecretSetting[];
  const apiKeys = db.prepare(`
    SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at, last_checked_at, base_url
    FROM api_keys
    ORDER BY id
  `).all() as SecretKey[];
  return { settings, apiKeys };
}

function upsertLocalSecrets(db: Database.Database, snapshot: SecretSnapshot): void {
  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const upsertKey = db.prepare(`
    INSERT INTO api_keys
      (id, platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at, last_checked_at, base_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      platform = excluded.platform,
      label = excluded.label,
      encrypted_key = excluded.encrypted_key,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      status = excluded.status,
      enabled = excluded.enabled,
      created_at = excluded.created_at,
      last_checked_at = excluded.last_checked_at,
      base_url = excluded.base_url
  `);

  const apply = db.transaction(() => {
    for (const row of snapshot.settings) {
      upsertSetting.run(row.key, row.value);
    }
    for (const row of snapshot.apiKeys) {
      upsertKey.run(
        row.id, row.platform, row.label, row.encrypted_key, row.iv, row.auth_tag,
        row.status, row.enabled, row.created_at, row.last_checked_at, row.base_url,
      );
    }
  });
  apply();
}

export function hydrateSecretsFromRemote(db: Database.Database): boolean {
  if (!hasRemoteSecretsStore()) return false;
  const snapshot = runRemoteCommand('pull') as SecretSnapshot;
  upsertLocalSecrets(db, snapshot);
  return true;
}

export function hydrateSecretsToRemote(db: Database.Database): boolean {
  if (!hasRemoteSecretsStore()) return false;
  runRemoteCommand('push', readLocalSecretSnapshot(db));
  return true;
}

export function remoteSecretCounts(): { settings: number; apiKeys: number } | null {
  if (!hasRemoteSecretsStore()) return null;
  return runRemoteCommand('status') as { settings: number; apiKeys: number };
}
