import type { Db } from '../db/types.js';
import { getModelBoundKeyIds, type CustomModality } from './custom-key-upsert.js';

// After a custom binding (model, key) is removed, a model with no remaining
// bindings can no longer route and a key with no remaining bindings no longer
// serves any custom model. This helper cascades those orphans, plus the
// fallback_config rows that referenced a deleted model.

function deleteCustomModelRow(db: Db, modality: CustomModality, modelDbId: number): void {
  db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(modelDbId);
  const table = modality === 'chat' ? 'models'
    : modality === 'embedding' ? 'embedding_models' : 'media_models';
  db.prepare(`DELETE FROM ${table} WHERE id = ? AND platform = 'custom'`).run(modelDbId);
}

export function cleanupAfterBindingsRemoved(
  db: Db,
  modality: CustomModality,
  modelDbId: number,
  formerKeyIds: number[],
): void {
  const stillBound = db.prepare(
    'SELECT 1 FROM custom_key_bindings WHERE modality = ? AND model_db_id = ? LIMIT 1',
  ).get(modality, modelDbId);
  if (!stillBound) {
    deleteCustomModelRow(db, modality, modelDbId);
  }
  for (const keyId of formerKeyIds) {
    const keyStillUsed = db.prepare(
      'SELECT 1 FROM custom_key_bindings WHERE key_id = ? LIMIT 1',
    ).get(keyId);
    if (!keyStillUsed) {
      db.prepare("DELETE FROM api_keys WHERE id = ? AND platform = 'custom'").run(keyId);
    }
  }
}

export function deleteCustomModelAndCleanup(
  db: Db,
  modality: CustomModality,
  modelDbId: number,
): void {
  const keyIds = getModelBoundKeyIds(db, modality, modelDbId);
  db.prepare('DELETE FROM custom_key_bindings WHERE modality = ? AND model_db_id = ?')
    .run(modality, modelDbId);
  cleanupAfterBindingsRemoved(db, modality, modelDbId, keyIds);
}
