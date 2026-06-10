import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

export const costRouter = Router();

// GET /api/cost — list all models with their cost info
// Returns: { models: Array<{ id, platform, modelId, displayName, inputCostPer1M, outputCostPer1M, costUpdatedAt }> }
costRouter.get('/', (_req: Request, res: Response) => {
    const db = getDb();

    const rows = db.prepare(`
    SELECT
      id,
      platform,
      model_id,
      display_name,
      input_cost_per_1m,
      output_cost_per_1m,
      cost_updated_at
    FROM models
    ORDER BY platform ASC, display_name ASC
  `).all() as any[];

    const models = rows.map(r => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        inputCostPer1M: r.input_cost_per_1m,
        outputCostPer1M: r.output_cost_per_1m,
        costUpdatedAt: r.cost_updated_at,
    }));

    res.json({ models });
});

// PUT /api/cost — bulk update costs from JSON payload
// Body: { models: Array<{ id, inputCostPer1M, outputCostPer1M }> }
costRouter.put('/', (req: Request, res: Response) => {
    const db = getDb();
    const payload = req.body as { models?: Array<{ id: number; inputCostPer1M?: number | null; outputCostPer1M?: number | null }> };

    if (!Array.isArray(payload?.models)) {
        res.status(400).json({ error: 'Expected { models: [...] }' });
        return;
    }

    const now = new Date().toISOString();

    const apply = db.transaction(() => {
        for (const m of payload.models!) {
            const sets: string[] = [];
            const values: any[] = [];
            if (m.inputCostPer1M !== undefined) {
                sets.push('input_cost_per_1m = ?');
                values.push(m.inputCostPer1M);
            }
            if (m.outputCostPer1M !== undefined) {
                sets.push('output_cost_per_1m = ?');
                values.push(m.outputCostPer1M);
            }
            if (sets.length === 0) continue;
            sets.push('cost_updated_at = ?');
            values.push(now, m.id);
            const sql = `UPDATE models SET ${sets.join(', ')} WHERE id = ?`;
            db.prepare(sql).run(...values);
        }
    });

    apply();

    res.json({ updated: payload.models.length, updatedAt: now });
});
