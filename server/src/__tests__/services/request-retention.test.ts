import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getRequestAnalyticsRetentionConfig, pruneRequestAnalytics } from '../../services/request-retention.js';

const ORIGINAL_RETENTION_DAYS = process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
const ORIGINAL_MAX_ROWS = process.env.REQUEST_ANALYTICS_MAX_ROWS;

function restoreEnv() {
  if (ORIGINAL_RETENTION_DAYS === undefined) {
    delete process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
  } else {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = ORIGINAL_RETENTION_DAYS;
  }

  if (ORIGINAL_MAX_ROWS === undefined) {
    delete process.env.REQUEST_ANALYTICS_MAX_ROWS;
  } else {
    process.env.REQUEST_ANALYTICS_MAX_ROWS = ORIGINAL_MAX_ROWS;
  }
}

function insertRequest(createdAt: string, marker: string) {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES ('groq', 'groq/compound', 1, 'error', 0, 0, 10, ?, ?)
  `).run(marker, createdAt);
}

describe('request analytics retention', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM requests').run();
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('uses conservative defaults when env values are absent or invalid', () => {
    delete process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
    delete process.env.REQUEST_ANALYTICS_MAX_ROWS;
    expect(getRequestAnalyticsRetentionConfig()).toEqual({ retentionDays: 90, maxRows: 100000 });

    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = 'bad';
    process.env.REQUEST_ANALYTICS_MAX_ROWS = '-1';
    expect(getRequestAnalyticsRetentionConfig()).toEqual({ retentionDays: 90, maxRows: 100000 });
  });

  it('deletes request analytics older than the configured retention window', () => {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = '7';
    process.env.REQUEST_ANALYTICS_MAX_ROWS = '0';

    insertRequest('2026-05-01 00:00:00', 'old');
    insertRequest('2026-05-25 00:00:00', 'recent');

    const result = pruneRequestAnalytics({
      db: getDb(),
      force: true,
      now: new Date('2026-05-26T00:00:00Z'),
    });

    expect(result.deleted).toBe(1);
    const rows = getDb().prepare('SELECT error FROM requests ORDER BY id').all() as Array<{ error: string }>;
    expect(rows.map(row => row.error)).toEqual(['recent']);
  });

  it('keeps only the newest configured number of request rows', () => {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = '0';
    process.env.REQUEST_ANALYTICS_MAX_ROWS = '2';

    insertRequest('2026-05-01 00:00:00', 'row-1');
    insertRequest('2026-05-02 00:00:00', 'row-2');
    insertRequest('2026-05-03 00:00:00', 'row-3');
    insertRequest('2026-05-04 00:00:00', 'row-4');

    const result = pruneRequestAnalytics({
      db: getDb(),
      force: true,
      now: new Date('2026-05-26T00:00:00Z'),
    });

    expect(result.deleted).toBe(2);
    const rows = getDb().prepare('SELECT error FROM requests ORDER BY created_at ASC').all() as Array<{ error: string }>;
    expect(rows.map(row => row.error)).toEqual(['row-3', 'row-4']);
  });

  it('prunes hourly aggregate rows older than 30 days and only when the daily gate has elapsed', () => {
    // Hourly buckets never auto-create themselves in this test (logRequest is
    // the only writer), so seed them by hand to exercise the prune path.
    const db = getDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS request_hourly (
      hour TEXT PRIMARY KEY, total_requests INTEGER NOT NULL DEFAULT 0
    )`).run();
    const upsert = db.prepare(`INSERT INTO request_hourly (hour, total_requests) VALUES (?, ?)
      ON CONFLICT(hour) DO UPDATE SET total_requests = excluded.total_requests`);
    // Seed in the same 'YYYY-MM-DD HH:00:00' (space) format production writes,
    // so the prune cutoff (also space) compares apples-to-apples.
    upsert.run('2026-05-01 00:00:00', 5);   // outside 30d window from May 31
    upsert.run('2026-05-15 00:00:00', 3);   // inside
    upsert.run('2026-05-31 00:00:00', 7);   // boundary hour, kept

    // First call (cold gate): should prune the May 1 row and leave the rest.
    const first = pruneRequestAnalytics({
      db,
      force: true,
      now: new Date('2026-05-31T01:00:00Z'),
    });
    expect(first.deleted).toBe(1);
    const remaining = db.prepare(`SELECT hour, total_requests FROM request_hourly ORDER BY hour`).all() as Array<{ hour: string; total_requests: number }>;
    expect(remaining.map(r => r.hour)).toEqual(['2026-05-15 00:00:00', '2026-05-31 00:00:00']);

    // Second call inside the 24h gate: hourly prune is skipped (raw prune may
    // still run, but with default config + 0 rows it deletes nothing). The
    // hourly rows are unchanged.
    const second = pruneRequestAnalytics({
      db,
      now: new Date('2026-05-31T01:05:00Z'),
    });
    expect(second.skipped).toBe(false);
    expect(second.deleted).toBe(0);
    const remainingAfter = db.prepare(`SELECT hour FROM request_hourly ORDER BY hour`).all() as Array<{ hour: string }>;
    expect(remainingAfter.map(r => r.hour)).toEqual(['2026-05-15 00:00:00', '2026-05-31 00:00:00']);
  });
});
