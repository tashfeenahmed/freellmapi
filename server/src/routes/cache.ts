import { Router } from 'express';
import type { Request, Response } from 'express';
import { setSetting } from '../db/index.js';
import {
  getCacheStats,
  clearCache,
  isCacheEnabled,
  cacheTtlMs,
  cacheMaxEntries,
  cacheMaxTemperature,
  CACHE_ENABLED_SETTING,
} from '../services/cache.js';

export const cacheRouter = Router();

// Cache status + savings for the dashboard. "saved" tokens are provider tokens
// that hits avoided spending, i.e. the free-tier quota the cache gave back.
cacheRouter.get('/stats', (_req: Request, res: Response) => {
  const stats = getCacheStats();
  res.json({
    enabled: isCacheEnabled(),
    ttlSeconds: Math.round(cacheTtlMs() / 1000),
    maxEntries: cacheMaxEntries(),
    maxTemperature: cacheMaxTemperature(),
    ...stats,
    savedTokens: stats.savedPromptTokens + stats.savedCompletionTokens,
  });
});

// Toggle the cache at runtime (no restart). Persisted in settings, which wins
// over the RESPONSE_CACHE env var. Clears the value to fall back to the env
// default when `enabled` is null.
cacheRouter.put('/config', (req: Request, res: Response) => {
  const { enabled } = req.body ?? {};
  if (enabled === null) {
    setSetting(CACHE_ENABLED_SETTING, '');
  } else if (typeof enabled === 'boolean') {
    setSetting(CACHE_ENABLED_SETTING, enabled ? '1' : '0');
  } else {
    res.status(400).json({ error: { message: '`enabled` must be a boolean or null', type: 'invalid_request_error' } });
    return;
  }
  res.json({ enabled: isCacheEnabled() });
});

// Flush the cache (e.g. after changing keys/models, or to force fresh answers).
cacheRouter.delete('/', (_req: Request, res: Response) => {
  const removed = clearCache();
  res.json({ cleared: removed });
});
