import type { QuotaObservationView } from './provider-quota.js';
import { getQuotaStateForKeys } from './provider-quota.js';

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
}

function secondsUntilReset(resetAt: string | null): number | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
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
