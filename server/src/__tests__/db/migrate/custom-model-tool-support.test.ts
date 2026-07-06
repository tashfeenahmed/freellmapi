import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { up, down } from '../../../db/migrations/20260706_000002_custom_model_tool_support.js';

// A minimal stand-in for the models table so the data-only migration can be
// exercised without the full catalog seed.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      supports_tools INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare('INSERT INTO models (platform, model_id, supports_tools) VALUES (?, ?, ?)');
  insert.run('custom', 'qwen3:4b', 0);          // the stuck-at-zero case (#470)
  insert.run('custom', 'llama3:8b', 1);          // already tool-capable
  insert.run('groq', 'llama-3.3-70b', 0);        // a catalog row that must NOT change
  return db;
}

function toolsByModel(db: Database.Database): Record<string, number> {
  const rows = db.prepare('SELECT model_id, supports_tools FROM models').all() as { model_id: string; supports_tools: number }[];
  return Object.fromEntries(rows.map(r => [r.model_id, r.supports_tools]));
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('custom_model_tool_support migration (#470)', () => {
  it('flips every custom model to tool-capable and leaves catalog rows alone', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);

    expect(toolsByModel(db)).toEqual({
      'qwen3:4b': 1,
      'llama3:8b': 1,
      'llama-3.3-70b': 0, // catalog row untouched
    });
  });

  it('is idempotent — a second up() produces the identical result', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);
    const once = toolsByModel(db);
    up(db);
    const twice = toolsByModel(db);

    expect(twice).toEqual(once);
  });

  it('down() reverses the backfill for custom rows only', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);
    down(db);

    expect(toolsByModel(db)).toEqual({
      'qwen3:4b': 0,
      'llama3:8b': 0,
      'llama-3.3-70b': 0,
    });
  });
});
