import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectDb, defaultDbFactory } from '../../db/index.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import type { Db } from '../../db/types.js';

describe('node:sqlite Android fallback', () => {
  let db: Db | undefined;
  const tempDirs: string[] = [];

  afterEach(() => {
    db?.close?.();
    db = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is selected only for Android', () => {
    expect(defaultDbFactory('android')).toBe(nodeSqliteFactory);
    expect(defaultDbFactory('darwin')).not.toBe(nodeSqliteFactory);
    expect(defaultDbFactory('linux')).not.toBe(nodeSqliteFactory);
  });

  it('runs the complete application migration set', () => {
    db = connectDb(':memory:', { factory: nodeSqliteFactory, ensureDir: false });
    runMigrationsSync(db, 'up');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((row) => row.name)).toContain('api_keys');
    expect((db.prepare('SELECT COUNT(*) AS count FROM models').get() as { count: number }).count).toBeGreaterThan(0);
  });

  it('opens a file-backed database with WAL and file metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-node-sqlite-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'freeapi.db');

    db = connectDb(dbPath, { factory: nodeSqliteFactory });
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO sample (value) VALUES (?)').run('persisted');

    expect(db.name).toBe(dbPath);
    expect(db.memory).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
  });

  it('supports nested transaction commit and rollback semantics', () => {
    db = connectDb(':memory:', { factory: nodeSqliteFactory, ensureDir: false });
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

    const outer = db.transaction(() => {
      db!.prepare('INSERT INTO items (value) VALUES (?)').run('outer');
      db!.transaction(() => {
        db!.prepare('INSERT INTO items (value) VALUES (?)').run('inner');
      })();

      try {
        db!.transaction(() => {
          db!.prepare('INSERT INTO items (value) VALUES (?)').run('rolled-back');
          throw new Error('rollback inner savepoint');
        })();
      } catch {
        // The outer transaction remains usable and commits.
      }
    });

    outer();

    const rows = db.prepare('SELECT value FROM items ORDER BY id').all() as { value: string }[];
    expect(rows.map((row) => row.value)).toEqual(['outer', 'inner']);
  });
});
