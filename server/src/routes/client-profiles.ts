import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPostgresPool } from '../db/postgres.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import {
  mintClientProfileKey,
  hashClientProfileKey,
  setCachedProfile,
  updateCachedProfile,
  deleteCachedProfileById,
} from '../lib/system-prompt.js';

export const clientProfilesRouter = Router();

const MAX_NAME_LEN = 100;
const MAX_PROMPT_LEN = 32_000;

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullish(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(),
  systemPrompt: z.string().max(MAX_PROMPT_LEN).nullable().optional(),
  enabled: z.boolean().optional(),
});

interface ProfileRow {
  id: number;
  name: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  system_prompt: string | null;
  enabled: boolean | number;
  created_at: string;
  updated_at: string;
}

function maskedKeyFor(row: Pick<ProfileRow, 'encrypted_key' | 'iv' | 'auth_tag'>): string {
  try {
    return maskKey(decrypt(row.encrypted_key, row.iv, row.auth_tag));
  } catch {
    return '[decrypt failed]';
  }
}

function toJson(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKeyFor(row),
    systemPrompt: row.system_prompt,
    enabled: row.enabled === true || row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getProfile(id: number): Promise<ProfileRow | undefined> {
  const pool = getPostgresPool();
  const res = await pool.query('SELECT * FROM client_profiles WHERE id = $1', [id]);
  return res.rows[0];
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid profile id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Client profile not found' } });
}

clientProfilesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const pool = getPostgresPool();
    const result = await pool.query('SELECT * FROM client_profiles ORDER BY id');
    res.json(result.rows.map(toJson));
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to list profiles' } });
  }
});

clientProfilesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'A profile name is required' } });
    return;
  }
  try {
    const key = mintClientProfileKey();
    const tokenHash = hashClientProfileKey(key);
    const { encrypted, iv, authTag } = encrypt(key);
    const prompt = parsed.data.systemPrompt?.trim() || null;
    const pool = getPostgresPool();
    const result = await pool.query(
      `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [parsed.data.name, tokenHash, encrypted, iv, authTag, prompt]
    );
    const row = result.rows[0];
    setCachedProfile(tokenHash, {
      profileId: row.id,
      name: row.name,
      systemPrompt: prompt,
      enabled: true,
    });
    res.status(201).json({ ...toJson(row), key });
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to create profile' } });
  }
});

clientProfilesRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid profile update' } });
    return;
  }
  try {
    const row = await getProfile(id);
    if (!row) return notFound(res);

    const { name, systemPrompt, enabled } = parsed.data;
    const nextPrompt = systemPrompt === undefined
      ? row.system_prompt
      : (systemPrompt?.trim() || null);
    const isEnabled = enabled === undefined ? (row.enabled === true || row.enabled === 1) : enabled;
    const pool = getPostgresPool();
    const updated = await pool.query(
      `UPDATE client_profiles
       SET name = $1, system_prompt = $2, enabled = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        name ?? row.name,
        nextPrompt,
        isEnabled,
        id,
      ]
    );
    updateCachedProfile(id, {
      name: name ?? row.name,
      systemPrompt: nextPrompt,
      enabled: isEnabled,
    });
    res.json(toJson(updated.rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to update profile' } });
  }
});

clientProfilesRouter.post('/:id/rotate', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const row = await getProfile(id);
    if (!row) return notFound(res);

    const key = mintClientProfileKey();
    const tokenHash = hashClientProfileKey(key);
    const { encrypted, iv, authTag } = encrypt(key);
    const pool = getPostgresPool();
    const updated = await pool.query(
      `UPDATE client_profiles
       SET token_hash = $1, encrypted_key = $2, iv = $3, auth_tag = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [tokenHash, encrypted, iv, authTag, id]
    );
    deleteCachedProfileById(id);
    setCachedProfile(tokenHash, {
      profileId: id,
      name: updated.rows[0].name,
      systemPrompt: updated.rows[0].system_prompt,
      enabled: updated.rows[0].enabled === true || updated.rows[0].enabled === 1,
    });
    res.json({ ...toJson(updated.rows[0]), key });
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to rotate profile key' } });
  }
});

clientProfilesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const pool = getPostgresPool();
    const info = await pool.query('DELETE FROM client_profiles WHERE id = $1', [id]);
    if ((info.rowCount ?? 0) === 0) return notFound(res);
    deleteCachedProfileById(id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: { message: err?.message || 'Failed to delete profile' } });
  }
});
