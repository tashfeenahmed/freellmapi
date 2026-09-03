import type { Db } from '../db/types.js';
import { customEndpointKeyIds } from './custom-endpoint.js';

// ── Shared custom MEDIA-model registration (#1051) ───────────────────────────
//
// POST /api/media/custom and the classified branch of POST /api/keys/custom
// register image/audio/transcription models against a user's own endpoint
// through the SAME upsert, exactly like custom-model-register.ts does for chat
// models. This used to live inline in routes/media.ts.

export type CustomMediaModality = 'image' | 'audio' | 'transcription';

export interface CustomMediaEntry {
  modelId: string;
  displayName: string | null;
  modality: CustomMediaModality;
  quotaLabel?: string;
}

export interface RegisteredCustomMediaModel {
  modelDbId: number;
  model: string;
  modality: CustomMediaModality;
  created: boolean;
}

/**
 * Upsert one media model row against an ALREADY-resolved endpoint key, inside
 * the caller's transaction. media_models identity is (platform, model_id) with
 * no endpoint_scope — a model already on this endpoint keeps the key it has;
 * only a move to a different endpoint re-binds it (#619 semantics).
 */
export function registerCustomMediaModel(
  db: Db,
  keyId: number,
  entry: CustomMediaEntry,
): RegisteredCustomMediaModel {
  const endpointKeyIds = customEndpointKeyIds(db, keyId);
  const modelId = entry.modelId;
  const quotaLabel = entry.quotaLabel?.trim() || 'custom endpoint';

  const existingModel = db.prepare(`
    SELECT id, modality, priority, key_id
      FROM media_models
     WHERE platform = 'custom' AND model_id = ?
     LIMIT 1
  `).get(modelId) as { id: number; modality: string; priority: number; key_id: number | null } | undefined;
  const bindKeyId = existingModel?.key_id != null && endpointKeyIds.has(existingModel.key_id)
    ? existingModel.key_id
    : keyId;
  const priority = existingModel && existingModel.modality === entry.modality
    ? existingModel.priority
    : (db.prepare('SELECT COALESCE(MAX(priority), 0) AS maxPriority FROM media_models WHERE modality = ?')
      .get(entry.modality) as { maxPriority: number }).maxPriority + 1;

  if (existingModel) {
    db.prepare(`
      UPDATE media_models
         SET display_name = COALESCE(?, display_name),
             modality = ?,
             priority = ?,
             enabled = 1,
             quota_label = ?,
             key_id = ?
       WHERE id = ?
    `).run(entry.displayName, entry.modality, priority, quotaLabel, bindKeyId, existingModel.id);
    return { modelDbId: existingModel.id, model: modelId, modality: entry.modality, created: false };
  }

  const model = db.prepare(`
    INSERT INTO media_models
      (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
    VALUES ('custom', ?, ?, ?, ?, 1, ?, ?)
  `).run(modelId, entry.displayName ?? modelId, entry.modality, priority, quotaLabel, bindKeyId);
  return { modelDbId: Number(model.lastInsertRowid), model: modelId, modality: entry.modality, created: true };
}
