import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { deleteCustomModelAndCleanup } from '../lib/custom-provider-cleanup.js';
import { findOrInsertCustomKey, upsertBinding, removeBinding, getModelBoundKeyIds, type CustomModality } from '../lib/custom-key-upsert.js';
import { listAllMediaModels } from '../services/media.js';

export const mediaRouter = Router();

// Generative-media models (image + audio/TTS) for the dashboard Image/Audio tabs.
// Mirrors the embeddings tab: a flat list with an enable toggle per row. keyCount
// surfaces whether the row's platform has a usable key configured.
mediaRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const keyCounts = new Map(
    (db.prepare(
      "SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform",
    ).all() as { platform: string; n: number }[]).map(r => [r.platform, r.n]),
  );
  const customKeyIds = new Set(
    (db.prepare(
      "SELECT id FROM api_keys WHERE platform = 'custom' AND enabled = 1 AND status IN ('healthy', 'unknown')",
    ).all() as { id: number }[]).map(r => r.id),
  );

  res.json({
    models: listAllMediaModels().map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      modality: r.modality,
      enabled: r.enabled === 1,
      quotaLabel: r.quota_label,
      keyCount: r.platform === 'custom' && r.key_id != null
        ? (customKeyIds.has(r.key_id) ? 1 : 0)
        : keyCounts.get(r.platform) ?? 0,
      isCustom: r.platform === 'custom',
    })),
  });
});

const customMediaSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1),
  displayName: z.string().optional(),
  modality: z.enum(['image', 'audio']),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  quotaLabel: z.string().optional(),
});

mediaRouter.post('/custom', (req: Request, res: Response) => {
  const parsed = customMediaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  if (!modelId) {
    res.status(400).json({ error: { message: 'model is required' } });
    return;
  }
  const displayName = parsed.data.displayName?.trim() || modelId;
  const label = parsed.data.label?.trim() || undefined;
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const quotaLabel = parsed.data.quotaLabel?.trim() || 'custom endpoint';

  const upsert = db.transaction(() => {
    const { processedKeyId, storedKeyForMask } = findOrInsertCustomKey(db, {
      baseUrl,
      apiKey: providedKey,
      label,
    });

    const existingModel = db.prepare(`
      SELECT id, modality, priority
        FROM media_models
       WHERE platform = 'custom' AND model_id = ?
       LIMIT 1
    `).get(modelId) as { id: number; modality: string; priority: number } | undefined;
    const priority = existingModel && existingModel.modality === parsed.data.modality
      ? existingModel.priority
      : (db.prepare('SELECT COALESCE(MAX(priority), 0) AS maxPriority FROM media_models WHERE modality = ?')
        .get(parsed.data.modality) as { maxPriority: number }).maxPriority + 1;

    let modelDbId: number;
    if (existingModel) {
      db.prepare(`
        UPDATE media_models
           SET display_name = ?,
               modality = ?,
               priority = ?,
               enabled = 1,
               quota_label = ?
         WHERE id = ?
      `).run(displayName, parsed.data.modality, priority, quotaLabel, existingModel.id);
      modelDbId = existingModel.id;
    } else {
      const model = db.prepare(`
        INSERT INTO media_models
          (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
        VALUES ('custom', ?, ?, ?, ?, 1, ?, ?)
      `).run(modelId, displayName, parsed.data.modality, priority, quotaLabel, processedKeyId);
      modelDbId = Number(model.lastInsertRowid);
    }

    upsertBinding(db, parsed.data.modality as CustomModality, modelDbId, processedKeyId);
    return { modelDbId, keyId: processedKeyId, storedKeyForMask };
  });

  const result = upsert();
  res.status(201).json({
    success: true,
    keyId: result.keyId,
    modelDbId: result.modelDbId,
    platform: 'custom',
    baseUrl,
    model: modelId,
    displayName,
    modality: parsed.data.modality,
    maskedKey: maskKey(result.storedKeyForMask),
  });
});

const updateSchema = z.object({ enabled: z.boolean() });

mediaRouter.put('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }
  const info = getDb().prepare('UPDATE media_models SET enabled = ? WHERE id = ?').run(parsed.data.enabled ? 1 : 0, id);
  if (info.changes === 0) {
    res.status(404).json({ error: { message: `Unknown media model ${id}` } });
    return;
  }
  res.json({ success: true });
});

mediaRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT modality FROM media_models WHERE id = ? AND platform = 'custom'").get(id) as { modality: 'image' | 'audio' } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom media model ${id}` } });
    return;
  }
  const remove = db.transaction(() => {
    deleteCustomModelAndCleanup(db, row.modality as CustomModality, id);
  });
  remove();
  res.json({ success: true });
});

mediaRouter.delete('/custom/:id/keys/:keyId', (req: Request, res: Response) => {
  const modelDbId = Number(req.params.id);
  const keyId = Number(req.params.keyId);
  if (!Number.isInteger(modelDbId) || !Number.isInteger(keyId)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT modality FROM media_models WHERE id = ? AND platform = 'custom'").get(modelDbId) as { modality: 'image' | 'audio' } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom media model ${modelDbId}` } });
    return;
  }
  const modality = row.modality as CustomModality;
  const bound = db.prepare(
    'SELECT 1 FROM custom_key_bindings WHERE modality = ? AND model_db_id = ? AND key_id = ?',
  ).get(modality, modelDbId, keyId);
  if (!bound) {
    res.status(404).json({ error: { message: `Key ${keyId} is not bound to custom media model ${modelDbId}` } });
    return;
  }

  const remove = db.transaction(() => {
    const formerKeyIds = getModelBoundKeyIds(db, modality, modelDbId);
    removeBinding(db, modality, modelDbId, keyId);
    const stillBound = formerKeyIds.filter(k => k !== keyId).length > 0;
    if (!stillBound) {
      db.prepare("DELETE FROM media_models WHERE id = ? AND platform = 'custom'").run(modelDbId);
    }
    const keyStillUsed = db.prepare('SELECT 1 FROM custom_key_bindings WHERE key_id = ? LIMIT 1').get(keyId);
    if (!keyStillUsed) {
      db.prepare("DELETE FROM api_keys WHERE id = ? AND platform = 'custom'").run(keyId);
    }
  });
  remove();
  res.json({ success: true });
});

mediaRouter.delete('/custom/:id/keys/:keyId', (req: Request, res: Response) => {
  const modelDbId = Number(req.params.id);
  const keyId = Number(req.params.keyId);
  if (!Number.isInteger(modelDbId) || !Number.isInteger(keyId)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT modality FROM media_models WHERE id = ? AND platform = 'custom'").get(modelDbId) as { modality: 'image' | 'audio' } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom media model ${modelDbId}` } });
    return;
  }
  const modality = row.modality as CustomModality;
  const bound = db.prepare(
    'SELECT 1 FROM custom_key_bindings WHERE modality = ? AND model_db_id = ? AND key_id = ?',
  ).get(modality, modelDbId, keyId);
  if (!bound) {
    res.status(404).json({ error: { message: `Key ${keyId} is not bound to custom media model ${modelDbId}` } });
    return;
  }

  const remove = db.transaction(() => {
    const formerKeyIds = getModelBoundKeyIds(db, modality, modelDbId);
    removeBinding(db, modality, modelDbId, keyId);
    const stillBound = formerKeyIds.filter(k => k !== keyId).length > 0;
    if (!stillBound) {
      db.prepare("DELETE FROM media_models WHERE id = ? AND platform = 'custom'").run(modelDbId);
    }
    const keyStillUsed = db.prepare('SELECT 1 FROM custom_key_bindings WHERE key_id = ? LIMIT 1').get(keyId);
    if (!keyStillUsed) {
      db.prepare("DELETE FROM api_keys WHERE id = ? AND platform = 'custom'").run(keyId);
    }
  });
  remove();
  res.json({ success: true });
});
