// Migration: lookup indexes for the provider quota observation log
// Created: 2026-09-01
//
// DOWN: reversible
//
// provider_quota_observations is an append-only log: every quota header, 429
// body and probe result lands here, so a busy install accumulates hundreds of
// thousands of rows within weeks. Two readers were paying for that on every
// dashboard poll:
//
//   - getQuotaStateForKeys() needs the NEWEST observation per
//     (platform, key_id, quota_pool_key, metric) — one row for each of the few
//     dozen provider_quota_state rows. The baseline index
//     (platform, key_id, observed_at) cannot answer that per pool+metric, so
//     the query window-functioned the whole log (raw_json included) and held
//     the event loop for seconds. GET /api/health and GET /api/free-tier call
//     it, and the Keys page polls the former every 30s.
//   - the retention sweep deletes by created_at, which had no index at all.
//
// The composite index turns the per-state lookup into a single seek; the
// created_at index keeps the prune a range delete.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_latest
      ON provider_quota_observations(platform, key_id, quota_pool_key, metric, observed_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_created_at
      ON provider_quota_observations(created_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_provider_quota_observations_created_at;
    DROP INDEX IF EXISTS idx_provider_quota_observations_latest;
  `);
}
