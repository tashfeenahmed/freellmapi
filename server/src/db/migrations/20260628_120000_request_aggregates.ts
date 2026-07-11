import type { Db } from '../types.js';

/**
 * Roll up request analytics into two durable stores so UI totals stay accurate
 * even after the raw `requests` table is pruned by REQUEST_ANALYTICS_MAX_ROWS.
 *
 *   - `request_hourly`: one row per hour with counts + tokens. Max range the UI
 *     exposes is 30d (~720 rows), but we keep the bucket type "hourly" so the
 *     same data covers 24h and 7d windows too. Pruned at >30d.
 *   - `settings` rows: lifetime totals (total_requests, total_input_tokens,
 *     total_output_tokens, first_request_at) that survive every prune.
 *
 * On upgrade we backfill from the still-present `requests` rows so the hourly
 * table picks up any traffic that landed between the last raw-row prune and
 * this migration. Lifetime counters start counting from "now" — rows pruned
 * before this migration are unrecoverable from the aggregate.
 */
function tableExists(db: Db, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function hourKey(createdAt: string): string {
  // SQLite stores created_at as 'YYYY-MM-DD HH:MM:SS' (UTC). Truncate to hour.
  return createdAt.slice(0, 13) + ':00:00';
}

export function up(db: Db): void {
  // Hourly aggregate table. `hour` is the primary key so the same-hour upsert
  // is a single-row write. We never update tokens on a partial failure, so
  // success/error counts and token sums stay consistent.
  if (!tableExists(db, 'request_hourly')) {
    db.prepare(`
      CREATE TABLE request_hourly (
        hour TEXT PRIMARY KEY,
        total_requests INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    db.prepare(`CREATE INDEX idx_request_hourly_hour ON request_hourly(hour)`).run();
  }

  // Backfill from any surviving raw rows. This is best-effort: rows pruned
  // before this migration ran are gone for good from the aggregate, but the
  // lifetime counters below will still be seeded with current totals.
  if (tableExists(db, 'requests')) {
    const bucket = db.prepare(`
      SELECT
        substr(created_at, 1, 13) || ':00:00' AS hour,
        COUNT(*) AS total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM requests
      GROUP BY substr(created_at, 1, 13)
    `).all() as Array<{
      hour: string;
      total_requests: number;
      success_count: number;
      error_count: number;
      input_tokens: number;
      output_tokens: number;
    }>;

    const upsert = db.prepare(`
      INSERT INTO request_hourly (hour, total_requests, success_count, error_count, input_tokens, output_tokens)
      VALUES (@hour, @total_requests, @success_count, @error_count, @input_tokens, @output_tokens)
      ON CONFLICT(hour) DO UPDATE SET
        total_requests = excluded.total_requests,
        success_count  = excluded.success_count,
        error_count    = excluded.error_count,
        input_tokens   = excluded.input_tokens,
        output_tokens  = excluded.output_tokens
    `);

    const tx = db.transaction((rows: typeof bucket) => {
      for (const row of rows) upsert.run(row);
    });
    tx(bucket);

    // Seed lifetime counters from current raw totals. These are best-effort
    // since pruned history is unrecoverable, but they at least match the
    // pre-migration visible total so the UI doesn't reset to 0.
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        MIN(created_at) AS first_request_at
      FROM requests
    `).get() as { total_requests: number; total_input_tokens: number; total_output_tokens: number; first_request_at: string | null };

    const setSetting = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    setSetting.run('total_requests', String(totals.total_requests));
    setSetting.run('total_input_tokens', String(totals.total_input_tokens));
    setSetting.run('total_output_tokens', String(totals.total_output_tokens));
    if (totals.first_request_at) {
      setSetting.run('first_request_at', totals.first_request_at);
    }
  }
}

export function down(db: Db): void {
  db.prepare(`DROP INDEX IF EXISTS idx_request_hourly_hour`).run();
  db.prepare(`DROP TABLE IF EXISTS request_hourly`).run();
  db.prepare(`DELETE FROM settings WHERE key IN (
    'total_requests', 'total_input_tokens', 'total_output_tokens', 'first_request_at'
  )`).run();
}

// Exported so tests can reuse the same bucketing logic.
export { hourKey };