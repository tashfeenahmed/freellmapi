import type { Db } from '../types.js';

/**
 * Record WHO made each proxied call. All local clients share the single
 * unified API key, so the key can't distinguish callers — the client IP
 * (plus User-Agent for tunneled clients that all arrive as loopback) is the
 * only per-caller signal available to the analytics "Recent calls" view.
 *
 * Guarded like the baseline's column adds: catalog-sync re-runs migrations
 * over a live schema, so ALTERs must be idempotent.
 */
function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'requests', 'client_ip')) {
    db.prepare('ALTER TABLE requests ADD COLUMN client_ip TEXT').run();
  }
  if (!hasColumn(db, 'requests', 'client_user_agent')) {
    db.prepare('ALTER TABLE requests ADD COLUMN client_user_agent TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'requests', 'client_user_agent')) {
    db.prepare('ALTER TABLE requests DROP COLUMN client_user_agent').run();
  }
  if (hasColumn(db, 'requests', 'client_ip')) {
    db.prepare('ALTER TABLE requests DROP COLUMN client_ip').run();
  }
}
