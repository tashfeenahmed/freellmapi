import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Platform } from '@freellmapi/shared/types.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { isEncryptionKeyInitialized } from '../lib/crypto.js';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import { getProvider } from '../providers/index.js';
import { getSoonestCooldownExpiry } from '../services/ratelimit.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';
import {
  getQuotaForecast,
  LOW_BALANCE_THRESHOLD,
  LOW_BALANCE_ABSOLUTE,
  LOW_BALANCE_ABSOLUTE_MIN_LIMIT,
} from '../services/quota-forecast.js';
import { openapiSpec } from '../docs/openapi.js';

// Machine-readable operational endpoints for meta-gateways / orchestrators that
// run this proxy as one upstream lane (LibreChat, LiteLLM Proxy, OmniRoute — see
// #433). `/livez` and `/readyz` are unauthenticated so a load balancer can probe
// them; `/v1/providers` sits behind the same unified API key as the rest of /v1.

export const statusRouter = Router();
export const providersRouter = Router();

// Cheap "is the SQLite connection answering" probe. getDb() throws before initDb
// has run, and prepare/get throws if the handle is closed — either way the
// server is not serviceable, which is exactly the /livez and /readyz 503 signal.
function isDbReachable(): boolean {
  try {
    getDb().prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

// GET /livez — liveness. 200 when the process can serve at all: the DB answers
// and the encryption key is loaded (without it, stored provider keys can't be
// decrypted, so no request can be routed). 503 otherwise.
statusRouter.get('/livez', (_req: Request, res: Response) => {
  const db = isDbReachable();
  const encryptionKey = isEncryptionKeyInitialized();
  const uptime_s = Math.floor(process.uptime());
  const version = openapiSpec.info.version;

  if (!db || !encryptionKey) {
    res.status(503).json({
      status: 'unavailable',
      version,
      uptime_s,
      checks: { db, encryption_key: encryptionKey },
    });
    return;
  }

  res.json({ status: 'ok', version, uptime_s });
});

// GET /readyz — readiness. 200 when at least one upstream is serviceable right
// now (an enabled key whose status is healthy or not-yet-probed). 503 with a
// machine-readable reason otherwise, so a meta-gateway can skip this instance
// instead of eating a failover on every call.
statusRouter.get('/readyz', (_req: Request, res: Response) => {
  if (!isDbReachable()) {
    res.status(503).json({ status: 'unavailable', reason: 'db_unreachable' });
    return;
  }

  const db = getDb();
  const agg = db.prepare(`
    SELECT
      COUNT(*) AS enabled_keys,
      COUNT(DISTINCT CASE WHEN status IN ('healthy', 'unknown') THEN platform END) AS ready_upstreams
    FROM api_keys
    WHERE enabled = 1
  `).get() as { enabled_keys: number; ready_upstreams: number };

  const readyUpstreams = agg.ready_upstreams ?? 0;
  if (readyUpstreams > 0) {
    res.json({ status: 'ok', ready_upstreams: readyUpstreams });
    return;
  }

  // Distinguish "nothing configured" from "everything cooling down" from
  // "everything unhealthy" so the caller can act on the specific reason.
  let reason: string;
  if ((agg.enabled_keys ?? 0) === 0) {
    reason = 'no_upstreams_configured';
  } else if (getSoonestCooldownExpiry() != null) {
    reason = 'all_upstreams_rate_limited';
  } else {
    reason = 'all_upstreams_unhealthy';
  }

  res.status(503).json({ status: 'unavailable', reason });
});

interface PlatformKeyRow {
  platform: string;
  enabled_keys: number;
  healthy_keys: number;
  unknown_keys: number;
  invalid_keys: number;
  error_keys: number;
}

// GET /v1/providers — aggregate per-upstream state a smart router needs to
// decide "route here or skip", with no key material and no PII. Behind the
// unified API key (like the rest of /v1); mounted before the proxy rate limiter
// so status polling doesn't draw down a caller's request budget.
providersRouter.get('/providers', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const db = getDb();

  // Per-platform key-status rollup (only enabled keys count toward serviceability).
  const platformRows = db.prepare(`
    SELECT
      platform,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'healthy' THEN 1 ELSE 0 END) AS healthy_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'unknown' THEN 1 ELSE 0 END) AS unknown_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'invalid' THEN 1 ELSE 0 END) AS invalid_keys,
      SUM(CASE WHEN enabled = 1 AND status = 'error' THEN 1 ELSE 0 END) AS error_keys
    FROM api_keys
    GROUP BY platform
  `).all() as PlatformKeyRow[];

  // Active cooldowns (rate limiting) rolled up to the platform, with the soonest
  // resume time. rate_limit_cooldowns is per (platform, model, key); the MIN is
  // the earliest moment any of that platform's routes frees up.
  const now = Date.now();
  const cooldownRows = db.prepare(`
    SELECT platform, MIN(expires_at_ms) AS resume_ms
    FROM rate_limit_cooldowns
    WHERE expires_at_ms > ?
    GROUP BY platform
  `).all(now) as Array<{ platform: string; resume_ms: number }>;
  const resumeByPlatform = new Map(cooldownRows.map(r => [r.platform, r.resume_ms]));

  // Most recent probe error per platform (enabled keys, newest first).
  const errorRows = db.prepare(`
    SELECT platform, last_health_error
    FROM api_keys
    WHERE enabled = 1 AND last_health_error IS NOT NULL
    ORDER BY last_checked_at DESC
  `).all() as Array<{ platform: string; last_health_error: string }>;
  const lastErrorByPlatform = new Map<string, string>();
  for (const row of errorRows) {
    if (!lastErrorByPlatform.has(row.platform)) {
      lastErrorByPlatform.set(row.platform, row.last_health_error);
    }
  }

  // Best-effort request-quota headroom from observed quota state. Only surfaced
  // when a provider actually reported a `requests` limit; absent otherwise.
  const requestsRemainingByPlatform = new Map<string, number>();
  for (const q of getQuotaStateForKeys()) {
    if (q.metric !== 'requests' || typeof q.limit !== 'number' || q.limit <= 0) continue;
    if (typeof q.remaining !== 'number') continue;
    const pct = Math.max(0, Math.min(100, Math.round((q.remaining / q.limit) * 100)));
    const prev = requestsRemainingByPlatform.get(q.platform);
    // Keep the tightest (lowest) headroom seen for the platform.
    if (prev === undefined || pct < prev) requestsRemainingByPlatform.set(q.platform, pct);
  }

  const counts = { healthy: 0, rate_limited: 0, invalid: 0, unknown: 0 };

  const providers = platformRows
    .filter(p => p.enabled_keys > 0)
    .map(p => {
      const onCooldown = resumeByPlatform.has(p.platform);
      let status: 'healthy' | 'rate_limited' | 'invalid' | 'unknown';
      if (p.healthy_keys > 0 && !onCooldown) {
        status = 'healthy';
      } else if (onCooldown) {
        status = 'rate_limited';
      } else if (p.unknown_keys > 0) {
        status = 'unknown';
      } else if (p.invalid_keys > 0 || p.error_keys > 0) {
        status = 'invalid';
      } else {
        status = 'unknown';
      }
      counts[status] += 1;

      const provider = getProvider(p.platform as Platform);
      const entry: Record<string, unknown> = {
        platform: p.platform,
        name: provider?.name ?? p.platform,
        status,
        keys: p.enabled_keys,
      };
      if (status === 'rate_limited') {
        const resumeMs = resumeByPlatform.get(p.platform);
        if (resumeMs != null) entry.resume_at = new Date(resumeMs).toISOString();
      }
      if (status === 'invalid') {
        const lastError = lastErrorByPlatform.get(p.platform);
        if (lastError) entry.last_error = lastError;
      }
      const requestsRemaining = requestsRemainingByPlatform.get(p.platform);
      if (requestsRemaining != null) entry.requests_remaining_pct = requestsRemaining;
      return entry;
    });

  res.json({ providers, counts });
});

// GET /quota-forecast — per-pool daily headroom + low-balance warning (#1104).
// Machine-readable sibling of /v1/providers: same unified-key auth, no key
// material, no PII. A meta-gateway can gate its own routing on `low_balance`
// BEFORE spending a request that would 429, and know `seconds_until_reset` for
// "the window resets soon, hold off" scheduling.
providersRouter.get('/quota-forecast', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const forecast = getQuotaForecast();
  res.json({
    generated_at: new Date().toISOString(),
    low_balance_threshold: {
      pct: LOW_BALANCE_THRESHOLD,
      absolute: LOW_BALANCE_ABSOLUTE,
      absolute_min_limit: LOW_BALANCE_ABSOLUTE_MIN_LIMIT,
    },
    pools: forecast,
  });
});
