import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS learned_output_caps (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      endpoint_scope TEXT NOT NULL DEFAULT '',
      max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 1024),
      learned_at_ms INTEGER NOT NULL,
      PRIMARY KEY (platform, model_id, endpoint_scope)
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS provider_circuit_breakers (
      platform TEXT NOT NULL,
      endpoint_scope TEXT NOT NULL DEFAULT '',
      failure_count INTEGER NOT NULL DEFAULT 0,
      window_started_at_ms INTEGER NOT NULL,
      open_until_ms INTEGER,
      probe_lease_until_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (platform, endpoint_scope)
    )
  `).run();
}

export function down(db: Db): void {
  db.prepare('DROP TABLE IF EXISTS provider_circuit_breakers').run();
  db.prepare('DROP TABLE IF EXISTS learned_output_caps').run();
}
