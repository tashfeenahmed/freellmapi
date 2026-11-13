import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { up, down } from '../../../db/migrations/20261017_233153_request_failure_attribution.js';

// #1347 (PR 1): the migration only adds one column to requests; a minimal
// stand-in table is enough to verify the roundtrip.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL
    );
  `);
  return db;
}

function hasAttributionColumn(db: Database.Database): boolean {
  const cols = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  return cols.some((c) => c.name === 'failure_attribution');
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('request_failure_attribution migration (#1347 PR 1)', () => {
  it('adds the failure_attribution column', () => {
    const db = makeDb();
    dbs.push(db);

    expect(hasAttributionColumn(db)).toBe(false);
    up(db);
    expect(hasAttributionColumn(db)).toBe(true);
  });

  it('is idempotent — a second up() is a no-op', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);
    up(db);
    expect(hasAttributionColumn(db)).toBe(true);
  });

  it('down() drops the column, and up() can add it back (full roundtrip)', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);
    down(db);
    expect(hasAttributionColumn(db)).toBe(false);

    up(db);
    expect(hasAttributionColumn(db)).toBe(true);
  });
});
