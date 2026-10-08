import type { ProviderQuotaState } from '../../../../shared/types'
import { sqliteUtcToIso } from '@/lib/utils'

// #1403 phase 3: the provider-reported balance to show on a key row. A key can
// hold several quota pools (requests vs tokens, per account); the one with the
// lowest remaining fraction is what runs dry first and starts sending traffic
// around the key, so that's the pool the row should surface. States with no
// numeric reading (null remaining/limit) carry no information a badge could
// show, so they're skipped rather than rendered as 0%.
//
// Short windows are skipped too: a per-minute rate-limit header (or a token
// bucket) refills within seconds, so a busy key would flash amber on every
// burst. Only a balance that will not refill within the hour is worth a badge,
// and a window whose reset already passed is full again.
export const BALANCE_MIN_WINDOW_MS = 60 * 60 * 1000

export interface KeyBalance {
  remaining: number
  limit: number | null
  metric: ProviderQuotaState['metric']
  /** remaining/limit, or null when the provider never reported a limit. */
  fraction: number | null
}

export function balanceByKey(states: ProviderQuotaState[], now: number = Date.now()): Map<number, KeyBalance> {
  const out = new Map<number, KeyBalance>()
  for (const s of states) {
    if (s.remaining == null) continue
    if (s.resetStrategy === 'token_bucket') continue
    if (s.resetAt) {
      const resetMs = Date.parse(sqliteUtcToIso(s.resetAt))
      if (Number.isFinite(resetMs) && resetMs - now < BALANCE_MIN_WINDOW_MS) continue
    }
    const limit = s.limit ?? null
    const fraction = limit != null && limit > 0 ? s.remaining / limit : null
    const prev = out.get(s.keyId)
    if (!prev) {
      out.set(s.keyId, { remaining: s.remaining, limit, metric: s.metric, fraction })
      continue
    }
    // Prefer the tighter fraction; when both lack a limit, the first reading
    // stays (the poll returns them in stable platform/metric order).
    if (fraction != null && (prev.fraction == null || fraction < prev.fraction)) {
      out.set(s.keyId, { remaining: s.remaining, limit, metric: s.metric, fraction })
    }
  }
  return out
}
