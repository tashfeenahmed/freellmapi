import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Persist the most recent failed health-probe reason for local diagnostics. */
export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'last_health_error')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN last_health_error TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'api_keys', 'last_health_error')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN last_health_error').run();
  }
}
