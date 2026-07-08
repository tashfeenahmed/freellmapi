import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { runMigrationsSync } from './migrate/runner.js';
import { initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';
import type { Db, DbFactory } from './types.js';

export type { Db, DbFactory } from './types.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

let BetterSqlite: any = null;

if (process.platform !== 'android') {
  try {
    BetterSqlite = require('better-sqlite3');
  } catch {}
}

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

function nodeSqliteFactory(resolvedPath: string): Db {
  const { DatabaseSync } = require('node:sqlite');
  const ndb = new DatabaseSync(resolvedPath);
  let txDepth = 0;

  const wrapStmt = (stmt: any) => ({
    run: (...args: any[]) => stmt.run(...args),
    get: (...args: any[]) => stmt.get(...args),
    all: (...args: any[]) => stmt.all(...args),
    iterate: (...args: any[]) => (typeof stmt.iterate === 'function' ? stmt.iterate(...args) : []),
    pluck: () => wrapStmt(typeof stmt.pluck === 'function' ? stmt.pluck() : stmt),
    raw: () => wrapStmt(typeof stmt.raw === 'function' ? stmt.raw() : stmt),
    bind: (...args: any[]) => wrapStmt(typeof stmt.bind === 'function' ? stmt.bind(...args) : stmt),
  });

  return {
    prepare: (sql: string) => wrapStmt(ndb.prepare(sql)),
    pragma: (p: string) => {
      const sql = `PRAGMA ${p}`;
      try {
        return ndb.prepare(sql).all();
      } catch {
        return ndb.exec(sql);
      }
    },
    exec: (sql: string) => ndb.exec(sql),
    close: () => ndb.close(),
    transaction: (fn: Function) => (...args: any[]) => {
      const depth = txDepth;
      const sp = `termux_tx_${depth}`;
      txDepth += 1;

      try {
        if (depth === 0) {
          ndb.exec('BEGIN');
        } else {
          ndb.exec(`SAVEPOINT ${sp}`);
        }

        const result = fn(...args);

        if (depth === 0) {
          ndb.exec('COMMIT');
        } else {
          ndb.exec(`RELEASE SAVEPOINT ${sp}`);
        }

        return result;
      } catch (error) {
        try {
          if (depth === 0) {
            ndb.exec('ROLLBACK');
          } else {
            ndb.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
            ndb.exec(`RELEASE SAVEPOINT ${sp}`);
          }
        } catch {}
        throw error;
      } finally {
        txDepth -= 1;
      }
    },
  } as unknown as Db;
}

function betterSqliteFactory(resolvedPath: string): Db {
  if (!BetterSqlite) {
    throw new Error('better-sqlite3 is not available on this platform/runtime');
  }
  return new BetterSqlite(resolvedPath) as unknown as Db;
}

export function connectDb(
  dbPath?: string,
  opts?: {
    ensureDir?: boolean;
    factory?: DbFactory;
  },
): Db {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const isMemory = resolvedPath === ':memory:';
  const ensureDir = opts?.ensureDir ?? true;
  const factory =
    opts?.factory ??
    (process.platform === 'android' ? nodeSqliteFactory : betterSqliteFactory);

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
    const ready = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'")
      .get();

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
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'unified_api_key'")
    .get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const db = getDb();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}

export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
