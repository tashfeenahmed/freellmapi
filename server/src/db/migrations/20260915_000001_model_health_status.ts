// Migration: model-level health observation log + current-status snapshot
// Created: 2026-09-15
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_health_status (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown', 'working', 'failing')),
      last_observation_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_working_at TEXT,
      last_failure_at TEXT,
      failure_count_in_window INTEGER NOT NULL DEFAULT 0,
      window_start_ms INTEGER,
      PRIMARY KEY (platform, model_id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_health_status_status ON model_health_status (status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_health_status_platform ON model_health_status (platform, status)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_health_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'failing'
        CHECK (status IN ('working', 'failing')),
      error_class TEXT,
      error_message TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_health_observations_platform_model ON model_health_observations (platform, model_id, observed_at)`);
}

export function down(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS model_health_observations`);
  db.exec(`DROP TABLE IF EXISTS model_health_status`);
}
