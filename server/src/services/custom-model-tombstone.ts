// Keep user-deleted custom models deleted across the scheduled model sync.
//
// Issue #926: catalog-managed models carry a tombstone so catalog-sync never
// resurrects a model the user deleted. The scheduled custom-model sync
// (services/custom-model-sync.ts) had no equivalent, so deleting a custom
// relay's model (or its whole endpoint key) was undone by the next sync pass:
// the sync only checks whether the model id is still present in the `models`
// table, and treats a deletion as "new" again.
//
// This module holds the same contract for custom rows, keyed by
// (endpoint_scope, model_id) — the exact identity a custom model row has today
// (#651), so deleting a model on one relay never suppresses the identical id
// on another. A tombstone is "keep it deleted" and is cleared the moment the
// operator EXPLICITLY re-registers that model on the same endpoint.

import type { Db } from '../db/types.js';

export function recordCustomModelTombstone(
  db: Db,
  endpointScope: string,
  modelId: string,
): void {
  db.prepare(`
    INSERT INTO custom_model_tombstones (endpoint_scope, model_id)
    VALUES (?, ?)
    ON CONFLICT(endpoint_scope, model_id)
    DO UPDATE SET created_at = datetime('now')
  `).run(endpointScope, modelId);
}

export function isCustomModelTombstoned(
  db: Db,
  endpointScope: string,
  modelId: string,
): boolean {
  return db.prepare(
    'SELECT 1 FROM custom_model_tombstones WHERE endpoint_scope = ? AND model_id = ?',
  ).get(endpointScope, modelId) !== undefined;
}

export function clearCustomModelTombstone(
  db: Db,
  endpointScope: string,
  modelId: string,
): void {
  db.prepare('DELETE FROM custom_model_tombstones WHERE endpoint_scope = ? AND model_id = ?')
    .run(endpointScope, modelId);
}
