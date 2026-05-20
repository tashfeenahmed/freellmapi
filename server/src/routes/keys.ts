import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, persistDbSnapshot } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { PLATFORMS } from '../lib/platforms.js';
import { importModeSchema, importProviderKeys } from '../services/key-import.js';

export const keysRouter = Router();

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().min(1),
  label: z.string().optional(),
});

const importKeysSchema = z.object({
  mode: importModeSchema.optional(),
  dedupe: z.boolean().optional(),
  keys: z.array(z.unknown()).min(1).max(2000),
});

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', async (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, key, label } = parsed.data;
  const { encrypted, iv, authTag } = encrypt(key);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);
  await persistDbSnapshot('api-key-add');

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(key),
    status: 'unknown',
    enabled: true,
  });
});

// Import many keys at once
keysRouter.post('/import', async (req: Request, res: Response) => {
  const parsed = importKeysSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const result = importProviderKeys(db, parsed.data.keys, {
    mode: parsed.data.mode ?? 'append',
    dedupe: parsed.data.dedupe,
  });

  if (result.inserted === 0 && result.replaced === 0 && result.errors.length > 0) {
    res.status(400).json({ error: { message: 'No valid keys to import', details: result.errors }, result });
    return;
  }

  if (result.inserted > 0 || result.replaced > 0) {
    await persistDbSnapshot('api-key-bulk-import');
  }

  res.status(201).json(result);
});

// Delete a key
keysRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  await persistDbSnapshot('api-key-delete');
  res.json({ success: true });
});

// Toggle enable/disable
keysRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  await persistDbSnapshot('api-key-toggle');
  res.json({ success: true, enabled });
});
