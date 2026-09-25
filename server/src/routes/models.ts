import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPostgresPool } from '../db/postgres.js';
import { reloadRoutingRegistry } from '../services/router-registry.js';

export const modelsRouter = Router();

const updateModelSchema = z.object({
  displayName: z.string().optional(),
  enabled: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  priority: z.number().int().optional(),
});

// GET /api/models - List all models with provider details
modelsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const pool = getPostgresPool();
    const queryRes = await pool.query(`
      SELECT
        m.id,
        m.provider_id,
        p.provider_key as platform,
        p.display_name as provider_name,
        m.model_id,
        m.canonical_name,
        m.display_name,
        m.enabled,
        m.context_window,
        m.max_output_tokens,
        m.supports_streaming,
        m.supports_tools,
        m.supports_vision,
        m.supports_structured_output,
        m.supports_reasoning,
        m.priority,
        EXISTS (
          SELECT 1 FROM credentials c
          WHERE c.provider_id = m.provider_id AND c.enabled = true
        ) as available
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      ORDER BY p.priority DESC, m.priority DESC, m.id ASC
    `);

    const models = queryRes.rows.map((row: any) => {
      let executionStatus = 'READY';
      if (!row.enabled) {
        executionStatus = 'DISABLED';
      } else if (!row.available) {
        executionStatus = 'NEEDS_KEY';
      }

      return {
        id: row.id,
        platform: row.platform,
        providerName: row.provider_name,
        modelId: row.model_id,
        canonicalName: row.canonical_name,
        displayName: row.display_name,
        enabled: row.enabled,
        available: row.available,
        executionStatus,
        contextWindow: row.context_window,
        maxOutputTokens: row.max_output_tokens,
        supportsStreaming: row.supports_streaming,
        supportsTools: row.supports_tools,
        supportsVision: row.supports_vision,
        supportsStructuredOutput: row.supports_structured_output,
        supportsReasoning: row.supports_reasoning,
        priority: row.priority,
      };
    });

    res.json(models);
  } catch (err: any) {
    console.error('[models] Error fetching models:', err);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// PATCH /api/models/:id - Update model configuration
modelsRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid model ID' });
      return;
    }

    const parsed = updateModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid model payload: ' + parsed.error.message });
      return;
    }

    const data = parsed.data;
    const pool = getPostgresPool();

    const updates: string[] = ['updated_at = NOW()'];
    const values: any[] = [];
    let idx = 1;

    if (data.displayName !== undefined) {
      updates.push(`display_name = $${idx++}`);
      values.push(data.displayName);
    }
    if (data.enabled !== undefined) {
      updates.push(`enabled = $${idx++}`);
      values.push(data.enabled);
    }
    if (data.supportsTools !== undefined) {
      updates.push(`supports_tools = $${idx++}`);
      values.push(data.supportsTools);
    }
    if (data.supportsVision !== undefined) {
      updates.push(`supports_vision = $${idx++}`);
      values.push(data.supportsVision);
    }
    if (data.contextWindow !== undefined) {
      updates.push(`context_window = $${idx++}`);
      values.push(data.contextWindow);
    }
    if (data.maxOutputTokens !== undefined) {
      updates.push(`max_output_tokens = $${idx++}`);
      values.push(data.maxOutputTokens);
    }
    if (data.priority !== undefined) {
      updates.push(`priority = $${idx++}`);
      values.push(data.priority);
    }

    values.push(id);
    const updateRes = await pool.query(
      `UPDATE models SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id`,
      values
    );

    if (updateRes.rowCount === 0) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[models] Error updating model:', err);
    res.status(500).json({ error: 'Failed to update model' });
  }
});

// DELETE /api/models/:id - Delete custom model
modelsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pool = getPostgresPool();

    const delRes = await pool.query('DELETE FROM models WHERE id = $1', [id]);
    if (delRes.rowCount === 0) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[models] Error deleting model:', err);
    res.status(500).json({ error: 'Failed to delete model' });
  }
});
