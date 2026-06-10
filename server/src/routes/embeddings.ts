import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, setSetting } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
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
        // Custom rows bind to one endpoint key, so they're always "keyed" if
        // that key still exists; built-ins count healthy keys for the platform.
        keyCount: r.key_id != null ? 1 : keyCounts.get(r.platform) ?? 0,
        isCustom: r.platform === 'custom',
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

// ── Custom OpenAI-compatible embedding providers ──────────────────────────
// Register any OpenAI-compatible /embeddings endpoint (self-hosted vLLM /
// Ollama / LM Studio, or a third-party gateway). Each distinct base_url shares
// the one 'custom' api_keys row that chat custom providers also use (#212);
// the embedding row binds to it via key_id. The vector dimension is
// auto-detected by probing the endpoint once at registration.
const customSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1, 'model is required'),
  family: z.string().optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  maxInputTokens: z.number().int().positive().optional(),
});

embeddingsRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const modelId = parsed.data.model.trim();
  const family = (parsed.data.family ?? modelId).trim();
  const displayName = (parsed.data.displayName ?? modelId).trim();
  const providedKey = parsed.data.apiKey?.trim();
  const providedLabel = parsed.data.label?.trim();
  const label = providedLabel || 'Custom'; // only used when inserting a new row

  const db = getDb();

  // An endpoint may already exist (a chat or embedding model was added to the
  // same base_url before). If so and no new key was supplied, reuse its stored
  // key rather than clobbering it — that key the other models depend on.
  const existing = db.prepare(
    "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1",
  ).get(baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;

  let probeKey = providedKey;
  if (!probeKey && existing) {
    try { probeKey = decrypt(existing.encrypted_key, existing.iv, existing.auth_tag); } catch { /* fall through to sentinel */ }
  }

  // Probe before persisting so a broken endpoint never enters the routing chain
  // and we learn the dimension up front.
  let dimensions: number;
  try {
    dimensions = await probeEmbeddingDimensions(baseUrl, probeKey || 'no-key', modelId);
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    res.status(status).json({ error: { message: `Could not reach endpoint: ${String(err?.message ?? err).slice(0, 200)}` } });
    return;
  }

  // If joining an existing family (other than re-registering this very model),
  // the dimension must match — a family is one vector space, and failover
  // across incompatible dimensions would corrupt any store built on it.
  const sibling = db.prepare(
    "SELECT dimensions FROM embedding_models WHERE family = ? AND NOT (platform = 'custom' AND model_id = ?) LIMIT 1",
  ).get(family, modelId) as { dimensions: number } | undefined;
  if (sibling && sibling.dimensions !== dimensions) {
    res.status(400).json({ error: { message: `Family '${family}' uses ${sibling.dimensions}-dim vectors, but this endpoint returned ${dimensions}. Use a different family name.` } });
    return;
  }

  const upsert = db.transaction(() => {
    // One 'custom' key row per endpoint (matched on base_url), shared with any
    // chat custom models on the same endpoint. Only overwrite the stored key
    // when a new one was supplied; otherwise reuse it untouched.
    let keyId: number;
    if (existing) {
      // Update key and label independently, each only when supplied, so adding
      // an embedding model to an endpoint already serving chat models (key left
      // blank) doesn't clobber the key those models depend on.
      if (providedKey) {
        const { encrypted, iv, authTag } = encrypt(providedKey);
        db.prepare("UPDATE api_keys SET encrypted_key = ?, iv = ?, auth_tag = ?, status = 'unknown' WHERE id = ?")
          .run(encrypted, iv, authTag, existing.id);
      }
      if (providedLabel) {
        db.prepare('UPDATE api_keys SET label = ? WHERE id = ?').run(providedLabel, existing.id);
      }
      db.prepare('UPDATE api_keys SET enabled = 1 WHERE id = ?').run(existing.id);
      keyId = existing.id;
    } else {
      const { encrypted, iv, authTag } = encrypt(providedKey || 'no-key');
      const r = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
      `).run(label, encrypted, iv, authTag, baseUrl);
      keyId = Number(r.lastInsertRowid);
    }

    // Sit at the back of the family's chain: a brand-new family starts at 1, an
    // added failover provider lands after the existing ones. Re-registering the
    // same model id re-binds its endpoint/metadata and keeps its priority.
    const nextPriority = (db.prepare(
      'SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM embedding_models WHERE family = ?',
    ).get(family) as { p: number }).p;
    db.prepare(`
      INSERT INTO embedding_models
        (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id)
      VALUES (?, 'custom', ?, ?, ?, ?, ?, 1, 'custom endpoint', ?)
      ON CONFLICT(platform, model_id)
      DO UPDATE SET family = excluded.family, display_name = excluded.display_name,
        dimensions = excluded.dimensions, max_input_tokens = excluded.max_input_tokens,
        key_id = excluded.key_id, enabled = 1
    `).run(family, modelId, displayName, dimensions, parsed.data.maxInputTokens ?? null, nextPriority, keyId);

    const modelRow = db.prepare("SELECT id FROM embedding_models WHERE platform = 'custom' AND model_id = ?").get(modelId) as { id: number };
    return { keyId, id: modelRow.id };
  });

  const { keyId, id } = upsert();
  res.status(201).json({
    success: true,
    id,
    keyId,
    family,
    platform: 'custom',
    baseUrl,
    model: modelId,
    displayName,
    dimensions,
    maskedKey: maskKey(probeKey || 'no-key'),
  });
});

// Remove a custom embedding provider. Only the embedding row is dropped; the
// shared endpoint key (api_keys) is managed from the Keys page since chat
// models may still use it. If this row was the default family's only provider,
// fall the default back to the first remaining family.
embeddingsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  const db = getDb();
  const row = db.prepare("SELECT family FROM embedding_models WHERE id = ? AND platform = 'custom'").get(id) as { family: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Custom embedding provider not found' } });
    return;
  }

  db.transaction(() => {
    db.prepare('DELETE FROM embedding_models WHERE id = ?').run(id);
    // If the deleted family no longer exists and was the default, repoint it.
    const defaultFamily = getDefaultFamily();
    const stillThere = db.prepare('SELECT 1 FROM embedding_models WHERE family = ?').get(defaultFamily);
    if (!stillThere) {
      const next = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1').get() as { family: string } | undefined;
      if (next) setSetting('embeddings_default_family', next.family);
    }
  })();

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
