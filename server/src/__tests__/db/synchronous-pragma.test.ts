import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectDb } from '../../db/index.js';
import type { Db } from '../../db/types.js';

function pragmaValue(db: Db, name: string): unknown {
  return db.pragma(name, { simple: true } as never);
}

describe('connectDb - synchronous pragma', () => {
  const dirs: string[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) {
      try { (db as unknown as { close(): void }).close(); } catch { /* already closed */ }
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses synchronous=NORMAL with WAL for a file-backed database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-sync-'));
    dirs.push(dir);
    const db = connectDb(path.join(dir, 'test.db'));
    dbs.push(db);

    expect(String(pragmaValue(db, 'journal_mode')).toLowerCase()).toBe('wal');
    expect(Number(pragmaValue(db, 'synchronous'))).toBe(1);
  });

  it('leaves the in-memory database on SQLite defaults', () => {
    const db = connectDb(':memory:');
    dbs.push(db);

    expect(String(pragmaValue(db, 'journal_mode')).toLowerCase()).toBe('memory');
    // FULL (2) is the SQLite default; the NORMAL tweak must not apply here.
    expect(Number(pragmaValue(db, 'synchronous'))).toBe(2);
  });
});
