import type { Db } from '../types.js';

/**
 * Migration: request_attempts.key_label — the operator-facing key identifier
 * for the failover ladder (#869).
 *
 * The ladder shows key1/key2 (key_ordinal), which tells you WHICH position in
 * the request's own rotation was tried but not WHICH key row that was — with
 * several keys per provider, "key2" is meaningless once the list is reordered.
 * This nullable column stores the api_keys.label at attempt time (NULL when the
 * key had no label, or for pre-existing rows where it is unknown).
 *
 * NOT the internal key id, and NOT the encrypted key: a stable, user-assigned
 * label is what the dashboard can show in a tooltip without leaking the id or
 * the credential. The label is a snapshot — if the operator renames the key
 * later, historical attempts keep the label they actually used.
 */
export function up(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'key_label')) {
    db.prepare('ALTER TABLE request_attempts ADD COLUMN key_label TEXT').run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'key_label')) {
    db.prepare('ALTER TABLE request_attempts DROP COLUMN key_label').run();
  }
}
