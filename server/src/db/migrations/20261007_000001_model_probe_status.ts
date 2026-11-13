// model_probe_status — proactive per-model probe results (#1438 PR 1).
//
// One row per (platform, model_id, endpoint_scope, key_id): the outcome of the
// most recent proactive probe for that routable model+key pair. Purely
// observational — nothing in routing or scoring reads this table in this PR;
// a follow-up consumes the labels. DOWN drops the table; probe data is a
// cache of reality, not a record, so dropping it loses nothing.
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS model_probe_status (
    platform TEXT NOT NULL,
    model_id TEXT NOT NULL,
    endpoint_scope TEXT,
    key_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_probed_at TEXT,
    last_error TEXT,
    latency_ms INTEGER,
    PRIMARY KEY (platform, model_id, endpoint_scope, key_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_probe_status_probed_at
    ON model_probe_status(last_probed_at)`);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS model_probe_status');
}
