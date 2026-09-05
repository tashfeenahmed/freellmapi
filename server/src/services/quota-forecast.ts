import type { QuotaObservationView } from './provider-quota.js';
import { getQuotaStateForKeys } from './provider-quota.js';
import { getDb } from '../db/index.js';

// Daily free-tier balance forecast (#1104). Free tiers reset on a per-account
// window (usually UTC midnight) and the only way to know how much headroom is
// left before that reset is to read what the providers themselves reported.
// This is a pure aggregation over `getQuotaStateForKeys()` — no new tables, no
// extra probes — so it costs nothing beyond the query the health view already
// runs.
//
// The value it adds over the raw rows: one number per platform that answers
// "can I keep calling this platform for the rest of today?", plus a
// low-balance warning an agent can gate on BEFORE sending a request that would
// 429.

export const LOW_BALANCE_THRESHOLD = 0.1; // <10% of the daily window left → warn
export const LOW_BALANCE_ABSOLUTE = 20; // ...or fewer than 20 requests left
// The absolute floor is a statement about big windows: "20 left" is alarming
// out of 14400/day and unremarkable out of 30/day. Below this limit the
// percentage rule alone decides, otherwise a small tier would warn from its
// first request onwards and the flag would mean nothing.
export const LOW_BALANCE_ABSOLUTE_MIN_LIMIT = 200;

// Rate observation window: look at requests in the last N minutes to estimate
// current consumption speed. Ten minutes covers bursty usage while ignoring
// sub-hour lulls; shorter windows would jitter, longer ones would lag.
export const RATE_OBSERVATION_WINDOW_MINUTES = 10;

export interface QuotaForecastEntry {
  /** Platform the pool belongs to, e.g. 'groq'. */
  platform: string;
  /** Human-readable pool label (platform::scope), e.g. 'groq::account'. */
  pool: string;
  /** Requests used in the current window. Null when `remaining` is unknown,
   *  since used is only ever derived from it. */
  used: number | null;
  /** Requests remaining in the current window. Null when unknown. */
  remaining: number | null;
  /** Window total. Null when the provider never reported a limit. */
  limit: number | null;
  /** 0..100 share of the window still available (best-effort). */
  remaining_pct: number | null;
  /** ISO timestamp of the window reset, or null when never observed. */
  reset_at: string | null;
  /** True when less than LOW_BALANCE_THRESHOLD of the window remains, or —
   *  on a window of at least LOW_BALANCE_ABSOLUTE_MIN_LIMIT — fewer than
   *  LOW_BALANCE_ABSOLUTE requests do. Always false when remaining is unknown. */
  low_balance: boolean;
  /** Seconds until reset_at, or null when reset_at is unknown/expired. */
  seconds_until_reset: number | null;

  // --- estimated-exhaustion fields (the #1104 extension) ---

  /** Observed request rate in the last `RATE_OBSERVATION_WINDOW_MINUTES` minutes,
   *  or null when there is not enough recent request volume to estimate honestly.
   *  Non-null values are rounded to 2 decimal places. */
  rate_per_min: number | null;
  /** ISO timestamp of when the current window is expected to be exhausted at the
   *  observed rate, or null when the rate is too low / unknown to predict. A pool
   *  whose window has already expired or whose remaining is unknown is excluded
   *  regardless. */
  estimated_exhaustion_at: string | null;
}

function secondsUntilReset(resetAt: string | null): number | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
}

function estimateRatePerMin(platform: string): number | null {
  // Count requests in the observation window and convert to per-minute rate.
  // Null when the window is too empty to support a meaningful estimate — a
  // silent 0/min would make exhaustion-at project to "now" and mislead callers.
  try {
    const windowMs = RATE_OBSERVATION_WINDOW_MINUTES * 60 * 1000;
    const since = new Date(Date.now() - windowMs).toISOString();
    // better-sqlite3 returns aggregate results as { cnt: number | bigint }
    // (bigint when the count exceeds Number.MAX_SAFE_INTEGER, which won't
    // happen here, but the type reflects the runtime value). Cast via any to
    // keep the branch simple.
    const raw = getDb().prepare(
      `SELECT COUNT(*) AS cnt FROM requests
       WHERE platform = ? AND created_at >= ?`,
    ).get(platform, since) as any;
    const cnt = typeof raw?.cnt === 'bigint' ? Number(raw.cnt)
      : typeof raw?.cnt === 'number' ? raw.cnt
      : 0;
    if (!Number.isFinite(cnt)) return null;
    if (cnt < 3) return null;
    return Math.round((cnt / RATE_OBSERVATION_WINDOW_MINUTES) * 100) / 100;
  } catch {
    return null;
  }
}

function estimateExhaustionAt(
  remaining: number,
  limit: number,
  ratePerMin: number | null,
  resetAt: string | null,
): string | null {
  // No observed rate → no honest projection. Rates too low to matter are
  // excluded at the caller level (rate_per_min itself is null).
  if (ratePerMin === null || ratePerMin <= 0) return null;
  // Remaining is known (caller checks) and limit is positive (enforced below).
  const minutesUntilEmpty = remaining / ratePerMin;
  const secondsFromNow = Math.ceil(minutesUntilEmpty * 60);
  const ms = Date.now() + secondsFromNow * 1000;
  // Never project past the natural window reset: if the window expires first,
  // we have headroom even if the request count would otherwise exhaust the
  // pool — the quota header tracks the remaining *before* reset, not absolute
  // spending.
  const resetMs = resetAt ? new Date(resetAt).getTime() : Infinity;
  const capped = Math.min(ms, resetMs - 1);
  if (capped <= Date.now()) return null;
  return new Date(capped).toISOString();
}

function entryFor(row: QuotaObservationView): QuotaForecastEntry | null {
  // Only request-based windows are predictable from quota headers; token pools
  // reset semantics vary too much across providers to forecast honestly.
  if (row.metric !== 'requests') return null;
  // Without a known limit there is no window to forecast — nothing to warn on.
  if (typeof row.limit !== 'number' || row.limit <= 0) return null;

  const limit = row.limit;
  const remaining = typeof row.remaining === 'number' ? row.remaining : null;

  // An unknown `remaining` says nothing about consumption: reporting the whole
  // limit as used would read as an exhausted pool when it may be untouched.
  const used = remaining === null ? null : Math.max(0, limit - remaining);
  let remainingPct: number | null = null;
  let lowBalance = false;
  if (remaining !== null) {
    remainingPct = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
    const absoluteApplies = limit >= LOW_BALANCE_ABSOLUTE_MIN_LIMIT;
    lowBalance = (absoluteApplies && remaining <= LOW_BALANCE_ABSOLUTE)
      || remaining / limit < LOW_BALANCE_THRESHOLD;
  }

  // Rate projection is gated on remaining being known (unknown remaining makes
  // any rate look like a free lunch until the next quota refresh).
  const ratePerMin = remaining !== null ? estimateRatePerMin(row.platform) : null;
  const estimatedExhaustionAt = (remaining !== null && ratePerMin !== null && remaining > 0)
    ? estimateExhaustionAt(remaining, limit, ratePerMin, row.resetAt ?? null)
    : null;

  return {
    platform: row.platform,
    pool: row.quotaPoolKey ?? `${row.platform}::default`,
    used,
    remaining,
    limit,
    remaining_pct: remainingPct,
    reset_at: row.resetAt ?? null,
    low_balance: lowBalance,
    seconds_until_reset: secondsUntilReset(row.resetAt ?? null),
    rate_per_min: ratePerMin,
    estimated_exhaustion_at: estimatedExhaustionAt,
  };
}

// Dedupe to the TIGHTEST row per platform+pool: a platform with several keys
// sharing one account pool reports the same window per key, and the number that
// matters for "can I keep calling" is the least headroom left.
export function getQuotaForecast(): QuotaForecastEntry[] {
  const byKey = new Map<string, QuotaForecastEntry>();
  for (const row of getQuotaStateForKeys()) {
    const entry = entryFor(row);
    if (!entry) continue;
    // `pool` already carries its platform ("groq::account"), so it is the key.
    const key = entry.pool;
    const prev = byKey.get(key);
    if (!prev || (entry.remaining_pct ?? Infinity) < (prev.remaining_pct ?? Infinity)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    // Low-balance pools first — the ones the caller most needs to see.
    if (a.low_balance !== b.low_balance) return a.low_balance ? -1 : 1;
    return a.platform.localeCompare(b.platform);
  });
}
