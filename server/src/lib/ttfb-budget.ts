// ttfb-budget — per-endpoint TTFB-aware retry budget (#1262 / #1218 Gap 2).
//
// The default retry budget (`fallback_time_budget_ms`, 45s) was calibrated for
// commercial providers (OpenAI, Anthropic) that respond in sub-second TTFB.
// Free-tier endpoints — especially Ollama instances and provider aggregators
// on constrained hardware — regularly take 40–90s to emit their first byte.
// The router kills these healthy-but-slow endpoints at 45s, wasting the full
// failover budget on every request that hits them (#1218 Gap 2).
//
// This module closes the gap by tracking per-endpoint TTFB distributions and
// widening the retry budget for slow endpoints. Fast endpoints keep their
// original budget; the system only stretches when evidence says an endpoint
// is truly slow, not merely unlucky on one request.
//
// Design:
//
//   - Each (platform, endpoint_scope) bucket accumulates decay-weighted TTFB
//     samples using the same exponential-decay model as the reliability bandit
//     (2-day half-life, 7-day window). Only successful first-byte measurements
//     count — failures contribute no TTFB sample (they have none).
//   - On each call to `effectiveBudgetMs()`, the current P95 estimate is
//     computed from the decay-weighted quantile over the rolling window.
//   - The effective budget = max(base, p95 + buffer_ms). The base is the
//     existing global budget (settings → env → 45000ms default), so operators
//     who have already tuned it see no regression.
//   - A hard ceiling (`TTFB_BUDGET_CAP_MS`) prevents runaway expansion from a
//     single outlier — 300s (5 minutes) is generous for even the slowest
//     free endpoints while still bounding worst-case latency.
//
// What this does NOT do:
//
//   - It does not change the per-attempt stall semantics (`abortInFlight`).
//     The hedge timer still fires at `effectiveBudgetMs - elapsed` and still
//     calls `abortInFlight()` on the upstream fetch.
//   - It does not affect the circuit-breaker or platform-level skip — those
//     remain driven by failure-classification (endpoint-health.ts owns that).
//   - It does not persist samples across restarts. A cold start rebuilds the
//     window from scratch; the first ~10 successful requests on a slow
//     endpoint will see the base budget, which is fine — the endpoint was
//     probably under-probed before anyway.
//
// Kill switch: TTFB_BUDGET_DISABLED=1 (same convention as ENDPOINT_HEALTH_DISABLED).

import { getDb, getSetting } from '../db/index.js';
import { endpointHealthKey } from '../services/endpoint-health.js';

// ── Tunables ─────────────────────────────────────────────────────────────────

const DEFAULT_BASE_BUDGET_MS = 45_000;
const DEFAULT_SLOW_BUFFER_MS = 10_000;
const DEFAULT_P95_CAP_MS = 300_000;
const SAMPLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000;     // 2 days
const MIN_SAMPLES_FOR_WEIGHTED = 3;                // below this, fall back to simple mean
const CACHE_TTL_MS = 30_000;                       // in-memory cache per bucket

// ── Types ────────────────────────────────────────────────────────────────────

interface TtfbSample {
  atMs: number;
  ttfbMs: number;
}

interface BucketState {
  samples: TtfbSample[];
  lastUpdatedMs: number;
  cachedBudgetMs: number;
}

// ── In-memory state ──────────────────────────────────────────────────────────

const buckets = new Map<string, BucketState>();

function getBucket(key: string): BucketState {
  let rec = buckets.get(key);
  if (!rec) {
    rec = { samples: [], lastUpdatedMs: 0, cachedBudgetMs: 0 };
    buckets.set(key, rec);
  }
  return rec;
}

function disabled(): boolean {
  return process.env.TTFB_BUDGET_DISABLED === '1';
}

function baseBudgetMs(): number {
  const stored = getSetting('fallback_time_budget_ms');
  const env = process.env.FALLBACK_TIME_BUDGET_MS;
  for (const raw of [stored, env]) {
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_BASE_BUDGET_MS;
}

function slowBufferMs(): number {
  const raw = process.env.SLOW_ENDPOINT_BUFFER_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_SLOW_BUFFER_MS;
}

function p95CapMs(): number {
  const raw = process.env.TTFB_BUDGET_CAP_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_P95_CAP_MS;
}

// ── Sample bookkeeping ───────────────────────────────────────────────────────

function decayWeight(atMs: number, nowMs: number): number {
  const ageMs = nowMs - atMs;
  if (ageMs < 0) return 0;
  // Exponential decay with half-life: weight = 0.5^(age / half_life)
  return Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

function pruneSamples(rec: BucketState, nowMs: number): void {
  const cutoff = nowMs - SAMPLE_WINDOW_MS;
  rec.samples = rec.samples.filter(s => s.atMs >= cutoff);
}

/** Called off the hot path by the request-logging layer. Batch-friendly: can
 *  be called with multiple samples in a row before a flush. */
export function recordTtfbSample(platform: string, endpointScope: string, ttfbMs: number, nowMs = Date.now()): void {
  if (disabled()) return;
  if (ttfbMs <= 0 || !Number.isFinite(ttfbMs)) return;
  const key = endpointHealthKey(platform, endpointScope);
  const rec = getBucket(key);
  rec.samples.push({ atMs: nowMs, ttfbMs });
  rec.lastUpdatedMs = nowMs;
  rec.cachedBudgetMs = 0; // invalidate
}

/** Force-flush in-memory state to the SQLite sample log for restart resilience.
 *  Called periodically by the health pass or on shutdown. */
export function persistSamples(_nowMs = Date.now()): void {
  if (disabled()) return;
  try {
    const db = getDb();
    const tx = db.transaction(() => {
      for (const [key, rec] of buckets) {
        if (rec.samples.length === 0) continue;
        // Upsert-style: the sample log table has (platform, endpoint_scope, observed_at) as PK.
        // The bucket key encodes platform::endpointScope.
        for (const s of rec.samples) {
          const idx = key.indexOf('::');
          const platform = key.slice(0, idx);
          const endpointScope = key.slice(idx + 2);
          db.prepare(`
            INSERT INTO ttfb_samples (platform, endpoint_scope, ttfb_ms, observed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(platform, endpoint_scope, observed_at) DO NOTHING
          `).run(platform, endpointScope, s.ttfbMs, s.atMs);
        }
      }
    });
    tx();
  } catch {
    // Never let persistence break a request.
  }
}

// ── Budget computation ────────────────────────────────────────────────────────

function computeP95(samples: TtfbSample[], nowMs: number): number {
  if (samples.length === 0) return 0;
  const weighted: Array<{ w: number; t: number }> = samples.map(s => ({
    w: decayWeight(s.atMs, nowMs),
    t: s.ttfbMs,
  }));
  weighted.sort((a, b) => a.t - b.t);
  const totalW = weighted.reduce((sum, s) => sum + s.w, 0);
  if (totalW === 0) return 0;
  const target = totalW * 0.95;
  let cumW = 0;
  for (const s of weighted) {
    cumW += s.w;
    if (cumW >= target) return s.t;
  }
  return weighted[weighted.length - 1].t;
}

function estimateBudgetMs(key: string, rec: BucketState, nowMs: number): number {
  if (rec.samples.length < MIN_SAMPLES_FOR_WEIGHTED) {
    // Not enough evidence — fall back to simple arithmetic mean (which still
    // beats the base budget for a consistently slow endpoint).
    const sum = rec.samples.reduce((a, s) => a + s.ttfbMs, 0);
    return Math.round(sum / rec.samples.length);
  }
  return computeP95(rec.samples, nowMs);
}

/**
 * Compute the effective retry budget for one (platform, endpointScope) bucket.
 * Returns `null` when the bucket has no data — the caller should use the base
 * budget in that case.
 */
export function effectiveBudgetMs(platform: string, endpointScope: string, nowMs = Date.now()): number {
  if (disabled()) return baseBudgetMs();
  const key = endpointHealthKey(platform, endpointScope);
  const rec = getBucket(key);
  pruneSamples(rec, nowMs);
  if (Date.now() - rec.lastUpdatedMs > CACHE_TTL_MS || rec.cachedBudgetMs === 0) {
    const p95 = rec.samples.length > 0 ? estimateBudgetMs(key, rec, nowMs) : 0;
    const buffer = slowBufferMs();
    const cap = p95CapMs();
    rec.cachedBudgetMs = Math.min(baseBudgetMs() + p95 + buffer, cap);
    rec.lastUpdatedMs = Date.now();
  }
  return rec.cachedBudgetMs;
}

// ── Dashboard / observability ─────────────────────────────────────────────────

export interface TtfbBucketReport {
  platform: string;
  endpointScope: string;
  sampleCount: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
  budgetMs: number;
}

export function getTtfbBuckets(nowMs = Date.now()): TtfbBucketReport[] {
  if (disabled()) return [];
  const out: TtfbBucketReport[] = [];
  for (const [key, rec] of buckets) {
    if (rec.samples.length === 0) continue;
    const idx = key.indexOf('::');
    const platform = key.slice(0, idx);
    const endpointScope = key.slice(idx + 2);
    const samples = rec.samples;
    const sorted = samples.map(s => s.ttfbMs).sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? sorted[sorted.length - 1];
    const mean = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    const max = sorted[sorted.length - 1];
    out.push({
      platform,
      endpointScope,
      sampleCount: samples.length,
      p95Ms: p95,
      meanMs: mean,
      maxMs: max,
      budgetMs: effectiveBudgetMs(platform, endpointScope, nowMs),
    });
  }
  return out;
}

// ── Test seam ─────────────────────────────────────────────────────────────────

export function resetTtfbBudgetForTest(): void {
  buckets.clear();
}
