import type { Db } from '../types.js';

export function up(db: Db): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS auxiliary_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(task_type, model_db_id)
    )
  `).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_auxiliary_config_task_type ON auxiliary_config(task_type)'
  ).run();
}

export function down(db: Db): void {
  db.prepare('DROP INDEX IF EXISTS idx_auxiliary_config_task_type').run();
  db.prepare('DROP TABLE IF EXISTS auxiliary_config').run();
}
