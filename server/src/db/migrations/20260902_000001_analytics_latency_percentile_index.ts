// Migration: covering index for the analytics latency percentiles
// Created: 2026-09-02
//
// DOWN: reversible
//
// GET /api/analytics/summary computes p50 and p95 latency by nearest rank:
// count the rows in the range that recorded a latency, then
//
//   SELECT latency_ms FROM requests
//   WHERE created_at >= ? AND latency_ms IS NOT NULL
//   ORDER BY latency_ms ASC LIMIT 1 OFFSET ?
//
// twice per call. With only idx_requests_created_at the planner seeks the
// range, then has to visit every row in it to read latency_ms and sort. The
// (created_at, latency_ms) index covers the whole query, so the sort runs over
// the index alone and never touches the table. Measured on a 470k-row log:
// ~50ms -> ~30ms per percentile.
//
// Two other candidates were measured and rejected: (created_at, platform,
// latency_ms) is never chosen for the per-platform p95 because of the
// api_keys join, and (created_at, status) loses to idx_requests_created_at
// on the ORDER BY created_at DESC listing. Both would have cost ~31MB on the
// per-request insert path for nothing.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_created_latency
      ON requests(created_at, latency_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_requests_created_latency;
  `);
}
