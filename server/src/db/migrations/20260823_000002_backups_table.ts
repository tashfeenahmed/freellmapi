import type { Db } from '../types.js';

/** Metadata index for the data-backup feature. Backup payloads live on disk
 *  next to the database; this table is the paginated index. `filepath` records
 *  the absolute location so download and restore survive a later change to the
 *  configured backup directory. */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      filepath TEXT,
      filesize INTEGER NOT NULL,
      is_full INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      tables_json TEXT NOT NULL DEFAULT '[]'
    )
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS backups');
}
