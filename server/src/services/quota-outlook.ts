import type { QuotaOutlookPool, QuotaOutlookResponse } from '@freellmapi/shared/types.js';
import { getQuotaStateForKeys, type QuotaObservationView } from './provider-quota.js';
import { estimateExhaustionAt, getRecentQuotaActivity, MIN_FORECAST_REQUESTS, RATE_OBSERVATION_WINDOW_MINUTES } from './quota-forecast.js';

const WARNING_REMAINING_RATIO = 0.2;
const WARNING_EXHAUSTION_MS = 2 * 60 * 60_000;
const MAX_OBSERVATION_AGE_MS = RATE_OBSERVATION_WINDOW_MINUTES * 60_000;

function utcMillis(value: string | null): number {
  if (!value) return NaN;
  return Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
}

function unavailableReason(row: QuotaObservationView, now: number): QuotaOutlookPool['unavailableReason'] {
  if (row.limit == null || !Number.isFinite(row.limit) || row.limit <= 0
      || row.remaining == null || !Number.isFinite(row.remaining) || row.remaining < 0 || row.remaining > row.limit) return 'quota_not_reported';
  const observed = utcMillis(row.observedAt);
  const reset = utcMillis(row.resetAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > MAX_OBSERVATION_AGE_MS
      || (Number.isFinite(reset) && reset <= now)) return 'stale_observation';
  if (!Number.isFinite(row.confidence) || row.confidence < 0.7) return 'low_confidence';
  return Number.isFinite(reset) ? null : 'reset_not_reported';
}

/** Local activity is measurable even without provider quota headers. No probes or writes. */
export function getQuotaOutlook(): QuotaOutlookResponse {
  const now = Date.now();
  const activity = getRecentQuotaActivity(now);
  const counts = new Map<string, number>();
  for (const row of activity) counts.set(row.pool, (counts.get(row.pool) ?? 0) + row.count);
  const selected = new Map<string, QuotaObservationView>();
  const rank = (row: QuotaObservationView) => {
    const reason = unavailableReason(row, now);
    return reason === null ? 0 : reason === 'reset_not_reported' ? 1 : reason === 'quota_not_reported' ? 3 : 2;
  };
  for (const row of getQuotaStateForKeys({ normalizeExpired: false })) {
    if (row.metric !== 'requests') continue;
    const previous = selected.get(row.quotaPoolKey);
    // A stale legacy key must not hide a current account reading. Among usable
    // readings, retain the tightest pool balance (same rounded-percent tie break).
    const score = (value: QuotaObservationView) => value.limit != null && value.limit > 0 && value.remaining != null
      ? Math.round(value.remaining / value.limit * 100) : Infinity;
    if (!previous || rank(row) < rank(previous) || (rank(row) === rank(previous) && score(row) < score(previous))) {
      selected.set(row.quotaPoolKey, row);
    }
  }

  const pools: QuotaOutlookPool[] = [];
  for (const row of selected.values()) {
    const reason = unavailableReason(row, now);
    const count = counts.get(row.quotaPoolKey) ?? 0;
    const rate = Math.round(count / RATE_OBSERVATION_WINDOW_MINUTES * 100) / 100;
    const known = reason !== 'quota_not_reported';
    const resetMs = utcMillis(row.resetAt);
    const resetAt = Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null;
    const exhaustion = reason === null && count >= MIN_FORECAST_REQUESTS && row.remaining! > 0
      ? estimateExhaustionAt(row.remaining!, rate, resetAt, now) : null;
    const status: QuotaOutlookPool['status'] = reason === 'quota_not_reported' ? 'unknown'
      : reason === 'stale_observation' ? 'stale'
      : reason ? 'unavailable'
      : row.remaining === 0 ? 'exhausted'
      : count < MIN_FORECAST_REQUESTS ? 'insufficient_data'
      : exhaustion ? 'forecast' : 'resets_first';
    let warning: QuotaOutlookPool['warning'] = null;
    if (reason === null) {
      if (row.remaining! / row.limit! < WARNING_REMAINING_RATIO) warning = 'low_balance';
      else if (exhaustion && Date.parse(exhaustion) - now <= WARNING_EXHAUSTION_MS) warning = 'exhausting_soon';
    }
    pools.push({
      platform: row.platform, pool: row.quotaPoolKey, limit: row.limit, remaining: row.remaining,
      remainingPct: known ? Math.round(row.remaining! / row.limit! * 100) : null,
      observedAt: row.observedAt, resetAt,
      recentRequestCount: count, ratePerMin: rate, estimatedExhaustionAt: exhaustion,
      unavailableReason: reason, status, warning,
    });
  }
  // Providers without any quota observations still have locally recorded usage.
  for (const row of activity) {
    if (selected.has(row.pool) || pools.some(pool => pool.pool === row.pool)) continue;
    const count = counts.get(row.pool)!;
    pools.push({ platform:row.platform,pool:row.pool,limit:null,remaining:null,remainingPct:null,
      observedAt:null,resetAt:null,recentRequestCount:count,ratePerMin:Math.round(count / RATE_OBSERVATION_WINDOW_MINUTES * 100) / 100,
      estimatedExhaustionAt:null,unavailableReason:'quota_not_reported',status:'unknown',warning:null });
  }
  pools.sort((a, b) => Number(Boolean(b.warning)) - Number(Boolean(a.warning)) || a.pool.localeCompare(b.pool));
  return { generatedAt:new Date(now).toISOString(),observationWindowMinutes:RATE_OBSERVATION_WINDOW_MINUTES,
    minimumRequests:MIN_FORECAST_REQUESTS,pools };
}
