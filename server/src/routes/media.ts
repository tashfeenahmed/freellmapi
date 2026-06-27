import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
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
    const existingKey = db.prepare(`
      SELECT id, encrypted_key, iv, auth_tag
        FROM api_keys
       WHERE platform = 'custom' AND base_url = ?
       LIMIT 1
    `).get(baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;
    let keyId: number;
    let storedKeyForMask = providedKey ?? 'no-key';
    if (existingKey) {
      keyId = existingKey.id;
      if (providedKey) {
        const { encrypted, iv, authTag } = encrypt(providedKey);
        db.prepare(`
          UPDATE api_keys
             SET label = COALESCE(?, label),
                 encrypted_key = ?,
                 iv = ?,
                 auth_tag = ?,
                 status = 'unknown',
                 enabled = 1
           WHERE id = ?
        `).run(label ?? null, encrypted, iv, authTag, keyId);
        storedKeyForMask = providedKey;
      } else {
        try {
          storedKeyForMask = decrypt(existingKey.encrypted_key, existingKey.iv, existingKey.auth_tag);
        } catch {
          storedKeyForMask = 'no-key';
        }
        db.prepare(`
          UPDATE api_keys
             SET label = COALESCE(?, label), status = 'unknown', enabled = 1
           WHERE id = ?
        `).run(label ?? null, keyId);
      }
    } else {
      const { encrypted, iv, authTag } = encrypt(providedKey ?? 'no-key');
      const key = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
      `).run(label ?? 'Custom', encrypted, iv, authTag, baseUrl);
      keyId = Number(key.lastInsertRowid);
    }

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

    if (existingModel) {
      db.prepare(`
        UPDATE media_models
           SET display_name = ?,
               modality = ?,
               priority = ?,
               enabled = 1,
               quota_label = ?,
               key_id = ?
         WHERE id = ?
      `).run(displayName, parsed.data.modality, priority, quotaLabel, keyId, existingModel.id);
      return { modelDbId: existingModel.id, keyId, storedKeyForMask };
    }

    const model = db.prepare(`
      INSERT INTO media_models
        (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
      VALUES ('custom', ?, ?, ?, ?, 1, ?, ?)
    `).run(modelId, displayName, parsed.data.modality, priority, quotaLabel, keyId);
    return { modelDbId: Number(model.lastInsertRowid), keyId, storedKeyForMask };
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

  const info = getDb().prepare("DELETE FROM media_models WHERE id = ? AND platform = 'custom'").run(id);
  if (info.changes === 0) {
    res.status(404).json({ error: { message: `Unknown custom media model ${id}` } });
    return;
  }
  res.json({ success: true });
});
