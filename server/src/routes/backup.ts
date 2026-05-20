import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getDb,
  getUnifiedApiKey,
  isUnifiedApiKeyPinned,
  persistDbSnapshot,
  setUnifiedApiKey,
} from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { PLATFORMS } from '../lib/platforms.js';
import { importModeSchema, importProviderKeys } from '../services/key-import.js';

export const backupRouter = Router();

const fallbackImportSchema = z.object({
  platform: z.enum(PLATFORMS),
  modelId: z.string().min(1),
  priority: z.coerce.number().int().positive().optional(),
  enabled: z.preprocess(value => {
    if (value === 'true' || value === '1' || value === 1) return true;
    if (value === 'false' || value === '0' || value === 0) return false;
    return value;
  }, z.boolean().optional()),
});

const backupImportSchema = z.object({
  mode: importModeSchema.optional(),
  dedupe: z.boolean().optional(),
  providerKeys: z.array(z.unknown()).optional(),
  keys: z.array(z.unknown()).optional(),
  fallback: z.array(z.unknown()).optional(),
  unifiedApiKey: z.string().trim().min(1).optional(),
  restoreUnifiedApiKey: z.boolean().optional(),
});

type FallbackImportResult = {
  updated: number;
  skipped: number;
  errors: Array<{ index: number; message: string }>;
};

function normalizeFallback(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const raw = value as Record<string, unknown>;
  return {
    platform: raw.platform,
    modelId: raw.modelId ?? raw.model_id,
    priority: raw.priority,
    enabled: raw.enabled,
  };
}

function importFallback(rawFallback: unknown[]): FallbackImportResult {
  const db = getDb();
  const result: FallbackImportResult = { updated: 0, skipped: 0, errors: [] };
  const update = db.prepare(`
    UPDATE fallback_config
       SET priority = COALESCE(?, priority),
           enabled = COALESCE(?, enabled)
     WHERE model_db_id = (
       SELECT id FROM models WHERE platform = ? AND model_id = ?
     )
  `);

  const run = db.transaction(() => {
    rawFallback.forEach((rawEntry, index) => {
      const parsed = fallbackImportSchema.safeParse(normalizeFallback(rawEntry));
      if (!parsed.success) {
        result.errors.push({
          index,
          message: parsed.error.errors.map(error => error.message).join(', '),
        });
        result.skipped += 1;
        return;
      }

      const entry = parsed.data;
      if (entry.priority === undefined && entry.enabled === undefined) {
        result.skipped += 1;
        return;
      }

      const updated = update.run(
        entry.priority ?? null,
        entry.enabled === undefined ? null : entry.enabled ? 1 : 0,
        entry.platform,
        entry.modelId,
      );
      if (updated.changes > 0) {
        result.updated += 1;
      } else {
        result.skipped += 1;
      }
    });
  });

  run();
  return result;
}

function backupFilename(): string {
  return `freellmapi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

backupRouter.get('/export', (_req: Request, res: Response) => {
  const db = getDb();
  const keyRows = db.prepare(`
    SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at, last_checked_at
      FROM api_keys
     ORDER BY created_at DESC
  `).all() as Array<{
    id: number;
    platform: string;
    label: string;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
    status: string;
    enabled: number;
    created_at: string;
    last_checked_at: string | null;
  }>;

  const warnings: Array<{ id: number; message: string }> = [];
  const providerKeys = keyRows.flatMap(row => {
    try {
      return [{
        platform: row.platform,
        label: row.label,
        key: decrypt(row.encrypted_key, row.iv, row.auth_tag),
        status: row.status,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        lastCheckedAt: row.last_checked_at,
      }];
    } catch {
      warnings.push({ id: row.id, message: 'Could not decrypt key' });
      return [];
    }
  });

  const fallback = db.prepare(`
    SELECT m.platform, m.model_id AS modelId, fc.priority, fc.enabled
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
     ORDER BY fc.priority ASC
  `).all() as Array<{ platform: string; modelId: string; priority: number; enabled: number }>;

  res.setHeader('Content-Disposition', `attachment; filename="${backupFilename()}"`);
  res.json({
    format: 'freellmapi-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    unifiedApiKey: getUnifiedApiKey(),
    unifiedApiKeyPinned: isUnifiedApiKeyPinned(),
    providerKeys,
    fallback: fallback.map(entry => ({
      platform: entry.platform,
      modelId: entry.modelId,
      priority: entry.priority,
      enabled: entry.enabled === 1,
    })),
    warnings,
  });
});

backupRouter.post('/import', async (req: Request, res: Response) => {
  const parsed = backupImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const rawKeys = parsed.data.providerKeys ?? parsed.data.keys ?? [];
  const keyImport = rawKeys.length > 0
    ? importProviderKeys(db, rawKeys, {
      mode: parsed.data.mode ?? 'append',
      dedupe: parsed.data.dedupe,
    })
    : { inserted: 0, skipped: 0, replaced: 0, errors: [], keys: [] };

  const fallbackImport = parsed.data.fallback?.length
    ? importFallback(parsed.data.fallback)
    : { updated: 0, skipped: 0, errors: [] };

  let unifiedApiKey: { restored: boolean; skipped: boolean; reason?: string } = {
    restored: false,
    skipped: false,
  };

  if (parsed.data.unifiedApiKey && parsed.data.restoreUnifiedApiKey !== false) {
    const restored = setUnifiedApiKey(parsed.data.unifiedApiKey);
    unifiedApiKey = restored
      ? { restored: true, skipped: false }
      : { restored: false, skipped: true, reason: 'Unified key is pinned by environment' };
  }

  const changed = keyImport.inserted > 0
    || keyImport.replaced > 0
    || fallbackImport.updated > 0
    || unifiedApiKey.restored;

  if (!changed && keyImport.errors.length > 0 && keyImport.inserted === 0) {
    res.status(400).json({
      error: { message: 'No valid backup data to import', details: keyImport.errors },
      keys: keyImport,
      fallback: fallbackImport,
      unifiedApiKey,
    });
    return;
  }

  if (changed) {
    await persistDbSnapshot('backup-import');
  }

  res.status(201).json({
    success: true,
    keys: keyImport,
    fallback: fallbackImport,
    unifiedApiKey,
  });
});
