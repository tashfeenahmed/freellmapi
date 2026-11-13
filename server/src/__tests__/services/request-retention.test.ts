import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getRequestAnalyticsRetentionConfig, pruneRequestAnalytics } from '../../services/request-retention.js';

const ORIGINAL_RETENTION_DAYS = process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
const ORIGINAL_MAX_ROWS = process.env.REQUEST_ANALYTICS_MAX_ROWS;
const ORIGINAL_SEARCH_LOGS_RETENTION_DAYS = process.env.SEARCH_LOGS_RETENTION_DAYS;
const ORIGINAL_SEARCH_LOGS_MAX_ROWS = process.env.SEARCH_LOGS_MAX_ROWS;
const ORIGINAL_DECISION_LOGS_RETENTION_DAYS = process.env.DECISION_LOGS_RETENTION_DAYS;
const ORIGINAL_DECISION_LOGS_MAX_ROWS = process.env.DECISION_LOGS_MAX_ROWS;

function restoreEnv() {
  if (ORIGINAL_DECISION_LOGS_RETENTION_DAYS === undefined) {
    delete process.env.DECISION_LOGS_RETENTION_DAYS;
  } else {
    process.env.DECISION_LOGS_RETENTION_DAYS = ORIGINAL_DECISION_LOGS_RETENTION_DAYS;
  }

  if (ORIGINAL_DECISION_LOGS_MAX_ROWS === undefined) {
    delete process.env.DECISION_LOGS_MAX_ROWS;
  } else {
    process.env.DECISION_LOGS_MAX_ROWS = ORIGINAL_DECISION_LOGS_MAX_ROWS;
  }

  if (ORIGINAL_SEARCH_LOGS_RETENTION_DAYS === undefined) {
    delete process.env.SEARCH_LOGS_RETENTION_DAYS;
  } else {
    process.env.SEARCH_LOGS_RETENTION_DAYS = ORIGINAL_SEARCH_LOGS_RETENTION_DAYS;
  }

  if (ORIGINAL_SEARCH_LOGS_MAX_ROWS === undefined) {
    delete process.env.SEARCH_LOGS_MAX_ROWS;
  } else {
    process.env.SEARCH_LOGS_MAX_ROWS = ORIGINAL_SEARCH_LOGS_MAX_ROWS;
  }

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

  it('sweeps expired idempotency claims and cache rows on the prune pass', () => {
    // Both tables ship with the migration set; seed one expired and one live
    // row in each so a prune must keep the live half.
    const db = getDb();
    const now = new Date('2026-05-31T00:00:00Z').getTime();
    const claim = db.prepare(`
      INSERT INTO idempotency_claims (key_hash, request_fingerprint, response_status, response_body, created_at_ms, expires_at_ms)
      VALUES (?, 'fp', 200, '{}', ?, ?)
    `);
    claim.run('hash-expired', now - 48 * 3600_000, now - 3600_000);
    claim.run('hash-live', now - 3600_000, now + 3600_000);
    const cache = db.prepare(`
      INSERT INTO response_cache (cache_key, body_json, platform, model_id, prompt_tokens, completion_tokens, created_at_ms, expires_at_ms)
      VALUES (?, '{}', 'groq', 'grok-test', 1, 1, ?, ?)
    `);
    cache.run('cache-expired', now - 48 * 3600_000, now - 1000);
    cache.run('cache-live', now - 1000, now + 60_000);

    const result = pruneRequestAnalytics({ db, force: true, now: new Date(now) });
    expect(result.deleted).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM idempotency_claims WHERE key_hash = 'hash-expired'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM idempotency_claims WHERE key_hash = 'hash-live'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM response_cache WHERE cache_key = 'cache-expired'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM response_cache WHERE cache_key = 'cache-live'").get() as { n: number }).n).toBe(1);
  });

  it('sweeps expired dashboard sessions on the prune pass', () => {
    // Expired session rows used to be uncollectable: validateSession only
    // deletes the row it is validating, and an expired token is never re-sent,
    // while every login mints a fresh row. Seed one of each and require the
    // prune to take only the expired half.
    const db = getDb();
    const now = new Date('2026-05-31T00:00:00Z').getTime();
    const userId = db
      .prepare("INSERT INTO users (email, password_hash) VALUES ('prune@example.com', 'x')")
      .run().lastInsertRowid as number;
    const session = db.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)',
    );
    session.run('hash-expired-session', userId, now - 1000);
    session.run('hash-live-session', userId, now + 3600_000);

    const result = pruneRequestAnalytics({ db, force: true, now: new Date(now) });
    expect(result.deleted).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'hash-expired-session'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'hash-live-session'").get() as { n: number }).n).toBe(1);
  });

  it('bounds the web-search attempt log by age and count', () => {
    process.env.SEARCH_LOGS_RETENTION_DAYS = '7';
    process.env.SEARCH_LOGS_MAX_ROWS = '2';
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO search_requests (engine_id, platform, status, latency_ms, created_at)
      VALUES ('tavily-search', 'tavily', 'ok', 10, ?)
    `);
    insert.run('2026-05-01 00:00:00'); // older than 7d from May 8
    insert.run('2026-05-07 00:00:00');
    insert.run('2026-05-07 23:00:00');
    insert.run('2026-05-08 00:00:00');

    const result = pruneRequestAnalytics({
      db,
      force: true,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    // Age prune drops May 1; the count cap then trims the rest to the newest 2.
    expect(result.deleted).toBe(2);
    const remaining = db.prepare(`SELECT created_at FROM search_requests ORDER BY created_at`).all() as Array<{ created_at: string }>;
    expect(remaining.map(r => r.created_at)).toEqual(['2026-05-07 23:00:00', '2026-05-08 00:00:00']);
  });

  it('keeps search rows when both knobs are 0', () => {
    process.env.SEARCH_LOGS_RETENTION_DAYS = '0';
    process.env.SEARCH_LOGS_MAX_ROWS = '0';
    const db = getDb();
    db.prepare(`INSERT INTO search_requests (engine_id, platform, status, latency_ms, created_at)
      VALUES ('tavily-search', 'tavily', 'ok', 10, '2020-01-01 00:00:00')`).run();

    pruneRequestAnalytics({ db, force: true, now: new Date('2026-05-08T12:00:00Z') });
    expect((db.prepare('SELECT COUNT(*) AS n FROM search_requests').get() as { n: number }).n).toBe(1);
  });

  it('bounds the decision-model attempt log by age and count', () => {
    process.env.DECISION_LOGS_RETENTION_DAYS = '7';
    process.env.DECISION_LOGS_MAX_ROWS = '2';
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO decision_requests (model_id, platform, status, latency_ms, created_at)
      VALUES ('clef-flash', 'cloudflare', 'ok', 10, ?)
    `);
    insert.run('2026-05-01 00:00:00'); // older than 7d from May 8
    insert.run('2026-05-07 00:00:00');
    insert.run('2026-05-07 23:00:00');
    insert.run('2026-05-08 00:00:00');

    const result = pruneRequestAnalytics({
      db,
      force: true,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    // Age prune drops May 1; the count cap then trims the rest to the newest 2.
    expect(result.deleted).toBe(2);
    const remaining = db.prepare(`SELECT created_at FROM decision_requests ORDER BY created_at`).all() as Array<{ created_at: string }>;
    expect(remaining.map(r => r.created_at)).toEqual(['2026-05-07 23:00:00', '2026-05-08 00:00:00']);
  });

  it('keeps decision rows when both knobs are 0', () => {
    process.env.DECISION_LOGS_RETENTION_DAYS = '0';
    process.env.DECISION_LOGS_MAX_ROWS = '0';
    const db = getDb();
    db.prepare(`INSERT INTO decision_requests (model_id, platform, status, latency_ms, created_at)
      VALUES ('clef-flash', 'cloudflare', 'ok', 10, '2020-01-01 00:00:00')`).run();

    pruneRequestAnalytics({ db, force: true, now: new Date('2026-05-08T12:00:00Z') });
    expect((db.prepare('SELECT COUNT(*) AS n FROM decision_requests').get() as { n: number }).n).toBe(1);
  });
});
