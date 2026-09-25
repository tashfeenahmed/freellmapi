import crypto from 'crypto';
import pg from 'pg';
import { getPostgresPool, initPostgresPool, closePostgresPool, type QueryResult } from './postgres.js';
import { runMigrations } from './migrate/runner.js';
import { initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';

let cachedUnifiedApiKey: string | null = null;
const settingsCache = new Map<string, string>();

export { getPostgresPool, initPostgresPool, closePostgresPool };

export async function initDb(connectionString?: string): Promise<pg.Pool> {
  const pool = initPostgresPool(connectionString);

  // Run migrations automatically
  try {
    await runMigrations(pool, 'up');
    console.log('[db] PostgreSQL migrations applied successfully');
  } catch (err: any) {
    console.error('[db] Error running PostgreSQL migrations:', err?.message ?? err);
    throw err;
  }

  if (!isEncryptionKeyInitialized()) {
    initEncryptionKey();
  }

  // Load all settings into in-memory cache for zero-DB reads in request path
  await loadSettingsCache(pool);

  // Ensure default unified API key exists
  await ensureUnifiedApiKey();

  return pool;
}

export function getDb(): pg.Pool & any {
  return getPostgresPool() as any;
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  const pool = getPostgresPool();
  return pool.query<T>(text, params);
}

export function getDefaultDbPath(): string {
  return process.env.DATABASE_URL || 'neon-postgresql';
}

async function loadSettingsCache(pool: pg.Pool): Promise<void> {
  try {
    const res = await pool.query('SELECT key, value FROM settings');
    settingsCache.clear();
    for (const row of res.rows) {
      if (row.key && row.value !== undefined && row.value !== null) {
        settingsCache.set(row.key, row.value);
      }
    }
    if (settingsCache.has('unified_api_key')) {
      cachedUnifiedApiKey = settingsCache.get('unified_api_key')!;
    }
  } catch (err: any) {
    console.warn('[db] Failed to preload settings cache:', err?.message ?? err);
  }
}

export function getUnifiedApiKey(): string {
  if (cachedUnifiedApiKey) {
    return cachedUnifiedApiKey;
  }
  const fromCache = settingsCache.get('unified_api_key');
  if (fromCache) {
    cachedUnifiedApiKey = fromCache;
    return fromCache;
  }
  const defaultKey = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  cachedUnifiedApiKey = defaultKey;
  settingsCache.set('unified_api_key', defaultKey);
  return defaultKey;
}

export function getCachedUnifiedApiKey(): string | null {
  return cachedUnifiedApiKey ?? settingsCache.get('unified_api_key') ?? getUnifiedApiKey();
}

export async function regenerateUnifiedKey(): Promise<string> {
  const pool = getPostgresPool();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('unified_api_key', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key]
  );
  cachedUnifiedApiKey = key;
  settingsCache.set('unified_api_key', key);
  return key;
}

async function ensureUnifiedApiKey(): Promise<void> {
  const pool = getPostgresPool();
  const res = await pool.query("SELECT value FROM settings WHERE key = 'unified_api_key'");
  if (res.rows.length === 0 || !res.rows[0].value) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('unified_api_key', $1, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key]
    );
    cachedUnifiedApiKey = key;
    settingsCache.set('unified_api_key', key);
  } else {
    cachedUnifiedApiKey = res.rows[0].value;
    settingsCache.set('unified_api_key', res.rows[0].value);
  }
}

export function getSetting(key: string): string | undefined {
  return settingsCache.get(key);
}

export async function getSettingAsync(key: string): Promise<string | undefined> {
  if (settingsCache.has(key)) {
    return settingsCache.get(key);
  }
  const pool = getPostgresPool();
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rows[0]?.value !== undefined) {
    settingsCache.set(key, res.rows[0].value);
    return res.rows[0].value;
  }
  return undefined;
}

export async function setSetting(key: string, value: string): Promise<void> {
  settingsCache.set(key, value);
  const pool = getPostgresPool();
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}
