import { describe, it, expect } from 'vitest';
import { connectDb } from '../../db/index.js';

const hasNodeSqlite = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const d = hasNodeSqlite ? describe : describe.skip;

d('node:sqlite fallback adapter', () => {
  it('opens an in-memory database and runs basic SQL', () => {
    // Dynamic import to avoid type dependency on node:sqlite.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(':memory:');

    raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    raw.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    const row = raw.prepare('SELECT v FROM t WHERE id = ?').get(1);

    expect(row).toEqual({ v: 'hello' });
    raw.close();
  });

  it('supports nested transactions via SAVEPOINT through connectDb', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const db = connectDb(':memory:', { ensureDir: false });

    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT)');

    const outer = db.transaction(() => {
      db.prepare('INSERT INTO items (v) VALUES (?)').run('outer');

      const inner = db.transaction(() => {
        db.prepare('INSERT INTO items (v) VALUES (?)').run('inner');
      });

      inner();
    });

    outer();

    const rows = db.prepare('SELECT v FROM items ORDER BY id ASC')
      .all() as { v: string }[];

    expect(rows.map(r => r.v)).toEqual(['outer', 'inner']);
    db.close?.();
  });

  it('rolls back inner transaction via SAVEPOINT without affecting outer', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const db = connectDb(':memory:', { ensureDir: false });

    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT)');

    const outer = db.transaction(() => {
      db.prepare('INSERT INTO items (v) VALUES (?)').run('keep-outer');

      const inner = db.transaction(() => {
        db.prepare('INSERT INTO items (v) VALUES (?)').run('drop-inner');
        throw new Error('boom');
      });

      try {
        inner();
      } catch {
        /* swallow to let outer commit */
      }
    });

    outer();

    const rows = db.prepare('SELECT v FROM items').all() as { v: string }[];
    expect(rows.map(r => r.v)).toEqual(['keep-outer']);
    db.close?.();
  });
});
