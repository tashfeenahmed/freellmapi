import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { up, down } from '../../../db/migrations/20260819_000001_custom_model_tombstones.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      endpoint_scope TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare("INSERT INTO models (platform, model_id, endpoint_scope) VALUES ('custom', 'model-a', 'http://relay:9999')").run();
  return db;
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('custom_model_tombstones migration (#926)', () => {
  it('creates the tombstone table keyed by (endpoint_scope, model_id)', () => {
    const db = makeDb();
    dbs.push(db);
    up(db);

    const cols = (db.prepare('PRAGMA table_info(custom_model_tombstones)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('endpoint_scope');
    expect(cols).toContain('model_id');
    expect(cols).toContain('created_at');

    db.prepare(
      'INSERT INTO custom_model_tombstones (endpoint_scope, model_id) VALUES (?, ?)',
    ).run('http://relay:9999', 'model-a');
    // The primary key rejects a duplicate for the same endpoint+model.
    expect(() =>
      db.prepare(
        'INSERT INTO custom_model_tombstones (endpoint_scope, model_id) VALUES (?, ?)',
      ).run('http://relay:9999', 'model-a'),
    ).toThrow();
  });

  it('down drops the table and leaves existing data intact', () => {
    const db = makeDb();
    dbs.push(db);
    up(db);
    db.prepare(
      'INSERT INTO custom_model_tombstones (endpoint_scope, model_id) VALUES (?, ?)',
    ).run('http://relay:9999', 'model-a');
    down(db);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(t => t.name);
    expect(tables).not.toContain('custom_model_tombstones');
    // The models table (and its data) survives a revert.
    const models = db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number };
    expect(models.n).toBe(1);
  });
});
