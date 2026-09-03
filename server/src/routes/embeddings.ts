import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, setSetting } from '../db/index.js';
import { decrypt, maskKey } from '../lib/crypto.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import { resolveCustomEndpointKey } from '../services/custom-endpoint.js';
import {
  listEmbeddingModels,
  getDefaultFamily,
  probeEmbeddingDimensions,
  registerCustomEmbeddingModel,
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
  // Optional: NULL means "no opinion". A new model takes its id, and a model
  // already on record keeps the name it has instead of being reset by a submit
  // that simply left the field blank (#704).
  const submittedName = parsed.data.displayName?.trim() || null;
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

  const upsert = db.transaction(() => {
    // A new secret for a known endpoint is an ADDITIONAL credential, never a
    // replacement for the stored one (#619).
    const { keyId, storedKey: storedKeyForMask } = resolveCustomEndpointKey(db, baseUrl, providedKey, label);
    const { modelDbId } = registerCustomEmbeddingModel(db, {
      keyId,
      modelId,
      displayName: submittedName,
      family,
      dimensions,
      maxInputTokens: parsed.data.maxInputTokens ?? null,
      quotaLabel,
    });
    return { modelDbId, keyId, storedKeyForMask };
  });

  // A family-dimension conflict aborts the transaction, so a rejected submit
  // leaves no half-registered key row behind.
  let result: { modelDbId: number; keyId: number; storedKeyForMask: string };
  try {
    result = upsert();
  } catch (err: any) {
    if (err instanceof EmbeddingsError) {
      // `upstream_error`, never `authentication_error`: this status is relayed
      // from the operator's own endpoint, and a client that reads a bare 401 as
      // "session expired" would sign the operator out for testing a bad key.
      res.status(err.status).json({ error: { message: err.message, type: 'upstream_error' } });
      return;
    }
    throw err;
  }
  const storedName = (db.prepare('SELECT display_name FROM embedding_models WHERE id = ?')
    .get(result.modelDbId) as { display_name: string }).display_name;
  res.status(201).json({
    success: true,
    keyId: result.keyId,
    modelDbId: result.modelDbId,
    platform: 'custom',
    baseUrl,
    model: modelId,
    displayName: storedName,
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
//
// Deliberately no budget denominator. `models.monthly_token_budget` gives chat
// a real number to divide by; `embedding_models` only carries a free-text
// `quota_label` ("10K neurons/day (shared)", "$0.10/mo credits"), and there is
// no honest conversion from Cloudflare Neurons or dollar credits to tokens. So
// the summary reports what was actually spent and shows each provider's quota
// label verbatim, rather than inventing a ceiling to draw a percentage against.
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

  // One representative provider per family for the legend: the highest-priority
  // enabled row, so the label matches whoever actually serves the family first.
  const meta = db.prepare(`
    SELECT family, platform, quota_label
    FROM embedding_models
    WHERE enabled = 1
    ORDER BY priority ASC
  `).all() as { family: string; platform: string; quota_label: string | null }[];
  const metaByFamily = new Map<string, { platform: string; quota_label: string | null }>();
  for (const m of meta) if (!metaByFamily.has(m.family)) metaByFamily.set(m.family, m);

  const families = usage.map(u => ({
    family: u.family,
    requestsToday: u.requests_today,
    tokensMonth: u.tokens_month,
    platform: metaByFamily.get(u.family)?.platform ?? null,
    quotaLabel: metaByFamily.get(u.family)?.quota_label ?? null,
  }));

  res.json({
    families,
    totalTokensMonth: families.reduce((s, f) => s + f.tokensMonth, 0),
    totalRequestsToday: families.reduce((s, f) => s + f.requestsToday, 0),
  });
});
