import { getDb } from '../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_ROWS = 100_000;
const PRUNE_INTERVAL_MS = 60_000;
// Hourly aggregate table. Pruned once a day on the same 60s tick; bounded at
// ~720 rows for a 30d max UI range. See db/migrations/.../request_aggregates.ts.
const HOURLY_RETENTION_DAYS = 30;
const HOURLY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type RetentionDb = ReturnType<typeof getDb>;

export interface RequestAnalyticsRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

let nextPruneAtMs = 0;
let nextHourlyPruneAtMs = 0;

function readNonNegativeInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function toSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function getRequestAnalyticsRetentionConfig(): RequestAnalyticsRetentionConfig {
  return {
    retentionDays: readNonNegativeInt('REQUEST_ANALYTICS_RETENTION_DAYS', DEFAULT_RETENTION_DAYS),
    maxRows: readNonNegativeInt('REQUEST_ANALYTICS_MAX_ROWS', DEFAULT_MAX_ROWS),
  };
}

export function pruneRequestAnalytics(options: {
  db?: RetentionDb;
  force?: boolean;
  now?: Date;
} = {}): { deleted: number; skipped: boolean } {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  if (!options.force && nowMs < nextPruneAtMs) {
    return { deleted: 0, skipped: true };
  }
  nextPruneAtMs = nowMs + PRUNE_INTERVAL_MS;

  const db = options.db ?? getDb();
  const { retentionDays, maxRows } = getRequestAnalyticsRetentionConfig();
  let deleted = 0;

  if (retentionDays > 0) {
    const cutoff = toSqliteTimestamp(new Date(nowMs - retentionDays * DAY_MS));
    deleted += db.prepare('DELETE FROM requests WHERE created_at < ?').run(cutoff).changes;
  }

  if (maxRows > 0) {
    deleted += db.prepare(`
      DELETE FROM requests
      WHERE id IN (
        SELECT id
        FROM requests
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxRows).changes;
  }

  // Hourly aggregate prune (gated once per day). The UI's widest window is
  // 30d, so we keep at most 30 days of hourly buckets (~720 rows). The table
  // is the source of truth for analytics totals — never prune more aggressively
  // than the UI range, or the 30d count will silently drop again.
  // Guarded against the table being absent (tests that init a DB before the
  // migration runs would otherwise crash the prune loop).
  if (nowMs >= nextHourlyPruneAtMs) {
    nextHourlyPruneAtMs = nowMs + HOURLY_PRUNE_INTERVAL_MS;
    const hasHourly = !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='request_hourly'")
      .get();
    if (hasHourly) {
      // Hour keys are created_at truncated to the hour, in SQLite's canonical
      // 'YYYY-MM-DD HH:00:00' text (space separator) — same as logRequest.hourKey()
      // and the summary/timeline readers. Floor the cutoff to the hour and
      // compare on the space form so the prune boundary matches the read window.
      const sqliteCutoff = toSqliteTimestamp(new Date(nowMs - HOURLY_RETENTION_DAYS * DAY_MS));
      const hourlyCutoff = sqliteCutoff.slice(0, 13) + ':00:00';
      const hourlyDeleted = db.prepare('DELETE FROM request_hourly WHERE hour < ?').run(hourlyCutoff).changes;
      if (hourlyDeleted > 0) {
        deleted += hourlyDeleted;
      }
    }
  }

  return { deleted, skipped: false };
}
