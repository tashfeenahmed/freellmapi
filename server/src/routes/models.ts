import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';

export const modelsRouter = Router();

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});

// Delete a custom model (only custom models can be deleted by the user)
modelsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT platform, key_id FROM models WHERE id = ?").get(id) as { platform: string; key_id: number | null } | undefined;
  
  if (!row) {
    res.status(404).json({ error: { message: 'Model not found' } });
    return;
  }

  if (row.platform !== 'custom') {
    res.status(403).json({ error: { message: 'Only custom models can be deleted' } });
    return;
  }

  const remove = db.transaction(() => {
    // 1. Remove from fallback_config
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    
    // 2. Remove from models
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
    
    // 3. Clean up the parent api_key if it was the last model using it
    if (row.key_id != null) {
      const remainingModels = db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'custom' AND key_id = ?").get(row.key_id) as { n: number };
      if (remainingModels.n === 0) {
        db.prepare('DELETE FROM api_keys WHERE id = ?').run(row.key_id);
      }
    }
  });
  
  remove();
  res.json({ success: true });
});
