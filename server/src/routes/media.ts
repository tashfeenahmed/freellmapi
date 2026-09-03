import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { maskKey } from '../lib/crypto.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import { resolveCustomEndpointKey } from '../services/custom-endpoint.js';
import { registerCustomMediaModel } from '../services/custom-media-register.js';
import { listAllMediaModels } from '../services/media.js';

export const mediaRouter = Router();

// Generative-media models for the dashboard Image/Video/Audio tabs.
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

// Per-model usage for one modality: requests today and this calendar month,
// from the tagged request log. Image and audio calls are billed per image or
// per character, not per token, so `requests` is the honest unit here and no
// token counts are reported. As with embeddings there is no budget
// denominator — `media_models` only carries a free-text `quota_label`
// ("Shared 10k neurons/day", "MP3 output - multilingual", which is not even a
// quota) — so the summary shows spend and the label verbatim. Transcription
// rows are logged the same way (request_type='transcription', see
// logMedia), so the Audio tab's STT section can show the same per-model
// counts instead of dead-ending on a 400.
mediaRouter.get('/usage', (req: Request, res: Response) => {
  const parsed = z.enum(['image', 'video', 'audio', 'transcription']).safeParse(req.query.modality);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'modality must be image, video, audio or transcription' } });
    return;
  }
  const modality = parsed.data;
  const db = getDb();

  const rows = db.prepare(`
    SELECT mm.id, mm.platform, mm.model_id, mm.display_name, mm.quota_label,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) AS requests_today,
           COALESCE(SUM(CASE WHEN r.created_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END), 0) AS requests_month
    FROM media_models mm
    LEFT JOIN requests r
      ON r.request_type = ?
     AND r.status = 'success'
     AND r.platform = mm.platform
     AND r.model_id = mm.model_id
     AND r.created_at >= datetime('now', 'start of month')
    WHERE mm.modality = ? AND mm.enabled = 1
    GROUP BY mm.id
    ORDER BY mm.priority ASC
  `).all(modality, modality) as {
    id: number; platform: string; model_id: string; display_name: string;
    quota_label: string | null; requests_today: number; requests_month: number;
  }[];

  const models = rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name,
    quotaLabel: r.quota_label,
    requestsToday: r.requests_today,
    requestsMonth: r.requests_month,
  }));

  res.json({
    modality,
    models,
    totalRequestsToday: models.reduce((s, m) => s + m.requestsToday, 0),
    totalRequestsMonth: models.reduce((s, m) => s + m.requestsMonth, 0),
  });
});

const customMediaSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().min(1),
  displayName: z.string().optional(),
  // 'transcription' registers a custom OpenAI-compatible STT endpoint. The
  // media_models table, GET /api/media/usage, the /v1/audio/transcriptions
  // handler and the media service's 'custom' adapter all accept it.
  modality: z.enum(['image', 'audio', 'transcription']),
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
  // Optional: NULL means "no opinion". A new model takes its id, and a model
  // already on record keeps the name it has instead of being reset by a submit
  // that simply left the field blank (#704).
  const submittedName = parsed.data.displayName?.trim() || null;
  const label = parsed.data.label?.trim() || undefined;
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const quotaLabel = parsed.data.quotaLabel?.trim() || 'custom endpoint';

  const upsert = db.transaction(() => {
    // A new secret for a known endpoint is an ADDITIONAL credential, never a
    // replacement for the stored one (#619). The upsert itself is shared with
    // the classified branch of POST /api/keys/custom (#1051).
    const { keyId, storedKey: storedKeyForMask } = resolveCustomEndpointKey(db, baseUrl, providedKey, label);
    const { modelDbId } = registerCustomMediaModel(db, keyId, {
      modelId,
      displayName: submittedName,
      modality: parsed.data.modality,
      quotaLabel,
    });
    return { modelDbId, keyId, storedKeyForMask };
  });

  const result = upsert();
  const storedName = (db.prepare('SELECT display_name FROM media_models WHERE id = ?')
    .get(result.modelDbId) as { display_name: string }).display_name;
  res.status(201).json({
    success: true,
    keyId: result.keyId,
    modelDbId: result.modelDbId,
    platform: 'custom',
    baseUrl,
    model: modelId,
    displayName: storedName,
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
  const row = db.prepare("SELECT key_id FROM media_models WHERE id = ? AND platform = 'custom'").get(id) as { key_id: number | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom media model ${id}` } });
    return;
  }
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM media_models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  res.json({ success: true });
});
