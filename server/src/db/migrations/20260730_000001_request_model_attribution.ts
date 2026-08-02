// Migration: attach request history to the concrete model row that served it.
// Created: 2026-07-30
//
// Custom relays may share an upstream model id, so (platform, model_id) is no
// longer enough to identify the row whose price, reliability, and speed apply.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some(candidate => candidate.name === column);
}

export function up(db: Db): void {
  // Deliberately no foreign key: request history must survive a user deleting
  // the model row it once served. This also keeps cleanup paths from requiring
  // a raw-history delete first.
  if (!hasColumn(db, 'requests', 'model_db_id')) {
    db.exec('ALTER TABLE requests ADD COLUMN model_db_id INTEGER;');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_requests_model_db_id ON requests(model_db_id);');

  // Historical catalog requests remain unambiguous. A custom request can be
  // attributed only while its key survives: the key's normalized base URL is
  // the endpoint_scope of the concrete model row. Leave orphaned custom rows
  // NULL rather than assigning their traffic to the wrong relay.
  db.exec(`
    UPDATE requests
       SET model_db_id = (
         SELECT m.id
           FROM models m
          WHERE m.platform = requests.platform
            AND m.model_id = requests.model_id
            AND (
              m.platform != 'custom'
              OR m.endpoint_scope = (
                SELECT rtrim(trim(k.base_url), '/')
                  FROM api_keys k
                 WHERE k.id = requests.key_id
                   AND k.platform = 'custom'
              )
            )
          LIMIT 1
       )
     WHERE model_db_id IS NULL;
  `);
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_requests_model_db_id;');
  if (hasColumn(db, 'requests', 'model_db_id')) {
    db.exec('ALTER TABLE requests DROP COLUMN model_db_id;');
  }
}
