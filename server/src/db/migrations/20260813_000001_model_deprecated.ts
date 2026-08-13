import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Mark catalog/custom models as deprecated so they stay visible but drop out
 *  of routing (see the Config page's model management tab). */
export function up(db: Db): void {
  if (!hasColumn(db, 'models', 'deprecated')) {
    db.prepare('ALTER TABLE models ADD COLUMN deprecated INTEGER NOT NULL DEFAULT 0').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'models', 'deprecated')) {
    db.prepare('ALTER TABLE models DROP COLUMN deprecated').run();
  }
}
