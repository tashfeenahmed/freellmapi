import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, setSetting } from '../db/index.js';
import { listEmbeddingModels, getDefaultFamily, type EmbeddingModelRow } from '../services/embeddings.js';

export const embeddingsRouter = Router();

// Families with their provider chains, for the dashboard Embeddings tab.
embeddingsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const keyCounts = new Map(
    (db.prepare(
      "SELECT platform, COUNT(*) AS n FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform",
    ).all() as { platform: string; n: number }[]).map(r => [r.platform, r.n]),
  );

  const byFamily = new Map<string, EmbeddingModelRow[]>();
  for (const row of listEmbeddingModels()) {
    const list = byFamily.get(row.family) ?? [];
    list.push(row);
    byFamily.set(row.family, list);
  }

  const defaultFamily = getDefaultFamily();
  res.json({
    defaultFamily,
    families: [...byFamily.entries()].map(([family, rows]) => ({
      family,
      dimensions: rows[0].dimensions,
      maxInputTokens: rows[0].max_input_tokens,
      isDefault: family === defaultFamily,
      providers: rows.map(r => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        priority: r.priority,
        enabled: r.enabled === 1,
        quotaLabel: r.quota_label,
        keyCount: keyCounts.get(r.platform) ?? 0,
      })),
    })),
  });
});

const updateSchema = z.object({
  defaultFamily: z.string().optional(),
  providers: z.array(z.object({
    id: z.number(),
    priority: z.number(),
    enabled: z.boolean(),
  })).optional(),
});

embeddingsRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body' } });
    return;
  }
  const db = getDb();

  if (parsed.data.defaultFamily) {
    const exists = db.prepare('SELECT 1 FROM embedding_models WHERE family = ?').get(parsed.data.defaultFamily);
    if (!exists) {
      res.status(400).json({ error: { message: `Unknown family '${parsed.data.defaultFamily}'` } });
      return;
    }
    setSetting('embeddings_default_family', parsed.data.defaultFamily);
  }

  if (parsed.data.providers) {
    const update = db.prepare('UPDATE embedding_models SET priority = ?, enabled = ? WHERE id = ?');
    const apply = db.transaction((rows: { id: number; priority: number; enabled: boolean }[]) => {
      for (const r of rows) update.run(r.priority, r.enabled ? 1 : 0, r.id);
    });
    apply(parsed.data.providers);
  }

  res.json({ success: true });
});

// Per-family usage: requests today (most embedding quotas are daily/RPM) and
// tokens this calendar month, from the tagged request log.
embeddingsRouter.get('/usage', (_req: Request, res: Response) => {
  const db = getDb();
  const usage = db.prepare(`
    SELECT em.family,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) AS requests_today,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of month') THEN r.input_tokens ELSE 0 END), 0) AS tokens_month
    FROM embedding_models em
    LEFT JOIN requests r
      ON r.request_type = 'embedding'
     AND r.status = 'success'
     AND r.platform = em.platform
     AND r.model_id = em.model_id
     AND r.created_at >= datetime('now', 'start of month')
    GROUP BY em.family
  `).all() as { family: string; requests_today: number; tokens_month: number }[];

  res.json({
    families: usage.map(u => ({
      family: u.family,
      requestsToday: u.requests_today,
      tokensMonth: u.tokens_month,
    })),
  });
});
