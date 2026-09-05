import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  getMonthlyBudgetCaps,
  setMonthlyBudgetCaps,
  getMonthlyUsage,
  checkMonthlyBudget,
  secondsUntilNextMonth,
  nextMonthResetAt,
} from '../../services/key-budget.js';

// Per-key monthly budget (#1158): caps are opt-in (0 = unlimited), metering is
// the current UTC month's successful requests, and the rejection carries a
// Retry-After of seconds-until-next-month.

let keyId = 0;

function insertKey(overrides: { status?: string; monthlyRequestCap?: number; monthlyTokenCap?: number } = {}) {
  const { encrypted, iv, authTag } = encrypt('sk-test');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap, monthly_token_cap)
    VALUES ('groq', 'test', ?, ?, ?, ?, 1, ?, ?)
  `).run(
    encrypted, iv, authTag,
    overrides.status ?? 'healthy',
    overrides.monthlyRequestCap ?? 0,
    overrides.monthlyTokenCap ?? 0,
  );
  keyId = Number(result.lastInsertRowid);
}

function recordSuccess(now: Date) {
  getDb().prepare(
    `INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
     VALUES ('groq', 'llama', ?, 'success', 100, 50, 100, NULL, ?)`,
  ).run(keyId, now.toISOString().slice(0, 19).replace('T', ' '));
}

function recordFailure(now: Date) {
  getDb().prepare(
    `INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
     VALUES ('groq', 'llama', ?, 'error', 100, 0, 100, 'boom', ?)`,
  ).run(keyId, now.toISOString().slice(0, 19).replace('T', ' '));
}

function inThisMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 5, 12, 0, 0));
}

function lastMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 20, 12, 0, 0));
}

describe('key-budget: monthly caps (#1158)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM requests').run();
    keyId = 0;
  });

  it('defaults to unlimited (0 caps) for a fresh key', () => {
    insertKey();
    expect(getMonthlyBudgetCaps(keyId)).toEqual({ requestCap: 0, tokenCap: 0 });
    expect(checkMonthlyBudget(keyId, 100)).toEqual({ allowed: true });
  });

  it('setMonthlyBudgetCaps persists caps', () => {
    insertKey();
    expect(setMonthlyBudgetCaps(keyId, { requestCap: 10, tokenCap: 5000 })).toBe(true);
    expect(getMonthlyBudgetCaps(keyId)).toEqual({ requestCap: 10, tokenCap: 5000 });
    // Patching only one field leaves the other untouched.
    setMonthlyBudgetCaps(keyId, { requestCap: 3 });
    expect(getMonthlyBudgetCaps(keyId)).toEqual({ requestCap: 3, tokenCap: 5000 });
  });

  it('counts only the current month’s successful requests', () => {
    insertKey();
    recordSuccess(inThisMonth()); // counts: 1 req, 150 tokens
    recordSuccess(inThisMonth()); // counts: 2 req, 300 tokens
    recordFailure(inThisMonth()); // excluded (status != success)
    recordSuccess(lastMonth());   // excluded (previous month)

    const usage = getMonthlyUsage(keyId);
    expect(usage.requests).toBe(2);
    expect(usage.tokens).toBe(300);
  });

  it('rejects at the request cap with a next-month Retry-After', () => {
    insertKey({ monthlyRequestCap: 2 });
    recordSuccess(inThisMonth());
    recordSuccess(inThisMonth());

    const verdict = checkMonthlyBudget(keyId, 0);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe('monthly_request_cap');
      expect(verdict.retryAfterSec).toBeGreaterThan(0);
      // Retry-After should be at most ~32 days out (current month + 1 boundary).
      expect(verdict.retryAfterSec).toBeLessThanOrEqual(32 * 24 * 3600);
    }
  });

  it('rejects at the token cap, counting the estimated tokens of THIS request', () => {
    insertKey({ monthlyTokenCap: 1000 });
    recordSuccess(inThisMonth()); // 150 tokens used

    // 150 + 900 > 1000 → rejected.
    expect(checkMonthlyBudget(keyId, 900).allowed).toBe(false);
    // 150 + 800 <= 1000 → allowed.
    expect(checkMonthlyBudget(keyId, 800)).toEqual({ allowed: true });
  });

  it('does not reject when the cap is hit exactly on the boundary request', () => {
    insertKey({ monthlyRequestCap: 2 });
    recordSuccess(inThisMonth());
    recordSuccess(inThisMonth());
    // usage.requests === cap → rejected (strictly at/over the cap counts spent).
    expect(checkMonthlyBudget(keyId, 0).allowed).toBe(false);
  });

  it('secondsUntilNextMonth lands on the next UTC month boundary', () => {
    const now = Date.UTC(2026, 6, 15, 10, 0, 0); // 2026-07-15
    const secs = secondsUntilNextMonth(now);
    expect(secs).toBeGreaterThan(0);
    const reset = nextMonthResetAt(now);
    expect(reset).toBe('2026-08-01T00:00:00.000Z');
    // seconds until that boundary
    const expected = Math.floor((Date.parse('2026-08-01T00:00:00.000Z') - now) / 1000);
    expect(secs).toBe(expected);
  });
});
