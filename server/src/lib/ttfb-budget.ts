import { getDb, type Db } from '../db/index.js';
import { endpointScopeForBaseUrl } from './endpoint-scope.js';

const DEFAULT_BUFFER_MS = 10_000;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60_000;
// One lucky 90s success must not triple an endpoint's patience: below this
// many in-window successes the history is an anecdote, not a distribution.
const DEFAULT_MIN_SAMPLES = 5;
// Logged TTFB runs from request start, so it includes the hops that failed
// before the endpoint was reached. A widened budget admits later successes,
// which log a larger TTFB, which widens the budget again — without a ceiling
// the allowance ratchets up by one buffer per refresh. Cap it at a multiple of
// the operator's base budget, which stays the declared unit of patience.
const MAX_BUDGET_MULTIPLIER = 3;
// The buffer is absolute, so against a small operator budget (say 6s) it would
// hand a 200ms endpoint 10s of patience. Only an endpoint whose P95 is itself a
// large share of the base counts as slow; with the 45s default this changes
// nothing, because a P95 under 22.5s plus the buffer already fits the base.
const SLOW_P95_BASE_FRACTION = 0.5;

export interface EndpointTtfbStats {
  p50Ms: number;
  p95Ms: number;
  sampleCount: number;
  weightedSamples: number;
}

interface Config {
  bufferMs: number;
  windowMs: number;
  halfLifeMs: number;
  minSamples: number;
}

interface Sample {
  ttfbMs: number;
  weight: number;
}

let cache: {
  db: Db;
  time: number;
  windowMs: number;
  halfLifeMs: number;
  stats: Map<string, EndpointTtfbStats>;
} | undefined;

/** Clear the derived cache; the request log remains the source of truth. */
export function invalidateTtfbBudgetCache(): void {
  cache = undefined;
}

function readConfig(db: Db): Config {
  const rows = db.prepare(`
    SELECT key, value FROM settings
    WHERE key IN ('slow_endpoint_buffer_ms', 'ttfb_budget_window_ms', 'ttfb_budget_half_life_ms', 'ttfb_budget_min_samples')
  `).all() as { key: string; value: string }[];
  const settings = new Map(rows.map(row => [row.key, row.value]));
  const duration = (key: string, fallback: number, allowZero = false): number => {
    for (const raw of [settings.get(key), process.env[key.toUpperCase()]]) {
      if (raw === undefined || raw.trim() === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) return value;
    }
    return fallback;
  };
  return {
    bufferMs: duration('slow_endpoint_buffer_ms', DEFAULT_BUFFER_MS, true),
    windowMs: duration('ttfb_budget_window_ms', DEFAULT_WINDOW_MS),
    halfLifeMs: duration('ttfb_budget_half_life_ms', DEFAULT_HALF_LIFE_MS),
    minSamples: duration('ttfb_budget_min_samples', DEFAULT_MIN_SAMPLES),
  };
}

function endpointKey(platform: string, endpointScope: string): string {
  // Catalog platforms have one endpoint identity, while custom relays share a
  // platform and must never inherit each other's latency history.
  return JSON.stringify([platform, platform === 'custom' ? endpointScopeForBaseUrl(endpointScope) : '']);
}

function timestampMs(raw: string): number {
  // SQLite's datetime('now') has no suffix but is UTC. Date.parse would treat
  // it as local time; ISO values may already carry Z or an explicit offset.
  const iso = raw.trim().replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
}

function percentile(samples: Sample[], totalWeight: number, quantile: number): number {
  const target = totalWeight * quantile;
  let cumulative = 0;
  for (const sample of samples) {
    cumulative += sample.weight;
    if (cumulative >= target) return sample.ttfbMs;
  }
  return samples[samples.length - 1].ttfbMs;
}

function statsFor(db: Db, config: Config, now: number): Map<string, EndpointTtfbStats> {
  if (cache?.db === db && cache.windowMs === config.windowMs && cache.halfLifeMs === config.halfLifeMs
    && now >= cache.time && now - cache.time < CACHE_TTL_MS) return cache.stats;

  // Keep the created_at range index usable despite SQLite/ISO timestamp
  // formats. Read one extra UTC day for offset-bearing ISO timestamps, then
  // enforce the precise sliding window after parsing all timestamps as UTC.
  const earliest = new Date(now - config.windowMs - 24 * 60 * 60 * 1000);
  const since = Number.isFinite(earliest.getTime()) ? earliest.toISOString().slice(0, 10) : '';
  const rows = db.prepare(`
    SELECT r.platform, r.ttfb_ms, r.created_at, k.base_url
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id AND k.platform = 'custom'
    WHERE r.created_at >= ? AND r.status = 'success' AND r.ttfb_ms IS NOT NULL
  `).all(since) as { platform: string; ttfb_ms: number; created_at: string; base_url: string | null }[];

  const buckets = new Map<string, Sample[]>();
  for (const row of rows) {
    if (typeof row.ttfb_ms !== 'number' || !Number.isFinite(row.ttfb_ms) || row.ttfb_ms < 0
      || typeof row.created_at !== 'string') continue;
    const age = now - timestampMs(row.created_at);
    if (!Number.isFinite(age) || age < 0 || age > config.windowMs) continue;
    const weight = Math.pow(0.5, age / config.halfLifeMs);
    if (!(weight > 0)) continue;
    const key = endpointKey(row.platform, row.base_url ?? '');
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = []);
    bucket.push({ ttfbMs: row.ttfb_ms, weight });
  }

  const stats = new Map<string, EndpointTtfbStats>();
  for (const [key, samples] of buckets) {
    samples.sort((a, b) => a.ttfbMs - b.ttfbMs);
    const weightedSamples = samples.reduce((total, sample) => total + sample.weight, 0);
    stats.set(key, {
      p50Ms: percentile(samples, weightedSamples, 0.5),
      p95Ms: percentile(samples, weightedSamples, 0.95),
      sampleCount: samples.length,
      weightedSamples,
    });
  }
  cache = { db, time: now, windowMs: config.windowMs, halfLifeMs: config.halfLifeMs, stats };
  return stats;
}

/** Decay-weighted nearest-rank percentiles of successful endpoint TTFB. */
export function getEndpointTtfbStats(
  platform: string,
  endpointScope = '',
  now = Date.now(),
): EndpointTtfbStats | null {
  if (!Number.isFinite(now)) return null;
  try {
    const db = getDb();
    const stats = statsFor(db, readConfig(db), now).get(endpointKey(platform, endpointScope));
    return stats ? { ...stats } : null;
  } catch {
    invalidateTtfbBudgetCache();
    return null;
  }
}

/** Give historically slow endpoints their P95 TTFB plus a safety buffer. */
export function getEndpointTimeBudgetMs(
  baseBudgetMs: number,
  platform: string,
  endpointScope = '',
  now = Date.now(),
): number {
  if (!Number.isFinite(baseBudgetMs) || baseBudgetMs <= 0 || !Number.isFinite(now)
    || process.env.TTFB_BUDGET_DISABLED?.trim() === '1') return baseBudgetMs;
  try {
    const db = getDb();
    const config = readConfig(db);
    const stats = statsFor(db, config, now).get(endpointKey(platform, endpointScope));
    if (!stats || stats.p95Ms <= 0 || stats.sampleCount < config.minSamples
      || stats.p95Ms < baseBudgetMs * SLOW_P95_BASE_FRACTION) return baseBudgetMs;
    const adaptiveBudget = stats.p95Ms + config.bufferMs;
    if (!Number.isFinite(adaptiveBudget)) return baseBudgetMs;
    return Math.max(baseBudgetMs, Math.min(adaptiveBudget, baseBudgetMs * MAX_BUDGET_MULTIPLIER));
  } catch {
    // Missing/locked DB or a bad log must not break the proxy hot path.
    invalidateTtfbBudgetCache();
    return baseBudgetMs;
  }
}
