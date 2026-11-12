import type { KeyStatus } from '@freellmapi/shared/types.js';

// API key health (M01). A key's state is api_keys.status + enabled, with
// last_health_error and last_checked_at beside it. This module holds the rules
// every reader and writer shares, so "usable" and "fresh start" are written
// once instead of copied into each query. No imports beyond a type: health.ts,
// the key routes and the router all depend on it, so it must not depend back.

/** Statuses that may serve traffic: probed healthy, or not checked yet. An
 *  'unknown' key is usable until a probe says otherwise. */
export const USABLE_KEY_STATUSES = ['healthy', 'unknown'] as const satisfies readonly KeyStatus[];

/** SQL: the key's status may serve traffic. For queries that check `enabled`
 *  on their own terms (or not at all). */
export const USABLE_STATUS_SQL = `status IN (${USABLE_KEY_STATUSES.map(s => `'${s}'`).join(', ')})`;

/** SQL: the key may serve traffic right now. */
export const USABLE_KEY_SQL = `enabled = 1 AND ${USABLE_STATUS_SQL}`;

export function isUsableStatus(status: string): boolean {
  return (USABLE_KEY_STATUSES as readonly string[]).includes(status);
}

export function isUsableKey(key: { enabled: number | boolean; status: string }): boolean {
  return (key.enabled === 1 || key.enabled === true) && isUsableStatus(key.status);
}

/** SQL SET fragment for a credential an operator just (re)registered or
 *  replaced: unchecked, with no reason or check time left over from the old
 *  one. Pair it with resetInvalidStreak(id). */
export const KEY_FRESH_START_SQL = "status = 'unknown', last_checked_at = NULL, last_health_error = NULL";

// Consecutive confirmed-invalid probes per key. In memory only, so a restart
// starts every count over; health.ts auto-disables a key at its threshold.
const invalidStreaks = new Map<number, number>();

/** One more confirmed-invalid probe; returns the streak length. */
export function bumpInvalidStreak(keyId: number): number {
  const count = (invalidStreaks.get(keyId) ?? 0) + 1;
  invalidStreaks.set(keyId, count);
  return count;
}

/** The key proved itself, or an operator gave it a fresh start (re-enabled it,
 *  or replaced its credential). Without this a re-enabled key kept the streak
 *  that disabled it, and its next single failure disabled it again. */
export function resetInvalidStreak(keyId: number): void {
  invalidStreaks.delete(keyId);
}
