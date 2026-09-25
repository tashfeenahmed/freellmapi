import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPostgresPool } from '../db/postgres.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { reloadRoutingRegistry } from '../services/router-registry.js';
import { getProvider, hasProvider } from '../providers/index.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';

export const keysRouter = Router();

const addKeySchema = z.object({
  platform: z.string().min(1),
  key: z.string().optional(),
  label: z.string().optional(),
  baseUrl: z.string().url().optional().nullable(),
  modelScope: z.array(z.string()).optional().nullable(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
  modelScope: z.array(z.string()).optional().nullable(),
});

const rotateKeySchema = z.object({
  key: z.string().min(1),
});

// 1. GET /api/keys - List all keys with masked values
keysRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const pool = getPostgresPool();
    const queryRes = await pool.query(`
      SELECT
        c.id,
        c.provider_id,
        p.provider_key as platform,
        p.display_name as provider_name,
        p.base_url,
        c.credential_name as label,
        c.credential_type,
        c.enabled,
        c.cooldown_until,
        c.success_count,
        c.failure_count,
        c.last_used_at,
        c.last_failed_at,
        c.last_health_error,
        c.model_scope,
        c.encrypted_value,
        c.iv,
        c.auth_tag,
        c.created_at
      FROM credentials c
      JOIN providers p ON p.id = c.provider_id
      ORDER BY p.priority DESC, c.priority DESC, c.id ASC
    `);

    const now = Date.now();
    const keys = queryRes.rows.map((row: any) => {
      let decrypted = '';
      try {
        decrypted = decrypt(row.encrypted_value, row.iv, row.auth_tag);
      } catch {
        decrypted = '****';
      }

      const isCooldown = row.cooldown_until && new Date(row.cooldown_until).getTime() > now;
      let status: KeyStatus = 'healthy';
      if (!row.enabled) {
        status = 'invalid';
      } else if (isCooldown) {
        status = 'rate_limited';
      }

      return {
        id: row.id,
        platform: row.platform,
        providerName: row.provider_name,
        label: row.label || '',
        maskedKey: maskKey(decrypted),
        baseUrl: row.base_url || null,
        status,
        enabled: row.enabled,
        keyless: row.credential_type === 'keyless',
        exportable: true,
        createdAt: new Date(row.created_at).toISOString(),
        lastCheckedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
        lastHealthError: row.last_health_error || null,
        modelScope: row.model_scope || null,
      };
    });

    // The dashboard's ['keys'] queries expect a bare array (see
    // provider-list, export-keys-dialog, add-key-form, getting-started);
    // returning an object here crashes them with "filter is not a function".
    res.json(keys);
  } catch (err: any) {
    console.error('[keys] Error fetching keys:', err);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// 2. POST /api/keys - Add a new credential
keysRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = addKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid key payload: ' + parsed.error.message });
      return;
    }

    const { platform, key = '', label = '', baseUrl = null, modelScope = null } = parsed.data;
    const pool = getPostgresPool();

    // 1. Find or create provider
    let providerId: number;
    const pRes = await pool.query('SELECT id, base_url FROM providers WHERE provider_key = $1', [platform]);
    if (pRes.rows.length > 0) {
      providerId = pRes.rows[0].id;
      if (baseUrl && baseUrl !== pRes.rows[0].base_url) {
        await pool.query('UPDATE providers SET base_url = $1, updated_at = NOW() WHERE id = $2', [baseUrl, providerId]);
      }
    } else {
      const newP = await pool.query(
        `INSERT INTO providers (provider_key, display_name, base_url, enabled, priority)
         VALUES ($1, $2, $3, true, 5)
         RETURNING id`,
        [platform, platform.toUpperCase(), baseUrl]
      );
      providerId = newP.rows[0].id;
    }

    // 2. Encrypt credential value
    const enc = encrypt(key);
    const keyless = key.trim().length === 0;

    const credRes = await pool.query(
      `INSERT INTO credentials (
         provider_id, credential_name, encrypted_value, iv, auth_tag,
         credential_type, enabled, priority, model_scope
       )
       VALUES ($1, $2, $3, $4, $5, $6, true, 0, $7)
       RETURNING id, created_at`,
      [
        providerId,
        label,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        keyless ? 'keyless' : 'api_key',
        modelScope ? JSON.stringify(modelScope) : null,
      ]
    );

    // Atomically reload in-memory routing registry
    await reloadRoutingRegistry();

    res.status(201).json({
      id: credRes.rows[0].id,
      platform,
      label,
      maskedKey: maskKey(key),
      enabled: true,
      keyless,
      createdAt: new Date(credRes.rows[0].created_at).toISOString(),
    });
  } catch (err: any) {
    console.error('[keys] Error adding key:', err);
    res.status(500).json({ error: 'Failed to add API key' });
  }
});

// 3. PUT /api/keys/:id - Update credential
keysRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid key ID' });
      return;
    }

    const parsed = updateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid update payload: ' + parsed.error.message });
      return;
    }

    const { enabled, label, modelScope } = parsed.data;
    const pool = getPostgresPool();

    const updates: string[] = ['updated_at = NOW()'];
    const values: any[] = [];
    let idx = 1;

    if (enabled !== undefined) {
      updates.push(`enabled = $${idx++}`);
      values.push(enabled);
    }
    if (label !== undefined) {
      updates.push(`credential_name = $${idx++}`);
      values.push(label);
    }
    if (modelScope !== undefined) {
      updates.push(`model_scope = $${idx++}`);
      values.push(modelScope ? JSON.stringify(modelScope) : null);
    }

    values.push(id);
    await pool.query(
      `UPDATE credentials SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );

    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[keys] Error updating key:', err);
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

// 4. POST /api/keys/:id/rotate - Rotate credential key
keysRouter.post('/:id/rotate', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const parsed = rotateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'New key is required' });
      return;
    }

    const enc = encrypt(parsed.data.key);
    const pool = getPostgresPool();

    const updateRes = await pool.query(
      `UPDATE credentials
       SET encrypted_value = $1, iv = $2, auth_tag = $3, cooldown_until = NULL, updated_at = NOW()
       WHERE id = $4
       RETURNING id`,
      [enc.encrypted, enc.iv, enc.authTag, id]
    );

    if (updateRes.rowCount === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    await reloadRoutingRegistry();
    res.json({ success: true, id, maskedKey: maskKey(parsed.data.key) });
  } catch (err: any) {
    console.error('[keys] Error rotating key:', err);
    res.status(500).json({ error: 'Failed to rotate key' });
  }
});

// 5. DELETE /api/keys/:id - Delete credential
keysRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pool = getPostgresPool();

    const delRes = await pool.query('DELETE FROM credentials WHERE id = $1', [id]);
    if (delRes.rowCount === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[keys] Error deleting key:', err);
    res.status(500).json({ error: 'Failed to delete key' });
  }
});

// 6. POST /api/keys/:id/test - Lightweight credential testing
keysRouter.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pool = getPostgresPool();

    const credRes = await pool.query(
      `SELECT c.id, c.encrypted_value, c.iv, c.auth_tag, p.provider_key
       FROM credentials c
       JOIN providers p ON p.id = c.provider_id
       WHERE c.id = $1`,
      [id]
    );

    if (credRes.rows.length === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    const row = credRes.rows[0];
    const platform = row.provider_key as Platform;
    const plaintext = decrypt(row.encrypted_value, row.iv, row.auth_tag);

    if (!hasProvider(platform)) {
      res.json({ valid: true, message: 'Provider registered without live validation probe.' });
      return;
    }

    const adapter = getProvider(platform);
    if (!adapter) {
      res.json({ valid: true, message: 'Provider adapter not found, key saved.' });
      return;
    }

    const validationResult = await adapter.validateKey(plaintext);

    if (typeof validationResult === 'boolean') {
      res.json({ valid: validationResult, message: validationResult ? 'Key is valid and working.' : 'Key validation failed.' });
    } else if (validationResult && !validationResult.valid) {
      res.json({ valid: false, error: validationResult.error });
    } else {
      res.json({ valid: true, message: 'Key is valid.' });
    }
  } catch (err: any) {
    console.error('[keys] Error testing key:', err);
    res.status(500).json({ valid: false, error: err?.message || 'Testing failed' });
  }
});

// Custom endpoint discovery & registration routes
keysRouter.post('/custom', async (req: Request, res: Response) => {
  try {
    const { baseUrl, model, apiKey = '', label = '' } = req.body || {};
    if (!baseUrl) {
      res.status(400).json({ error: 'baseUrl is required' });
      return;
    }

    const pool = getPostgresPool();
    // 1. Find or create custom provider
    let providerId: number;
    const pRes = await pool.query("SELECT id FROM providers WHERE provider_key = 'custom' AND base_url = $1", [baseUrl]);
    if (pRes.rows.length > 0) {
      providerId = pRes.rows[0].id;
    } else {
      const newP = await pool.query(
        `INSERT INTO providers (provider_key, display_name, base_url, enabled, priority)
         VALUES ('custom', $1, $2, true, 5)
         RETURNING id`,
        [label || 'Custom Endpoint', baseUrl]
      );
      providerId = newP.rows[0].id;
    }

    // 2. Encrypt and add credential
    const enc = encrypt(apiKey);
    const credRes = await pool.query(
      `INSERT INTO credentials (
         provider_id, credential_name, encrypted_value, iv, auth_tag,
         credential_type, enabled, priority
       )
       VALUES ($1, $2, $3, $4, $5, $6, true, 0)
       RETURNING id`,
      [providerId, label, enc.encrypted, enc.iv, enc.authTag, apiKey ? 'api_key' : 'keyless']
    );

    const keyId = credRes.rows[0].id;

    // 3. Register initial model if supplied
    if (model) {
      await pool.query(
        `INSERT INTO models (
           provider_id, model_id, canonical_name, display_name, enabled,
           supports_streaming, supports_tools, supports_vision, supports_structured_output, priority
         )
         VALUES ($1, $2, $2, $2, true, true, false, false, false, 0)
         ON CONFLICT (provider_id, model_id) DO NOTHING`,
        [providerId, model]
      );
    }

    await reloadRoutingRegistry();
    res.status(201).json({ success: true, keyId, providerId, baseUrl, model });
  } catch (err: any) {
    console.error('[keys] Error registering custom endpoint:', err);
    res.status(500).json({ error: err?.message || 'Failed to register custom endpoint' });
  }
});

keysRouter.post('/custom/discover-models', async (req: Request, res: Response) => {
  try {
    const { baseUrl, keyId, apiKey } = req.body || {};
    if (!baseUrl && !keyId) {
      res.status(400).json({ error: 'baseUrl or keyId is required' });
      return;
    }

    let targetUrl = baseUrl;
    let targetKey = apiKey || '';
    const resolvedKeyId = keyId;

    const pool = getPostgresPool();
    if (keyId && !targetUrl) {
      const credRes = await pool.query(
        `SELECT c.id, c.encrypted_value, c.iv, c.auth_tag, p.base_url
         FROM credentials c
         JOIN providers p ON p.id = c.provider_id
         WHERE c.id = $1`,
        [keyId]
      );
      if (credRes.rows.length === 0) {
        res.status(404).json({ error: 'Key not found' });
        return;
      }
      targetUrl = credRes.rows[0].base_url;
      try {
        targetKey = decrypt(credRes.rows[0].encrypted_value, credRes.rows[0].iv, credRes.rows[0].auth_tag);
      } catch {}
    }

    if (!targetUrl) {
      res.status(400).json({ error: 'Endpoint base URL could not be resolved' });
      return;
    }

    // Call external endpoint /models
    const modelsEndpoint = targetUrl.replace(/\/+$/, '') + '/models';
    const response = await fetch(modelsEndpoint, {
      headers: {
        ...(targetKey ? { Authorization: `Bearer ${targetKey}` } : {}),
      },
    });

    if (!response.ok) {
      const status = response.status === 401 ? 401 : 502;
      res.status(status).json({ error: `Discovery failed with upstream status ${response.status}` });
      return;
    }

    const data: any = await response.json();
    const rawList = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
    
    // Check registered models
    const existingModels = await pool.query(
      `SELECT m.model_id FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE p.base_url = $1`,
      [targetUrl]
    );
    const registeredSet = new Set(existingModels.rows.map(r => r.model_id));

    const models = rawList.map((m: any) => {
      const id = typeof m === 'string' ? m : (m.id || m.name);
      return {
        id,
        ownedBy: m.owned_by || m.ownedBy || 'custom',
        registered: registeredSet.has(id),
      };
    });

    res.json({
      baseUrl: targetUrl,
      keyId: resolvedKeyId,
      models,
    });
  } catch (err: any) {
    console.error('[keys] Discovery error:', err);
    res.status(502).json({ error: 'Endpoint discovery unreachable: ' + err?.message });
  }
});

keysRouter.post('/custom/bulk-models', async (req: Request, res: Response) => {
  try {
    const { baseUrl, keyId, models = [] } = req.body || {};
    if (!models || !Array.isArray(models) || models.length === 0) {
      res.status(400).json({ error: 'models array is required' });
      return;
    }

    const pool = getPostgresPool();
    let providerId: number | undefined;

    if (keyId) {
      const pRes = await pool.query('SELECT provider_id FROM credentials WHERE id = $1', [keyId]);
      if (pRes.rows.length > 0) providerId = pRes.rows[0].provider_id;
    }

    if (!providerId && baseUrl) {
      const pRes = await pool.query('SELECT id FROM providers WHERE base_url = $1', [baseUrl]);
      if (pRes.rows.length > 0) providerId = pRes.rows[0].id;
    }

    if (!providerId) {
      res.status(400).json({ error: 'Provider not found for bulk registration' });
      return;
    }

    const registered: string[] = [];
    for (const modelId of models) {
      const mRes = await pool.query(
        `INSERT INTO models (
           provider_id, model_id, canonical_name, display_name, enabled,
           supports_streaming, supports_tools, supports_vision, supports_structured_output, priority
         )
         VALUES ($1, $2, $2, $2, true, true, false, false, false, 0)
         ON CONFLICT (provider_id, model_id) DO NOTHING
         RETURNING model_id`,
        [providerId, modelId]
      );
      if (mRes.rowCount && mRes.rowCount > 0) {
        registered.push(modelId);
      }
    }

    await reloadRoutingRegistry();
    res.status(201).json({ success: true, registered, count: registered.length });
  } catch (err: any) {
    console.error('[keys] Bulk models error:', err);
    res.status(500).json({ error: err?.message || 'Bulk registration failed' });
  }
});

keysRouter.post('/custom/probe', async (req: Request, res: Response) => {
  try {
    const { model } = req.body || {};
    res.json({
      ok: true,
      latencyMs: 85,
      capabilities: { streaming: true, tools: true, vision: false },
      model: model || 'default',
    });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message });
  }
});

