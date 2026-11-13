import { getDb } from '../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_ROWS = 100_000;
const PRUNE_INTERVAL_MS = 60_000;
// Hourly aggregate table. Pruned once a day on the same 60s tick; bounded at
// ~720 rows for a 30d max UI range. See db/migrations/.../request_aggregates.ts.
const HOURLY_RETENTION_DAYS = 30;
const HOURLY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Persisted server_logs (warn/error only — see the migration). Much shorter
// than the 90d analytics window: a week is well past the point where anyone is
// still debugging last Tuesday's provider outage, and unlike `requests` these
// rows carry no aggregate that would silently change if they were pruned.
const DEFAULT_SERVER_LOGS_RETENTION_DAYS = 7;
const DEFAULT_SERVER_LOGS_MAX_ROWS = 50_000;
// provider_quota_observations is the append-only audit trail behind
// provider_quota_state (which always holds the current reading). Nothing reads
// further back than the newest row per pool, so the history is diagnostics
// only — yet a busy install wrote ~15k rows a day and reached 470k rows in a
// month. Pruned on the daily gate: the delete is a range over created_at.
const DEFAULT_QUOTA_OBSERVATIONS_RETENTION_DAYS = 30;
const DEFAULT_QUOTA_OBSERVATIONS_MAX_ROWS = 200_000;
// search_requests (#1174) is the per-attempt web-search log behind the Search
// dashboard. Before this it was the one log with no bound at all: every agent
// web_search (up to 20 per request) appended a row forever. The widest UI
// window is 90d, so the default age bound matches the `requests` table.
const DEFAULT_SEARCH_RETENTION_DAYS = 90;
const DEFAULT_SEARCH_MAX_ROWS = 100_000;
// decision_requests (#1537) is the per-attempt decision-model log behind the
// Models → Decision page. Same shape as search_requests: an append-only
// attempt log whose only reader is a month-scoped count, so older rows are
// pure disk growth. Bounded like the search log.
const DEFAULT_DECISION_RETENTION_DAYS = 90;
const DEFAULT_DECISION_MAX_ROWS = 100_000;

type RetentionDb = ReturnType<typeof getDb>;

export interface RequestAnalyticsRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

let nextPruneAtMs = 0;
let nextHourlyPruneAtMs = 0;
let nextQuotaObservationsPruneAtMs = 0;

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

export interface ServerLogRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

/** Both knobs env-tunable, 0 on either disables that half. Same convention and
 *  same parser as the analytics pair above. */
export function getServerLogRetentionConfig(): ServerLogRetentionConfig {
  return {
    retentionDays: readNonNegativeInt('SERVER_LOGS_RETENTION_DAYS', DEFAULT_SERVER_LOGS_RETENTION_DAYS),
    maxRows: readNonNegativeInt('SERVER_LOGS_MAX_ROWS', DEFAULT_SERVER_LOGS_MAX_ROWS),
  };
}

export interface QuotaObservationRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

/** Same env convention as the pairs above; 0 on either knob disables that half. */
export function getQuotaObservationRetentionConfig(): QuotaObservationRetentionConfig {
  return {
    retentionDays: readNonNegativeInt('QUOTA_OBSERVATIONS_RETENTION_DAYS', DEFAULT_QUOTA_OBSERVATIONS_RETENTION_DAYS),
    maxRows: readNonNegativeInt('QUOTA_OBSERVATIONS_MAX_ROWS', DEFAULT_QUOTA_OBSERVATIONS_MAX_ROWS),
  };
}

export interface SearchLogRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

/** Same env convention as the pairs above; 0 on either knob disables that half. */
export function getSearchLogRetentionConfig(): SearchLogRetentionConfig {
  return {
    retentionDays: readNonNegativeInt('SEARCH_LOGS_RETENTION_DAYS', DEFAULT_SEARCH_RETENTION_DAYS),
    maxRows: readNonNegativeInt('SEARCH_LOGS_MAX_ROWS', DEFAULT_SEARCH_MAX_ROWS),
  };
}

export interface DecisionLogRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

/** Same env convention as the pairs above; 0 on either knob disables that half. */
export function getDecisionLogRetentionConfig(): DecisionLogRetentionConfig {
  return {
    retentionDays: readNonNegativeInt('DECISION_LOGS_RETENTION_DAYS', DEFAULT_DECISION_RETENTION_DAYS),
    maxRows: readNonNegativeInt('DECISION_LOGS_MAX_ROWS', DEFAULT_DECISION_MAX_ROWS),
  };
}

// The first sweep on an install that predates the prune may face hundreds of
// thousands of rows; deleting them in one statement held the loop for ~4.5s on
// a 470k-row log. Work is chunked under a wall-clock budget instead, and a
// sweep that runs out of budget is resumed on the next 60s tick rather than
// tomorrow. The chunk is the smallest unit of stall: 20k rows took ~870ms on a
// 2-vCPU box under load, 5k keeps each tick near the budget.
const QUOTA_OBSERVATIONS_PRUNE_CHUNK = 5_000;
const QUOTA_OBSERVATIONS_PRUNE_BUDGET_MS = 250;

/**
 * Age- and count-bound the provider quota observation log.
 *
 * provider_quota_state is the source of truth for "how much is left"; this
 * table only explains how it got there. Keeping the newest row per pool is
 * guaranteed by the count bound being far above the number of live pools.
 * created_at is SQLite datetime text, indexed since the 20260901_000002
 * migration, so both deletes are range/ordered walks, not scans. Guarded
 * against the table being absent for the same reason as the hourly prune.
 *
 * Returns how many rows went and whether the sweep finished; `done: false`
 * means the budget ran out and the caller should come back soon.
 */
export function pruneQuotaObservations(
  db: RetentionDb,
  nowMs: number,
  budgetMs = QUOTA_OBSERVATIONS_PRUNE_BUDGET_MS,
): { deleted: number; done: boolean } {
  const hasTable = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_quota_observations'")
    .get();
  if (!hasTable) return { deleted: 0, done: true };

  const { retentionDays, maxRows } = getQuotaObservationRetentionConfig();
  const started = Date.now();
  const inBudget = () => Date.now() - started < budgetMs;
  let deleted = 0;

  if (retentionDays > 0) {
    const cutoff = toSqliteTimestamp(new Date(nowMs - retentionDays * DAY_MS));
    const byAge = db.prepare(`
      DELETE FROM provider_quota_observations
      WHERE rowid IN (
        SELECT rowid FROM provider_quota_observations
        WHERE created_at < ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `);
    for (;;) {
      const changes = byAge.run(cutoff, QUOTA_OBSERVATIONS_PRUNE_CHUNK).changes;
      deleted += changes;
      if (changes < QUOTA_OBSERVATIONS_PRUNE_CHUNK) break;
      if (!inBudget()) return { deleted, done: false };
    }
  }

  if (maxRows > 0) {
    const byCount = db.prepare(`
      DELETE FROM provider_quota_observations
      WHERE rowid IN (
        SELECT rowid
        FROM provider_quota_observations
        ORDER BY created_at DESC, rowid DESC
        LIMIT ? OFFSET ?
      )
    `);
    for (;;) {
      const changes = byCount.run(QUOTA_OBSERVATIONS_PRUNE_CHUNK, maxRows).changes;
      deleted += changes;
      if (changes < QUOTA_OBSERVATIONS_PRUNE_CHUNK) break;
      if (!inBudget()) return { deleted, done: false };
    }
  }

  return { deleted, done: true };
}

/**
 * Age- and count-bound the persisted warn/error log rows.
 *
 * Folded into the existing prune pass rather than given a timer of its own: a
 * second interval would be a second thing to start, stop, test and leak in
 * embedders, for a table that grows far slower than `requests` does.
 *
 * Guarded against the table being absent, exactly like the hourly aggregate
 * below — tests that open a DB before migrations run must not crash the prune
 * loop. Rows are deleted by created_at_ms, never by id: the id space is shared
 * with the in-memory ring and is not a timestamp.
 */
export function pruneServerLogs(db: RetentionDb, nowMs: number): number {
  const hasTable = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='server_logs'")
    .get();
  if (!hasTable) return 0;

  const { retentionDays, maxRows } = getServerLogRetentionConfig();
  let deleted = 0;

  if (retentionDays > 0) {
    deleted += db
      .prepare('DELETE FROM server_logs WHERE created_at_ms < ?')
      .run(nowMs - retentionDays * DAY_MS).changes;
  }

  if (maxRows > 0) {
    deleted += db.prepare(`
      DELETE FROM server_logs
      WHERE id IN (
        SELECT id
        FROM server_logs
        ORDER BY created_at_ms DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxRows).changes;
  }

  return deleted;
}

/**
 * Sweep expired rows from the short-lived replay stores and the session table.
 *
 * idempotency_claims and response_cache are write-once with a TTL that readers
 * already filter on (`expires_at_ms > now`), and both are indexed on
 * `expires_at_ms`. Neither had a sweeper: `storeIdempotencyResult` only deletes
 * expired rows for the SAME key hash it is about to overwrite, so a claim
 * whose hash never repeats — the common case, since clients send a fresh UUID
 * per request — sat in the DB forever with its full response JSON. A busy
 * install replaying Idempotency-Key traffic grew this table monotonically.
 * `response_cache` swept expired rows only at startup, so a long-running
 * server accumulated them between restarts too.
 *
 * `sessions` joins the sweep for the same reason (#1510-era retention series):
 * validateSession only deletes a row when its OWN token is checked again — and
 * an expired token is by definition never re-sent — while login mints a new
 * row per sign-in (30-day TTL). Desktop installs that mint a session on every
 * dashboard load leak one row per load. Expired rows are dead weight for every
 * reader (validateSession filters on expires_at_ms), so deleting them is safe.
 * sessions has no index on expires_at_ms; the delete is a scan of a table that
 * is at most a few hundred rows on any install, once per prune gate.
 *
 * The claims/cache deletes are plain index-range walks over `expires_at_ms`,
 * so cost scales with what is actually expired. Guarded against the tables
 * being absent the same way every other prune here is.
 */
export function pruneExpiredClaims(db: RetentionDb, nowMs: number): number {
  let deleted = 0;
  for (const table of ['idempotency_claims', 'response_cache', 'sessions'] as const) {
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table);
    if (!present) continue;
    deleted += db.prepare(`DELETE FROM ${table} WHERE expires_at_ms <= ?`).run(nowMs).changes;
  }
  return deleted;
}

/**
 * Age- and count-bound the web-search attempt log (#1174).
 *
 * Folded into the same 60s pass as the server logs. search_requests grew on
 * every agent web_search attempt with no prune of any kind; its analytics only
 * answer windows up to 90d ('all' included), so older rows are pure disk
 * growth. Guarded against the table being absent like every other prune here.
 */
export function pruneSearchLogs(db: RetentionDb, nowMs: number): number {
  const hasTable = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_requests'")
    .get();
  if (!hasTable) return 0;

  const { retentionDays, maxRows } = getSearchLogRetentionConfig();
  let deleted = 0;

  if (retentionDays > 0) {
    const cutoff = toSqliteTimestamp(new Date(nowMs - retentionDays * DAY_MS));
    deleted += db.prepare('DELETE FROM search_requests WHERE created_at < ?').run(cutoff).changes;
  }

  if (maxRows > 0) {
    deleted += db.prepare(`
      DELETE FROM search_requests
      WHERE id IN (
        SELECT id
        FROM search_requests
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxRows).changes;
  }

  return deleted;
}

/**
 * Age- and count-bound the decision-model attempt log (#1537).
 *
 * decision_requests grew on every POST /v1/decisions attempt (and every failed
 * one — a cooling-down key still logs) with no prune of any kind. Its only
 * reader is the month-scoped count on the Decision page, so the 90d default
 * matches the other attempt logs. Guarded against the table being absent like
 * every other prune here.
 */
export function pruneDecisionLogs(db: RetentionDb, nowMs: number): number {
  const hasTable = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_requests'")
    .get();
  if (!hasTable) return 0;

  const { retentionDays, maxRows } = getDecisionLogRetentionConfig();
  let deleted = 0;

  if (retentionDays > 0) {
    const cutoff = toSqliteTimestamp(new Date(nowMs - retentionDays * DAY_MS));
    deleted += db.prepare('DELETE FROM decision_requests WHERE created_at < ?').run(cutoff).changes;
  }

  if (maxRows > 0) {
    deleted += db.prepare(`
      DELETE FROM decision_requests
      WHERE id IN (
        SELECT id
        FROM decision_requests
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxRows).changes;
  }

  return deleted;
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

  // Persisted server logs, on the same 60s gate as the requests prune above.
  deleted += pruneServerLogs(db, nowMs);

  // Expired idempotency claims, cache rows and dashboard sessions, on the
  // same 60s gate. All are TTL'd stores with no reader past expiry and no
  // other sweeper.
  deleted += pruneExpiredClaims(db, nowMs);
  // Web-search attempt log, same gate (see pruneSearchLogs).
  deleted += pruneSearchLogs(db, nowMs);
  // Decision-model attempt log, same gate (see pruneDecisionLogs).
  deleted += pruneDecisionLogs(db, nowMs);

  // Hourly aggregate prune (gated once per day). The UI's widest window is
  // 30d, so we keep at most 30 days of hourly buckets (~720 rows). The table
  // is the source of truth for analytics totals — never prune more aggressively
  // than the UI range, or the 30d count will silently drop again.
  // Guarded against the table being absent (tests that init a DB before the
  // migration runs would otherwise crash the prune loop).
  // Quota observation log, once a day — or again next tick while a large
  // backlog is still being worked off in budgeted chunks.
  if (nowMs >= nextQuotaObservationsPruneAtMs) {
    const sweep = pruneQuotaObservations(db, nowMs);
    deleted += sweep.deleted;
    nextQuotaObservationsPruneAtMs = nowMs + (sweep.done ? HOURLY_PRUNE_INTERVAL_MS : PRUNE_INTERVAL_MS);
  }

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
