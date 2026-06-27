import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

function addKeyIdColumn(db: Database.Database, table: string): void {
  if (!hasColumn(db, table, 'key_id')) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN key_id INTEGER`).run();
  }
}

function dropKeyIdColumn(db: Database.Database, table: string): void {
  if (hasColumn(db, table, 'key_id')) {
    db.prepare(`ALTER TABLE ${table} DROP COLUMN key_id`).run();
  }
}

export function up(db: Database.Database): void {
  addKeyIdColumn(db, 'embedding_models');
  addKeyIdColumn(db, 'media_models');
  db.prepare('CREATE INDEX IF NOT EXISTS idx_embedding_models_key_id ON embedding_models(key_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_media_models_key_id ON media_models(key_id)').run();
}

export function down(db: Database.Database): void {
  db.prepare('DROP INDEX IF EXISTS idx_embedding_models_key_id').run();
  db.prepare('DROP INDEX IF EXISTS idx_media_models_key_id').run();
  dropKeyIdColumn(db, 'media_models');
  dropKeyIdColumn(db, 'embedding_models');
}
