import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up, down } from '../../../db/migrations/20261031_000001_model_monthly_usage.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE requests (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      request_type TEXT NOT NULL DEFAULT 'chat',
      status TEXT NOT NULL DEFAULT 'success',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO requests (platform, model_id, request_type, status, input_tokens, output_tokens, created_at) VALUES
      ('google', 'model-a', 'chat', 'success', 123, 45, '2026-10-01 12:00:00'),
      ('google', 'model-a', 'chat', 'error', 15, 5, '2026-10-02 12:00:00'),
      ('google', 'model-a', 'embedding', 'success', 500, 500, '2026-10-02 12:00:00'),
      ('google', 'model-b', 'chat', 'success', 3, 4, '2026-10-02 12:00:00'),
      ('groq', 'model-a', 'chat', 'success', 8, 9, '2026-10-02 12:00:00'),
      ('google', 'model-a', 'chat', 'success', 90, 9, '2026-09-30 12:00:00');
  `);
  return db;
}

describe('monthly model usage migration', () => {
  it('backfills chat tokens by model, provider and month without double counting on rerun', () => {
    const db = makeDb();
    try {
      up(db);
      up(db);
      expect(db.prepare('SELECT * FROM model_monthly_usage ORDER BY platform, model_id, month').all()).toEqual([
        { platform: 'google', model_id: 'model-a', month: '2026-09', tokens: 99 },
        { platform: 'google', model_id: 'model-a', month: '2026-10', tokens: 188 },
        { platform: 'google', model_id: 'model-b', month: '2026-10', tokens: 7 },
        { platform: 'groq', model_id: 'model-a', month: '2026-10', tokens: 17 },
      ]);
    } finally {
      db.close();
    }
  });

  it('preserves usage through raw-row pruning and records subsequent requests', () => {
    const db = makeDb();
    try {
      up(db);
      db.exec(`
        DELETE FROM requests;
        INSERT INTO requests (platform, model_id, input_tokens, output_tokens, created_at)
        VALUES ('google', 'model-a', 20, 24, '2026-10-03 12:00:00');
        INSERT INTO requests (platform, model_id, request_type, input_tokens, created_at)
        VALUES ('google', 'model-a', 'embedding', 1000, '2026-10-03 12:00:00');
      `);
      expect(db.prepare("SELECT tokens FROM model_monthly_usage WHERE platform = 'google' AND model_id = 'model-a' AND month = '2026-10'").get()).toEqual({ tokens: 232 });
      down(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('model_monthly_usage', 'requests_model_monthly_usage')").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
