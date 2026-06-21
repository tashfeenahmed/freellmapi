import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
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

  res.json({
    models: listAllMediaModels().map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      modality: r.modality,
      enabled: r.enabled === 1,
      quotaLabel: r.quota_label,
      keyCount: keyCounts.get(r.platform) ?? 0,
    })),
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
