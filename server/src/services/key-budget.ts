/**
 * Per-key monthly budget (#1158): optional request/token caps per api_keys row,
 * enforced against the CURRENT UTC month's successful requests. A key at its
 * cap returns `quota_exceeded` (429) with a Retry-After of "seconds until the
 * next month" — the semantic GateLLM-style rejection so an agent knows when the
 * window resets instead of hammering a 429.
 *
 * Metering source is the `requests` table (status='success' rows only: failed
 * attempts burned nothing upstream worth billing against a monthly cap). The
 * month window is UTC — the same boundary freellmapi's daily quota windows use.
 * Caps are stored directly on api_keys (0 = unlimited, the pre-#1158 default),
 * so existing installs are unchanged until an operator sets a cap.
 */
import { getDb } from '../db/index.js';

export interface MonthlyBudgetCaps {
  /** 0 = unlimited (the default, unchanged behaviour). */
  requestCap: number;
  /** 0 = unlimited. */
  tokenCap: number;
}

export interface MonthlyUsage {
  /** Successful requests in the current UTC month. */
  requests: number;
  /** Sum of (input_tokens + output_tokens) over those successes. */
  tokens: number;
}

export type BudgetVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'monthly_request_cap' | 'monthly_token_cap'; retryAfterSec: number };

function utcMonthStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function utcNextMonthStartMs(now = Date.now()): number {
  const d = new Date(now);
  const month = d.getUTCMonth() + 1;
  return Date.UTC(d.getUTCFullYear() + Math.floor(month / 12), month % 12, 1);
}

/** SQLite datetime('now') format of a UTC month start, for the >= filter. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function getMonthlyBudgetCaps(keyId: number): MonthlyBudgetCaps {
  const row = getDb().prepare(
    'SELECT monthly_request_cap, monthly_token_cap FROM api_keys WHERE id = ?',
  ).get(keyId) as { monthly_request_cap: number; monthly_token_cap: number } | undefined;
  if (!row) return { requestCap: 0, tokenCap: 0 };
  return { requestCap: row.monthly_request_cap, tokenCap: row.monthly_token_cap };
}

export function setMonthlyBudgetCaps(
  keyId: number,
  patch: Partial<MonthlyBudgetCaps>,
): boolean {
  const sets: string[] = [];
  const values: number[] = [];
  if (patch.requestCap !== undefined) {
    sets.push('monthly_request_cap = ?');
    values.push(patch.requestCap);
  }
  if (patch.tokenCap !== undefined) {
    sets.push('monthly_token_cap = ?');
    values.push(patch.tokenCap);
  }
  if (sets.length === 0) return false;
  const result = getDb().prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values, keyId);
  return result.changes > 0;
}

export function getMonthlyUsage(keyId: number, now = Date.now()): MonthlyUsage {
  const monthStart = sqliteUtc(utcMonthStartMs(now));
  const row = getDb().prepare(`
    SELECT COUNT(*) AS requests,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM requests
     WHERE key_id = ?
       AND status = 'success'
       AND created_at >= ?
  `).get(keyId, monthStart) as { requests: number; tokens: number };
  const requests = typeof row?.requests === 'number' ? row.requests : Number(row?.requests ?? 0);
  const tokens = typeof row?.tokens === 'number' ? row.tokens : Number(row?.tokens ?? 0);
  return { requests, tokens };
}

/**
 * Check a key against its monthly caps, taking the current month's successful
 * usage plus the tokens THIS request would add. Returns allowed when both caps
 * are 0 (unlimited) or neither would be exceeded.
 */
export function checkMonthlyBudget(
  keyId: number,
  estimatedTokens: number,
  now = Date.now(),
): BudgetVerdict {
  const caps = getMonthlyBudgetCaps(keyId);
  if (caps.requestCap <= 0 && caps.tokenCap <= 0) return { allowed: true };

  const usage = getMonthlyUsage(keyId, now);
  if (caps.requestCap > 0 && usage.requests >= caps.requestCap) {
    return { allowed: false, reason: 'monthly_request_cap', retryAfterSec: secondsUntilNextMonth(now) };
  }
  if (caps.tokenCap > 0 && usage.tokens + estimatedTokens > caps.tokenCap) {
    return { allowed: false, reason: 'monthly_token_cap', retryAfterSec: secondsUntilNextMonth(now) };
  }
  return { allowed: true };
}

/** Seconds from `now` until the next UTC month boundary — the Retry-After value. */
export function secondsUntilNextMonth(now = Date.now()): number {
  return Math.max(1, Math.floor((utcNextMonthStartMs(now) - now) / 1000));
}

/** ISO timestamp of the next UTC month boundary (for headers / diagnostics). */
export function nextMonthResetAt(now = Date.now()): string {
  return new Date(utcNextMonthStartMs(now)).toISOString();
}
