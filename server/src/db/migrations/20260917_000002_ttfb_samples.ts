import type { Db } from '../types.js';

/**
 * Migration: ttfb_samples — durable log of per-attempt TTFB for endpoint
 * budget tuning (#1262 / #1218 Gap 2).
 *
 * The in-memory ttfb-budget module tracks (platform, endpoint_scope) buckets
 * of successful first-byte timings to widen the retry budget for slow
 * endpoints. These samples are ephemeral across restarts; this table lets a
 * fresh install build a P95 baseline from historical traffic without waiting
 * 10+ requests to accumulate.
 *
 * The `endpoint_scope` column lives in `request_attempts` (migration
 * 20260917_000001_attempt_endpoint_scope) and may not exist on a legacy
 * baseline. Read it conditionally: legacy rows default to '' (catalog
 * platforms), new rows carry the scope. The PK is (platform, endpoint_scope,
 * observed_at) — same pattern as request_attempts.endpoint_scope.
 *
 * INSERT-only: old data ages out naturally via the 7-day window check in
 * ttfb-budget.ts and can be pruned by the existing retention policy once
 * that is extended to cover this table.
 */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ttfb_samples (
      platform TEXT NOT NULL,
      endpoint_scope TEXT NOT NULL DEFAULT '',
      ttfb_ms INTEGER NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, endpoint_scope, observed_at)
    );
    -- Seed from requests: uses legacy-compatible SELECT (requests never had
    -- endpoint_scope; catalog platforms map to '' here). endpoint_scope
    -- from request_attempts is only available on newer installs.
    INSERT OR IGNORE INTO ttfb_samples (platform, endpoint_scope, ttfb_ms, observed_at)
    SELECT r.platform,
           '',
           COALESCE(r.ttfb_ms, 0),
           r.created_at
      FROM requests r
     WHERE r.ttfb_ms IS NOT NULL
       AND r.ttfb_ms > 0
       AND r.status = 'success'
       AND r.created_at >= datetime('now', '-7 days');
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS ttfb_samples');
}
