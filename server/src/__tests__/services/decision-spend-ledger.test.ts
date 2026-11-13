import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { runDecision, DecisionError } from '../../services/decision.js';
import { getMonthlyUsage } from '../../services/key-budget.js';
import { seedDecisionModels } from '../helpers/decision-models.js';
import { ringSnapshot, clearLogs } from '../../lib/server-logs.js';

// POST /v1/decisions spends real provider quota on every routing turn, but
// logDecision only wrote decision_requests. The per-key monthly caps (#1158)
// and GET /v1/usage read key_monthly_usage, which other surfaces feed through
// their `requests` rows — so a capped key never accrued decision spend and
// served decisions forever past its cap. Decisions now settle into the ledger
// directly, without a `requests` row that would double-count chat turns in
// the dashboard's request analytics.

const realFetch = globalThis.fetch;

function addKey(platform: string, monthlyRequestCap = 0): number {
  const raw = platform === 'cloudflare' ? 'acct123:cf-token' : `${platform}-test-key`;
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(platform, encrypted, iv, authTag, monthlyRequestCap);
  return Number(row.lastInsertRowid);
}

function spendRequests(keyId: number, requests: number) {
  getDb().prepare(
    'INSERT INTO key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, ?, 10)',
  ).run(keyId, new Date().toISOString().slice(0, 7), requests);
}

const ANSWERS = { tier: { type: 'choice', choice: 'code', probabilities: { light: 0.02, code: 0.98 }, confidence: 0.96 } };
const REQUEST = {
  state: 'Write a Python function that merges two sorted lists.',
  questions: {
    tier: { type: 'choice' as const, instructions: 'Which tier should answer?', criteria: { light: 'chat', code: 'coding' } },
  },
};

const okResponse = () => new Response(JSON.stringify({
  success: true,
  result: { model: 'clef-flash', answers: ANSWERS, usage: { input_tokens: 219, output_tokens: 0 } },
}), { status: 200 });

describe('decision spend lands in the monthly ledger (#1158)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedDecisionModels();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('a served decision counts toward the monthly ledger without a requests row', async () => {
    const key = addKey('cloudflare');
    globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    const out = await runDecision(REQUEST);
    expect(out.provider).toBe('cloudflare');

    // key_monthly_usage is what the caps and /v1/usage read.
    const usage = getMonthlyUsage(key);
    expect(usage.requests).toBe(1);
    expect(usage.tokens).toBeGreaterThan(0);
    // The decision stays out of the request analytics (decision_requests
    // already backs the Decisions page).
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM requests WHERE key_id = ?').get(key) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('a failed attempt does NOT count toward usage', async () => {
    const key = addKey('cloudflare');
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })) as unknown as typeof fetch;

    await expect(runDecision(REQUEST)).rejects.toBeInstanceOf(DecisionError);

    const row = getDb().prepare('SELECT status FROM decision_requests WHERE key_id = ?').get(key) as any;
    expect(row).toMatchObject({ status: 'error' });
    expect(getMonthlyUsage(key)).toEqual({ requests: 0, tokens: 0 });
  });

  it('spend accumulates until the cap bites (end-to-end cap enforcement)', async () => {
    const key = addKey('cloudflare', 2);
    globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    await runDecision(REQUEST);
    await runDecision(REQUEST);
    expect(getMonthlyUsage(key).requests).toBe(2);

    const err = await runDecision(REQUEST).catch(e => e) as DecisionError;
    expect(err.status).toBe(429);
    expect(err.code).toBe('quota_exceeded');
  });

  it('a decision that crosses 80% of the cap logs the budget alert', async () => {
    clearLogs();
    const key = addKey('cloudflare', 5);
    spendRequests(key, 3);
    globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    await runDecision(REQUEST);

    const alerts = ringSnapshot().filter(e => e.event === 'key_budget_threshold');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain('80% of its monthly requests cap (4/5)');
  });

  it('a key at its cap is skipped without touching upstream', async () => {
    const key = addKey('cloudflare', 1);
    spendRequests(key, 1);
    const fetch = vi.fn(async () => okResponse());
    globalThis.fetch = fetch as unknown as typeof fetch;

    const err = await runDecision(REQUEST).catch(e => e) as DecisionError;
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('quota_exceeded');
    expect(fetch).not.toHaveBeenCalled();
  });
});
