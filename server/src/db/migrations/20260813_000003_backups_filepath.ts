import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** The data-backup feature stores `.sql` dumps next to the database. The old
 *  JSON metadata row only tracked `filename`; `filepath` records the absolute
 *  location so restore/download survive a later change to the backup path. */
export function up(db: Db): void {
  if (!hasColumn(db, 'backups', 'filepath')) {
    db.prepare('ALTER TABLE backups ADD COLUMN filepath TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'backups', 'filepath')) {
    db.prepare('ALTER TABLE backups DROP COLUMN filepath').run();
  }
}
