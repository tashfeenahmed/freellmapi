// ── Model-level health observation log ──────────────────────────────────────
// Companion to the in-memory model-failure window in lib/fallback-loop.ts
// (noteModelFailure / clearModelFailure). The in-memory window is the live
// source of truth for routing; this module persists its coarse verdict
// (working / failing / unknown) across restarts and gives operators a stable
// read path.
//
// The two code paths that mutate the in-memory window also call here, so the
// persisted row tracks the in-memory verdict 1:1:
//   - recordRetryableFailure (lib/fallback-loop.ts:342) on a retryable upstream
//     error → may trip the MODEL_FAILURE_THRESHOLD → status 'failing'
//   - recordUpstreamSuccess (lib/fallback-loop.ts:448) after a completed attempt
//     → clears the in-memory streak → status 'working'
//
// The snapshot table (model_health_status) holds one row per (platform,
// model_id). The optional observation log (model_health_observations) is the
// richer audit trail operators can query when they need "when did this model
// start failing / what error class was last seen" beyond the snapshot's
// coarse status. It is populated ONLY when the caller supplies an error —
// successes and empty observations are never written, so the log does not
// grow on the healthy path.

import { getDb } from '../db/index.js';
import type { RouteResult } from '../services/router.js';
import type { Db } from '../db/types.js';

const OBSERVATION_LOG_DISABLED = false;

export type ModelHealthStatus = 'unknown' | 'working' | 'failing';

const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// ── Snapshot (always written) ──────────────────────────────────────────────

export function observeModelHealth(
  route: RouteResult,
  status: ModelHealthStatus,
  nowMs?: number,
): void {
  const db = getDb();
  const now = nowMs ?? Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO model_health_status
      (platform, model_id, status, last_observation_at, last_working_at, last_failure_at, failure_count_in_window, window_start_ms)
    VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?)
  `).run(
    route.platform,
    route.modelId,
    status,
    status === 'working' ? new Date(now).toISOString() : null,
    status === 'failing' ? new Date(now).toISOString() : null,
    status === 'failing' ? FAILURE_THRESHOLD : 0,
    status === 'failing' ? now : null,
  );
}

export function readAllModelHealthStatus(): Array<{
  platform: string;
  model_id: string;
  status: ModelHealthStatus;
  last_observation_at: string;
  last_working_at: string | null;
  last_failure_at: string | null;
  failure_count_in_window: number;
}> {
  const db = getDb();
  return db.prepare(`
    SELECT
      platform, model_id, status, last_observation_at,
      last_working_at, last_failure_at, failure_count_in_window
    FROM model_health_status
    ORDER BY platform, model_id
  `).all() as Array<{
    platform: string;
    model_id: string;
    status: ModelHealthStatus;
    last_observation_at: string;
    last_working_at: string | null;
    last_failure_at: string | null;
    failure_count_in_window: number;
  }>;
}

export function readModelHealthStatusByPlatform(
  platform: string,
): Array<{ model_id: string; status: ModelHealthStatus; last_failure_at: string | null }> {
  const db = getDb();
  return db.prepare(`
    SELECT model_id, status, last_failure_at
    FROM model_health_status
    WHERE platform = ?
    ORDER BY model_id
  `).all(platform) as Array<{ model_id: string; status: ModelHealthStatus; last_failure_at: string | null }>;
}

export function readFailingModelIds(platform: string): Set<string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT model_id FROM model_health_status
    WHERE platform = ? AND status = 'failing'
  `).all(platform) as Array<{ model_id: string }>;
  return new Set(rows.map(r => r.model_id));
}

// ── Observation log (optional detail) ──────────────────────────────────────

export type ModelHealthObservationErrorClass =
  | 'auth' | 'out_of_credits' | 'daily_quota_exhausted' | 'model_not_found'
  | 'forbidden' | 'context_too_large' | 'provider_bad_request' | 'empty_completion'
  | 'format_ignored' | 'invalid_tool_arguments' | 'timeout' | 'rate_limited'
  | 'upstream_error' | 'error';

interface ObservationRow {
  platform: string;
  modelId: string;
  keyId: number;
  status: ModelHealthStatus;
  errorClass: ModelHealthObservationErrorClass | null;
  errorMessage: string | null;
  observedAt: string;
}

export function observeModelHealthFailure(
  route: RouteResult,
  errorClass: ModelHealthObservationErrorClass,
  errorMessage: string | null,
  nowMs?: number,
): void {
  if (OBSERVATION_LOG_DISABLED) return;
  const db = getDb();
  const now = nowMs ?? Date.now();
  db.prepare(`
    INSERT INTO model_health_observations (platform, model_id, key_id, status, error_class, error_message, observed_at)
    VALUES (?, ?, ?, 'failing', ?, ?, ?)
  `).run(route.platform, route.modelId, route.keyId, errorClass, errorMessage, new Date(now).toISOString());
}

export function readRecentModelHealthObservations(
  platform: string, modelId: string, since?: string, limit = 50,
): ObservationRow[] {
  const db = getDb();
  if (since) {
    return db.prepare(`
      SELECT platform, model_id, key_id, status, error_class, error_message, observed_at
      FROM model_health_observations
      WHERE platform = ? AND model_id = ? AND observed_at >= ?
      ORDER BY observed_at DESC LIMIT ?
    `).all(platform, modelId, since, limit) as ObservationRow[];
  }
  return db.prepare(`
    SELECT platform, model_id, key_id, status, error_class, error_message, observed_at
    FROM model_health_observations
    WHERE platform = ? AND model_id = ?
    ORDER BY observed_at DESC LIMIT ?
  `).all(platform, modelId, limit) as ObservationRow[];
}

// ── Wire in to the fallback loop's two bookkeeping hooks ───────────────────

export function recordModelHealthFailing(
  route: RouteResult,
  errorClass: ModelHealthObservationErrorClass | null,
  errorMessage: string | null,
): void {
  observeModelHealth(route, 'failing');
  if (errorClass) observeModelHealthFailure(route, errorClass, errorMessage);
}

export function recordModelHealthWorking(route: RouteResult): void {
  observeModelHealth(route, 'working');
}

export function resetModelHealth(platform: string, modelId: string): number {
  const db = getDb();
  return db.prepare(`
    UPDATE model_health_status
    SET status = 'unknown', last_observation_at = datetime('now'),
        last_working_at = NULL, last_failure_at = NULL,
        failure_count_in_window = 0, window_start_ms = NULL
    WHERE platform = ? AND model_id = ?
  `).run(platform, modelId).changes;
}

export function resetAllModelHealth(): number {
  const db = getDb();
  return db.prepare(`
    UPDATE model_health_status
    SET status = 'unknown', last_observation_at = datetime('now'),
        last_working_at = NULL, last_failure_at = NULL,
        failure_count_in_window = 0, window_start_ms = NULL
  `).run().changes;
}
