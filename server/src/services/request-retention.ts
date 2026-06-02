import { getDb } from '../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_ROWS = 100_000;
const PRUNE_INTERVAL_MS = 60_000;

type RetentionDb = ReturnType<typeof getDb>;

export interface RequestAnalyticsRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

let nextPruneAtMs = 0;

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

  return { deleted, skipped: false };
}
