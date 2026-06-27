import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDbNow, restoreDbBackupIfNeeded } from '../../lib/db-backup.js';

const ORIGINAL_BACKUP_PATH = process.env.FREEAPI_DB_BACKUP_PATH;
const ORIGINAL_BACKUP_TARGET = process.env.FREEAPI_DB_BACKUP_TARGET;
const ORIGINAL_BACKUP_URL = process.env.FREEAPI_DB_BACKUP_URL;
const ORIGINAL_BACKUP_KEY = process.env.FREEAPI_DB_BACKUP_KEY;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function restoreEnv() {
  if (ORIGINAL_BACKUP_PATH === undefined) delete process.env.FREEAPI_DB_BACKUP_PATH;
  else process.env.FREEAPI_DB_BACKUP_PATH = ORIGINAL_BACKUP_PATH;
  if (ORIGINAL_BACKUP_TARGET === undefined) delete process.env.FREEAPI_DB_BACKUP_TARGET;
  else process.env.FREEAPI_DB_BACKUP_TARGET = ORIGINAL_BACKUP_TARGET;
  if (ORIGINAL_BACKUP_URL === undefined) delete process.env.FREEAPI_DB_BACKUP_URL;
  else process.env.FREEAPI_DB_BACKUP_URL = ORIGINAL_BACKUP_URL;
  if (ORIGINAL_BACKUP_KEY === undefined) delete process.env.FREEAPI_DB_BACKUP_KEY;
  else process.env.FREEAPI_DB_BACKUP_KEY = ORIGINAL_BACKUP_KEY;
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}

describe('encrypted SQLite backup', () => {
  afterEach(() => restoreEnv());

  it('backs up and restores a SQLite file from a configured path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-db-backup-'));
    const dbPath = path.join(dir, 'freeapi.db');
    const backupPath = path.join(dir, 'backup.bin');
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.FREEAPI_DB_BACKUP_PATH = backupPath;

    const db = new Database(dbPath);
    db.exec('CREATE TABLE items (name TEXT NOT NULL); INSERT INTO items (name) VALUES (\'survived\')');
    const backup = await backupDbNow(db, dbPath);
    db.close();

    expect(backup.ok).toBe(true);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath).includes(Buffer.from('survived'))).toBe(false);

    fs.rmSync(dbPath);
    const restore = await restoreDbBackupIfNeeded(dbPath);
    expect(restore.restored).toBe(true);

    const restored = new Database(dbPath);
    expect((restored.prepare('SELECT name FROM items').get() as { name: string }).name).toBe('survived');
    restored.close();
  });
});
