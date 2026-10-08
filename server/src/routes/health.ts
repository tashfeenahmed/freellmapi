import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { checkKeyHealth, checkAllKeys, pollKeyQuota, supportsQuotaPolling } from '../services/health.js';
import { getDegradationStatus } from '../services/degradation.js';
import { hasProvider, resolveProvider } from '../providers/index.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const healthRouter = Router();

// Get health status for all platforms
healthRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const platforms = db.prepare(`
    SELECT
      platform,
      COUNT(*) as total_keys,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
      SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_keys,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
    FROM api_keys
    GROUP BY platform
  `).all() as any[];

  const keys = db.prepare(`
    SELECT id, platform, label, status, enabled, created_at, last_checked_at, last_health_error
    FROM api_keys
    ORDER BY platform, created_at DESC
  `).all() as any[];

  res.json({
    platforms: platforms.map(p => ({
      platform: p.platform,
      hasProvider: hasProvider(p.platform),
      totalKeys: p.total_keys,
      healthyKeys: p.healthy_keys,
      rateLimitedKeys: p.rate_limited_keys,
      invalidKeys: p.invalid_keys,
      errorKeys: p.error_keys,
      unknownKeys: p.unknown_keys,
      enabledKeys: p.enabled_keys,
    })),
    keys: keys.map(k => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
      lastHealthError: k.last_health_error,
    })),
    quotaStates: getQuotaStateForKeys(),
    degradation: getDegradationStatus(),
  });
});

// Check a specific key
healthRouter.post('/check/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const status = await checkKeyHealth(keyId);
  res.json({ keyId, status });
});

// Check all keys. Forced: someone pressed the button and wants an answer about
// every key now, so the scheduled pass' recency skip and provider spacing (#553)
// don't apply.
healthRouter.post('/check-all', async (_req: Request, res: Response) => {
  await checkAllKeys({ force: true });
  res.json({ success: true });
});

// Poll one key's provider-reported balance now (#1403). The health pass only
// piggybacks the quota probe at most once per 15 minutes; this is the manual
// override — an operator adding a key wants the balance immediately instead
// of waiting for the next healthy pass after the throttle. Returns what the
// probe recorded (or the fresh state when the provider reported nothing, so
// the caller can tell "no quota endpoint / probe failed" from "fresh number").
healthRouter.post('/quota/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }
  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider || !supportsQuotaPolling(provider)) {
    res.status(400).json({ error: { message: `${row.platform} has no provider-reported quota endpoint` } });
    return;
  }
  // pollKeyQuota is failure-silent by design; its boolean tells us whether a
  // quota_api row was written, and the state query returns the fresh reading.
  const recorded = await pollKeyQuota(keyId, row, provider);
  const state = getQuotaStateForKeys().filter(
    q => q.keyId === keyId && q.source === 'quota_api',
  );
  res.json({ keyId, recorded, quotaStates: state });
});
