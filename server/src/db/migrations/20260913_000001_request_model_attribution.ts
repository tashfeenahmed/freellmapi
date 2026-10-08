// Migration: stamp request history with the concrete model row (#1187)
//
// DOWN: reversible
//
// Custom relays can expose the same upstream model id, so (platform, model_id)
// no longer uniquely identifies the `models` row whose pricing, reliability,
// and speed apply. Today request identity is derived at read time from
// api_keys.base_url: deleting a key, or editing its base URL, retroactively
// reattributes (or orphans) all of that key's historical requests.
//
// This migration freezes request identity by stamping each request with the
// concrete `models.id` that served it. Catalog requests resolve by
// (platform, model_id); custom requests resolve through the request's key
// (its normalized base_url is the row's endpoint_scope). Custom requests
// whose key never reached routing (key_id IS NULL) stay NULL — an
// unattributable request must not land on the wrong relay.
//
// No foreign key on models(id) — request history must survive the user
// deleting the model row that once served it.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(c => c.name === column);
}

export function up(db: Db): void {
  if (hasColumn(db, 'requests', 'model_db_id')) return;

  // Add the column (nullable — unattributed requests keep NULL).
  db.prepare('ALTER TABLE requests ADD COLUMN model_db_id INTEGER').run();

  // Non-unique index for backfill scans and future analytics queries.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_model_db_id ON requests(model_db_id)').run();

  // Backfill catalog requests: (platform, model_id) → models.id
  // These are unambiguous — catalog rows are unique on (platform, model_id).
  // SQLite UPDATE has no table alias; correlate via the full table name.
  db.prepare(`
    UPDATE requests
    SET model_db_id = (
      SELECT m.id FROM models m
      WHERE m.platform = requests.platform AND m.model_id = requests.model_id
      LIMIT 1
    )
    WHERE requests.platform != 'custom'
  `).run();

  // Backfill custom requests: key_id → api_keys.base_url → models.endpoint_scope
  // Only while the saved key still resolves to a matching row.
  db.prepare(`
    UPDATE requests
    SET model_db_id = (
      SELECT m.id FROM models m
      JOIN api_keys k ON k.id = requests.key_id AND k.platform = 'custom'
      WHERE m.platform = 'custom'
        AND m.model_id = requests.model_id
        AND m.endpoint_scope = rtrim(trim(k.base_url), '/')
      LIMIT 1
    )
    WHERE requests.platform = 'custom' AND requests.key_id IS NOT NULL
  `).run();

  // Orphaned custom history stays NULL — better than being attributed to the
  // wrong relay. The two UPDATEs above are best-effort: if a custom key was
  // deleted or its base_url changed, the JOIN drops out and model_db_id stays
  // NULL (which is exactly the "unattributable" semantics we want).
}

export function down(db: Db): void {
  if (!hasColumn(db, 'requests', 'model_db_id')) return;
  db.prepare('DROP INDEX IF EXISTS idx_requests_model_db_id').run();
  db.prepare('ALTER TABLE requests DROP COLUMN model_db_id').run();
}
