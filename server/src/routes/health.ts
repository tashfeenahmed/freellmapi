import { Router } from 'express';
import type { Request, Response } from 'express';
import { getActiveRegistry } from '../services/router-registry.js';
import { getPostgresPool } from '../db/postgres.js';
import { hasProvider } from '../providers/index.js';
import { checkKeyHealth, checkAllKeys } from '../services/health.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const healthRouter = Router();

// GET /api/health - System and provider health status
healthRouter.get('/', (_req: Request, res: Response) => {
  try {
    const registry = getActiveRegistry();
    const providers = registry.getAllProviders();
    const credentials = registry.getAllCredentials();
    const now = Date.now();

    const providerHealthList = providers.map(p => {
      const creds = registry.getCredentialsForProvider(p.id);
      const totalKeys = creds.length;
      const enabledKeys = creds.filter(c => c.enabled).length;
      const healthyKeys = creds.filter(c => c.enabled && c.runtime.cooldownUntil <= now).length;
      const rateLimitedKeys = creds.filter(c => c.enabled && c.runtime.cooldownUntil > now).length;
      const invalidKeys = creds.filter(c => !c.enabled).length;

      let status = 'unknown';
      if (!p.enabled || enabledKeys === 0) {
        status = 'disabled';
      } else if (healthyKeys > 0) {
        status = 'healthy';
      } else if (rateLimitedKeys > 0) {
        status = 'cooldown';
      } else {
        status = 'degraded';
      }

      return {
        platform: p.key,
        displayName: p.displayName,
        hasProvider: hasProvider(p.key as Platform),
        status,
        totalKeys,
        enabledKeys,
        healthyKeys,
        rateLimitedKeys,
        invalidKeys,
        errorKeys: 0,
        unknownKeys: 0,
      };
    });

    const keyHealthList = credentials.map(c => {
      const isCooldown = c.runtime.cooldownUntil > now;
      let status = 'healthy';
      if (!c.enabled) {
        status = 'invalid';
      } else if (isCooldown) {
        status = 'rate_limited';
      } else if (c.runtime.circuitState === 'DEGRADED') {
        status = 'degraded';
      }

      return {
        id: c.id,
        platform: c.providerKey,
        label: c.name,
        status,
        enabled: c.enabled,
        activeRequests: c.runtime.activeRequests,
        ewmaLatencyMs: c.runtime.ewmaLatencyMs,
        cooldownRemainingMs: Math.max(0, c.runtime.cooldownUntil - now),
        lastUsedAt: c.runtime.lastUsedAt ? new Date(c.runtime.lastUsedAt).toISOString() : null,
        lastFailedAt: c.runtime.lastFailedAt ? new Date(c.runtime.lastFailedAt).toISOString() : null,
        lastCheckedAt: c.runtime.lastUsedAt ? new Date(c.runtime.lastUsedAt).toISOString() : null,
        lastHealthError: c.runtime.lastHealthError,
      };
    });

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      platforms: providerHealthList,
      keys: keyHealthList,
    });
  } catch (err: any) {
    console.error('[health] Error getting health status:', err);
    res.status(500).json({ error: 'Failed to get health status' });
  }
});

// POST /api/health/check-all — run a full health pass across every enabled key.
healthRouter.post('/check-all', async (_req: Request, res: Response) => {
  try {
    const result = await checkAllKeys({ force: true });
    await (await import('../services/router-registry.js')).reloadRoutingRegistry();
    res.json({ ok: true, checked: result.checkedKeyIds.length, skipped: result.skippedKeyIds.length });
  } catch (err: any) {
    console.error('[health] Error running full health check:', err);
    res.status(500).json({ error: 'Failed to run health check' });
  }
});

// POST /api/health/check/:id — health-check a single credential.
healthRouter.post('/check/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid key ID' });
      return;
    }
    const status = await checkKeyHealth(id);
    await refreshRuntimeHealth(id);
    res.json({ ok: true, id, status });
  } catch (err: any) {
    console.error('[health] Error checking key:', err);
    res.status(500).json({ error: 'Failed to check key' });
  }
});

// After a health check updates the DB, mirror the fresh error / timestamps into
// the in-memory registry runtime so /api/health returns them immediately
// instead of waiting for the next registry reload.
async function refreshRuntimeHealth(id: number): Promise<void> {
  const registry = getActiveRegistry();
  const record = registry.getCredentialById(id);
  if (!record) return;
  const pool = getPostgresPool();
  const res = await pool.query(
    `SELECT last_health_error, last_checked_at FROM credentials WHERE id = $1`,
    [id]
  );
  const row = res.rows[0];
  if (!row) return;
  record.runtime.lastHealthError = row.last_health_error || null;
  if (row.last_checked_at) {
    record.runtime.lastUsedAt = new Date(row.last_checked_at).getTime();
  }
}
