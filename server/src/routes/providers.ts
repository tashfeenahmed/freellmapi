// GET /api/providers (dashboard session) — read-only overview of every
// registered provider for the dashboard's Providers page: static metadata
// (providers/metadata.ts), the free-only routing verdict
// (services/free-only.ts), and live state read from the same tables the Keys,
// Health and Analytics pages use. Not to be confused
// with GET /v1/providers (routes/status.ts), the machine-readable status
// endpoint for orchestrators behind the unified API key.
//
// Never returned: key material (encrypted or masked), IVs, auth tags, custom
// base URLs (they can embed credentials), proxy settings, or raw provider
// payloads. Health-error text passes through redactSecrets. Remaining quota is
// reported only when the provider itself stated it (response headers or its
// quota API); estimates and documentation figures are left out.
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { getAllProviders } from '../providers/index.js';
import { getProviderMetadata, modelFreeStatus, type ProviderMetadata } from '../providers/metadata.js';
import { freeOnlyDecision, freeOnlyPolicySummary } from '../services/free-only.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';
import { isSearchPlatform } from '../lib/search-platforms.js';
import { redactSecrets } from '../lib/log-redaction.js';

export const providerOverviewRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const PROVIDER_REPORTED_SOURCES = new Set(['header', 'quota_api']);

interface KeyRow {
  id: number; platform: string; label: string | null; status: string; enabled: number;
  last_checked_at: string | null; last_healthy_at: string | null; last_health_error: string | null;
}
interface ModelCountRow { platform: string; model_id: string; enabled: number }
interface TrafficRow { platform: string; total: number; ok: number; avg_latency: number | null; avg_ttfb: number | null }
interface CooldownRow { platform: string; active: number; soonest: number | null }

export type ProviderState = 'connected' | 'unhealthy' | 'disabled' | 'unconfigured';

/** Overall state from the platform's keys (keyless platforms count their sentinel row). */
export function providerState(keys: Pick<KeyRow, 'status' | 'enabled'>[]): ProviderState {
  if (keys.length === 0) return 'unconfigured';
  const enabled = keys.filter(k => k.enabled === 1);
  if (enabled.length === 0) return 'disabled';
  return enabled.some(k => k.status === 'healthy' || k.status === 'unknown') ? 'connected' : 'unhealthy';
}

function verification(meta: ProviderMetadata) {
  if (meta.officialDocsVerifiedOn) {
    return { status: 'officially-verified' as const, verifiedOn: meta.officialDocsVerifiedOn, label: `Checked against official docs on ${meta.officialDocsVerifiedOn}` };
  }
  if (meta.evidence.kind === 'repo-documented') {
    return { status: 'repo-documented' as const, verifiedOn: null, label: 'From this repository\'s notes; not checked against official docs' };
  }
  return { status: 'none' as const, verifiedOn: null, label: 'No evidence recorded' };
}

function latestIso(values: (string | null)[]): string | null {
  const times = values.filter((v): v is string => !!v).sort();
  return times.length ? times[times.length - 1] : null;
}

providerOverviewRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();

  const keys = db.prepare(
    'SELECT id, platform, label, status, enabled, last_checked_at, last_healthy_at, last_health_error FROM api_keys ORDER BY platform, id',
  ).all() as KeyRow[];
  const models = db.prepare('SELECT platform, model_id, enabled FROM models').all() as ModelCountRow[];
  const since = new Date(now - DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
  const traffic = db.prepare(`
    SELECT platform, COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS ok,
           AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avg_latency,
           AVG(CASE WHEN status = 'success' THEN ttfb_ms END) AS avg_ttfb
      FROM requests
     WHERE created_at >= ?
     GROUP BY platform
  `).all(since) as TrafficRow[];
  const cooldowns = db.prepare(`
    SELECT platform, COUNT(*) AS active, MIN(expires_at_ms) AS soonest
      FROM rate_limit_cooldowns
     WHERE expires_at_ms > ?
     GROUP BY platform
  `).all(now) as CooldownRow[];
  const quota = getQuotaStateForKeys().filter(q => PROVIDER_REPORTED_SOURCES.has(q.source));

  const byPlatform = <T extends { platform: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.platform, [...(map.get(row.platform) ?? []), row]);
    return map;
  };
  const keysBy = byPlatform(keys);
  const modelsBy = byPlatform(models);
  const trafficBy = new Map(traffic.map(t => [t.platform, t]));
  const cooldownBy = new Map(cooldowns.map(c => [c.platform, c]));
  const quotaBy = byPlatform(quota);

  const providers = getAllProviders().map(provider => {
    const platform = provider.platform;
    const meta = getProviderMetadata(platform);
    const platformKeys = keysBy.get(platform) ?? [];
    const enabledModels = (modelsBy.get(platform) ?? []).filter(m => m.enabled === 1);
    const automaticModels = enabledModels.filter(m => freeOnlyDecision(platform, m.model_id, 'automatic').allowed);
    const t = trafficBy.get(platform);
    const c = cooldownBy.get(platform);
    const state = providerState(platformKeys);
    return {
      platform,
      name: provider.name,
      kind: isSearchPlatform(platform) ? 'search' : 'chat',
      keyless: provider.keyless,
      credentialsRequired: !provider.keyless && meta.auth !== 'operator-configured',
      state,
      metadata: meta,
      verification: verification(meta),
      automaticRouting: (() => {
        if (enabledModels.length === 0) return { eligible: false, reason: 'no enabled models' };
        if (automaticModels.length > 0) return { eligible: true };
        return { eligible: false, reason: freeOnlyDecision(platform, enabledModels[0].model_id, 'automatic').reason ?? 'not eligible' };
      })(),
      keys: {
        total: platformKeys.length,
        enabled: platformKeys.filter(k => k.enabled === 1).length,
        healthy: platformKeys.filter(k => k.status === 'healthy').length,
        items: platformKeys.map(k => ({
          id: k.id,
          label: k.label,
          status: k.status,
          enabled: k.enabled === 1,
          lastCheckedAt: k.last_checked_at,
          lastHealthyAt: k.last_healthy_at,
          lastHealthError: k.last_health_error ? redactSecrets(k.last_health_error) : null,
        })),
      },
      lastCheckedAt: latestIso(platformKeys.map(k => k.last_checked_at)),
      models: {
        enabled: enabledModels.length,
        automaticallyRoutable: automaticModels.length,
        items: enabledModels.map(m => ({
          id: m.model_id,
          freeStatus: modelFreeStatus(meta, m.model_id),
          automatic: freeOnlyDecision(platform, m.model_id, 'automatic').allowed,
        })),
      },
      traffic24h: t
        ? {
            requests: t.total,
            successRate: t.total > 0 ? t.ok / t.total : null,
            avgLatencyMs: t.avg_latency != null ? Math.round(t.avg_latency) : null,
            avgTtfbMs: t.avg_ttfb != null ? Math.round(t.avg_ttfb) : null,
          }
        : { requests: 0, successRate: null, avgLatencyMs: null, avgTtfbMs: null },
      cooldowns: { active: c?.active ?? 0, soonestExpiresAt: c?.soonest ? new Date(c.soonest).toISOString() : null },
      // Only what the provider itself reported; empty means "not measured".
      providerReportedQuota: (quotaBy.get(platform) ?? []).map(q => ({
        keyId: q.keyId, metric: q.metric, limit: q.limit, remaining: q.remaining,
        resetAt: q.resetAt, source: q.source, observedAt: q.observedAt,
      })),
    };
  });

  res.json({
    generatedAt: new Date(now).toISOString(),
    freeOnly: freeOnlyPolicySummary(),
    notes: [
      'A successful key check proves the credential works; it says nothing about remaining quota.',
      'providerReportedQuota lists only figures the provider itself returned; empty means not measured.',
      'Free-tier classifications come from this repository\'s notes unless verification.status is officially-verified.',
    ],
    providers,
  });
});
