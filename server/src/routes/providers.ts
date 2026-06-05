import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { ensurePersistenceSchema } from '../db/persistence-schema.js';
import { PROVIDER_REGISTRY, getProviderRegistryEntry } from '../providers/registry.js';
import { encryptSecret, maskSecret } from '../security/secrets.js';
import { runModelDiscoveryOnce } from '../jobs/modelDiscoveryJob.js';

export const providersRouter = Router();
export const providerAccountsRouter = Router();
export const modelDiscoveryRouter = Router();

function idFor(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
}

function ensureSchema() {
  ensurePersistenceSchema(getDb());
}

providersRouter.get('/', (_req: Request, res: Response) => {
  ensureSchema();
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      r.slug,
      COUNT(DISTINCT pa.id) AS account_count,
      COUNT(DISTINCT pcm.provider_model_id) AS model_count,
      SUM(CASE WHEN pcm.status = 'active' THEN 1 ELSE 0 END) AS active_model_count,
      SUM(CASE WHEN pcm.status IN ('removed', 'deprecated') THEN 1 ELSE 0 END) AS unavailable_model_count
    FROM (
      ${PROVIDER_REGISTRY.map(() => 'SELECT ? AS slug').join(' UNION ALL ')}
    ) r
    LEFT JOIN provider_accounts pa ON pa.provider_slug = r.slug AND pa.status != 'deleted'
    LEFT JOIN provider_catalog_models pcm ON pcm.provider_slug = r.slug
    GROUP BY r.slug
  `).all(...PROVIDER_REGISTRY.map(provider => provider.slug)) as any[];

  const stats = new Map(rows.map(row => [row.slug, row]));
  res.json(PROVIDER_REGISTRY.map(provider => ({
    ...provider,
    accountCount: stats.get(provider.slug)?.account_count ?? 0,
    modelCount: stats.get(provider.slug)?.model_count ?? 0,
    activeModelCount: stats.get(provider.slug)?.active_model_count ?? 0,
    unavailableModelCount: stats.get(provider.slug)?.unavailable_model_count ?? 0,
  })));
});

providersRouter.get('/:providerSlug/models', (req: Request, res: Response) => {
  ensureSchema();
  const providerSlug = req.params.providerSlug;
  const db = getDb();
  const rows = db.prepare(`
    SELECT pcm.*, pml.rpm_limit, pml.rpd_limit, pml.tpm_limit, pml.tpd_limit
    FROM provider_catalog_models pcm
    LEFT JOIN provider_model_limits pml
      ON pml.provider_slug = pcm.provider_slug AND pml.provider_model_id = pcm.provider_model_id
    WHERE pcm.provider_slug = ?
    ORDER BY CASE pcm.status WHEN 'active' THEN 0 WHEN 'deprecated' THEN 1 ELSE 2 END, pcm.display_name ASC
  `).all(providerSlug) as any[];
  res.json(rows.map(row => ({
    id: row.id,
    providerSlug: row.provider_slug,
    modelId: row.provider_model_id,
    displayName: row.display_name ?? row.provider_model_id,
    status: row.status,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    supportsTools: row.supports_tools === 1,
    supportsVision: row.supports_vision === 1,
    supportsStreaming: row.supports_streaming === 1,
    supportsJson: row.supports_json === 1,
    rpmLimit: row.rpm_limit,
    rpdLimit: row.rpd_limit,
    tpmLimit: row.tpm_limit,
    tpdLimit: row.tpd_limit,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  })));
});

const providerAccountSchema = z.object({
  providerSlug: z.string().min(1),
  displayName: z.string().min(1).optional(),
  accountEmail: z.string().email().optional(),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

providerAccountsRouter.get('/', (_req: Request, res: Response) => {
  ensureSchema();
  const rows = getDb().prepare(`
    SELECT id, provider_slug, display_name, account_email, key_hint, status, base_url, created_at, updated_at
    FROM provider_accounts
    WHERE status != 'deleted'
    ORDER BY provider_slug ASC, created_at DESC
  `).all() as any[];
  res.json(rows.map(row => ({
    id: row.id,
    providerSlug: row.provider_slug,
    displayName: row.display_name,
    accountEmail: row.account_email,
    keyHint: row.key_hint,
    status: row.status,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })));
});

providerAccountsRouter.post('/', (req: Request, res: Response) => {
  ensureSchema();
  const parsed = providerAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }

  const registry = getProviderRegistryEntry(parsed.data.providerSlug);
  if (!registry) {
    res.status(400).json({ error: { message: `Unknown provider '${parsed.data.providerSlug}'` } });
    return;
  }

  const encrypted = encryptSecret(parsed.data.apiKey.trim());
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO provider_accounts (
      id, provider_slug, display_name, account_email, encrypted_api_key, key_iv, key_auth_tag, key_hint, status, base_url, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
  `).run(
    id,
    parsed.data.providerSlug,
    parsed.data.displayName ?? `${registry.displayName} account`,
    parsed.data.accountEmail ?? null,
    encrypted.encrypted,
    encrypted.iv,
    encrypted.authTag,
    encrypted.hint,
    parsed.data.baseUrl ?? null,
  );

  res.status(201).json({
    id,
    providerSlug: parsed.data.providerSlug,
    displayName: parsed.data.displayName ?? `${registry.displayName} account`,
    accountEmail: parsed.data.accountEmail ?? null,
    keyHint: maskSecret(parsed.data.apiKey),
    status: 'active',
    baseUrl: parsed.data.baseUrl ?? null,
  });
});

const patchProviderAccountSchema = z.object({
  displayName: z.string().min(1).optional(),
  accountEmail: z.string().email().nullable().optional(),
  apiKey: z.string().min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  baseUrl: z.string().url().nullable().optional(),
});

providerAccountsRouter.patch('/:id', (req: Request, res: Response) => {
  ensureSchema();
  const parsed = patchProviderAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(error => error.message).join(', ') } });
    return;
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.displayName !== undefined) { updates.push('display_name = ?'); values.push(parsed.data.displayName); }
  if (parsed.data.accountEmail !== undefined) { updates.push('account_email = ?'); values.push(parsed.data.accountEmail); }
  if (parsed.data.status !== undefined) { updates.push('status = ?'); values.push(parsed.data.status); }
  if (parsed.data.baseUrl !== undefined) { updates.push('base_url = ?'); values.push(parsed.data.baseUrl); }
  if (parsed.data.apiKey !== undefined) {
    const encrypted = encryptSecret(parsed.data.apiKey.trim());
    updates.push('encrypted_api_key = ?', 'key_iv = ?', 'key_auth_tag = ?', 'key_hint = ?');
    values.push(encrypted.encrypted, encrypted.iv, encrypted.authTag, encrypted.hint);
  }
  if (updates.length === 0) {
    res.status(400).json({ error: { message: 'No update fields provided' } });
    return;
  }
  updates.push('updated_at = datetime(\'now\')');
  values.push(req.params.id);

  const result = getDb().prepare(`UPDATE provider_accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Provider account not found' } });
    return;
  }
  res.json({ success: true });
});

providerAccountsRouter.delete('/:id', (req: Request, res: Response) => {
  ensureSchema();
  const result = getDb().prepare("UPDATE provider_accounts SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Provider account not found' } });
    return;
  }
  res.json({ success: true });
});

modelDiscoveryRouter.post('/run', async (_req: Request, res: Response) => {
  try {
    const result = await runModelDiscoveryOnce();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: { message: (error as Error).message } });
  }
});

modelDiscoveryRouter.get('/changes', (_req: Request, res: Response) => {
  ensureSchema();
  const rows = getDb().prepare(`
    SELECT * FROM model_change_events
    ORDER BY detected_at DESC
    LIMIT 100
  `).all() as any[];
  res.json(rows.map(row => ({
    id: row.id,
    providerSlug: row.provider_slug,
    modelId: row.provider_model_id,
    changeType: row.change_type,
    oldValue: row.old_value_json ? JSON.parse(row.old_value_json) : null,
    newValue: row.new_value_json ? JSON.parse(row.new_value_json) : null,
    detectedAt: row.detected_at,
  })));
});
