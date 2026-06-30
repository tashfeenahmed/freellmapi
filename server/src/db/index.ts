import crypto from 'crypto';
import BetterSqlite from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMigrationsSync } from './migrate/runner.js';
import { initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';
import type { Db, DbFactory } from './types.js';

export type { Db, DbFactory } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

let db: Db;

export function getDb(): Db {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() or connectDb() first.');
  }
  return db;
}

export function getDefaultDbPath(): string {
  return process.env.FREEAPI_DB_PATH?.trim() || DB_PATH;
}

/** Default factory: opens a better-sqlite3 connection at the given path. */
function betterSqliteFactory(resolvedPath: string): Db {
  return new BetterSqlite(resolvedPath) as unknown as Db;
}

export function connectDb(
  dbPath?: string,
  opts?: {
    /** Create the parent directory if absent. Default: true. Set false in
     *  environments that do not have a writable local filesystem. */
    ensureDir?: boolean;
    /** Factory that constructs the raw Db connection. Default: better-sqlite3. */
    factory?: DbFactory;
  },
): Db {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const isMemory = resolvedPath === ':memory:';
  const ensureDir = opts?.ensureDir ?? true;
  const factory = opts?.factory ?? betterSqliteFactory;

  if (!isMemory && ensureDir) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  db = factory(resolvedPath);
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

export function initDb(
  dbPath?: string,
  opts?: { ensureDir?: boolean; factory?: DbFactory },
): Db {
  const db = connectDb(dbPath, opts);

  if (process.env.NODE_ENV !== 'development') {
    runMigrationsSync(db, 'up');
  } else {
    // In dev, verify the DB has been initialised. If not, give a clear error.
    const ready = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
    ).get();
    if (!ready) {
      console.error(
        '\n  [dev] Database not initialised. Run:\n\n' +
        '    npm run db:migration:up\n\n' +
        '  Then restart the server.\n'
      );
      process.exit(1);
    }
  }

  if (!isEncryptionKeyInitialized()) initEncryptionKey(db);

  return db;
}

export function getUnifiedApiKey(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const db = getDb();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}

// Generic key/value settings accessors (used by routing strategy, etc.).
export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
