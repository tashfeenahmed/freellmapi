import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, setSetting } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import {
  listEmbeddingModels,
  getDefaultFamily,
  probeEmbeddingDimensions,
  EmbeddingsError,
  type EmbeddingModelRow,
} from '../services/embeddings.js';

export const embeddingsRouter = Router();

// Families with their provider chains, for the dashboard Embeddings tab.
embeddingsRouter.get('/', (_req: Request, res: Response) => {
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
        keyCount: r.platform === 'custom' && r.key_id != null
          ? (customKeyIds.has(r.key_id) ? 1 : 0)
          : keyCounts.get(r.platform) ?? 0,
        isCustom: r.platform === 'custom',
      })),
    })),
  });
});

const customEmbeddingSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1),
  displayName: z.string().optional(),
  family: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  quotaLabel: z.string().optional(),
  maxInputTokens: z.number().int().positive().optional(),
});

function decryptExistingKey(row: { encrypted_key: string; iv: string; auth_tag: string } | undefined): string | null {
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

embeddingsRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customEmbeddingSchema.safeParse(req.body);
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
  const family = parsed.data.family?.trim() || modelId;
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const label = parsed.data.label?.trim() || undefined;
  const quotaLabel = parsed.data.quotaLabel?.trim() || 'custom endpoint';

  const existingKey = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = 'custom' AND base_url = ?
     LIMIT 1
  `).get(baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;
  const probeKey = providedKey ?? decryptExistingKey(existingKey) ?? 'no-key';

  let dimensions: number;
  try {
    dimensions = await probeEmbeddingDimensions(baseUrl, probeKey, modelId);
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({
      error: { message: `custom embedding probe failed: ${err?.message ?? 'unknown error'}` },
    });
    return;
  }

  const sibling = db.prepare(`
    SELECT dimensions
      FROM embedding_models
     WHERE family = ?
       AND NOT (platform = 'custom' AND model_id = ?)
     LIMIT 1
  `).get(family, modelId) as { dimensions: number } | undefined;
  if (sibling && sibling.dimensions !== dimensions) {
    res.status(400).json({
      error: {
        message: `Embedding family '${family}' is ${sibling.dimensions} dimensions, but '${modelId}' returned ${dimensions}. Use a new family name.`,
      },
    });
    return;
  }

  const upsert = db.transaction(() => {
    let keyId: number;
    let storedKeyForMask = probeKey;
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
        db.prepare(`
          UPDATE api_keys
             SET label = COALESCE(?, label), status = 'unknown', enabled = 1
           WHERE id = ?
        `).run(label ?? null, keyId);
      }
    } else {
      const keyToStore = providedKey ?? 'no-key';
      const { encrypted, iv, authTag } = encrypt(keyToStore);
      const key = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
      `).run(label ?? 'Custom', encrypted, iv, authTag, baseUrl);
      keyId = Number(key.lastInsertRowid);
      storedKeyForMask = keyToStore;
    }

    const existingModel = db.prepare(`
      SELECT id, priority
        FROM embedding_models
       WHERE platform = 'custom' AND model_id = ?
       LIMIT 1
    `).get(modelId) as { id: number; priority: number } | undefined;
    const priority = existingModel?.priority ?? (
      (db.prepare('SELECT COALESCE(MAX(priority), 0) AS maxPriority FROM embedding_models WHERE family = ?')
        .get(family) as { maxPriority: number }).maxPriority + 1
    );

    if (existingModel) {
      db.prepare(`
        UPDATE embedding_models
           SET family = ?,
               display_name = ?,
               dimensions = ?,
               max_input_tokens = ?,
               priority = ?,
               enabled = 1,
               quota_label = ?,
               key_id = ?
         WHERE id = ?
      `).run(family, displayName, dimensions, parsed.data.maxInputTokens ?? null, priority, quotaLabel, keyId, existingModel.id);
      return { modelDbId: existingModel.id, keyId, storedKeyForMask };
    }

    const model = db.prepare(`
      INSERT INTO embedding_models
        (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id)
      VALUES (?, 'custom', ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(family, modelId, displayName, dimensions, parsed.data.maxInputTokens ?? null, priority, quotaLabel, keyId);
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
    family,
    dimensions,
    maskedKey: maskKey(result.storedKeyForMask),
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

embeddingsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT family, key_id FROM embedding_models WHERE id = ? AND platform = 'custom'").get(id) as { family: string; key_id: number | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom embedding model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM embedding_models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  if (getDefaultFamily() === row.family) {
    const replacement = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1').get() as { family: string } | undefined;
    if (replacement) setSetting('embeddings_default_family', replacement.family);
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
