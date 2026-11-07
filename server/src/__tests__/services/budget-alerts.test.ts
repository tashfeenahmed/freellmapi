import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { logRequest } from '../../lib/request-log.js';
import { ringSnapshot, clearLogs } from '../../lib/server-logs.js';
import { setMonthlyBudgetCaps } from '../../services/key-budget.js';
import {
  budgetAlertWebhookUrl,
  budgetThresholdCrossings,
  budgetWebhookPayload,
  firedBudgetAlerts,
  noteBudgetAlerts,
} from '../../services/budget-alerts.js';

// Soft budget alerts: 80% and 100% of a key's monthly request/token caps log
// a `key_budget_threshold` event exactly once per threshold per UTC month,
// mirroring LiteLLM budget_alerts / OpenRouter's per-key spend-limit alert.

let keyId = 0;

function insertKey() {
  const { encrypted, iv, authTag } = encrypt('sk-test');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap, monthly_token_cap)
    VALUES ('groq', 'alert-test', ?, ?, ?, 'healthy', 1, 0, 0)
  `).run(encrypted, iv, authTag);
  keyId = Number(result.lastInsertRowid);
}

function alertEntries() {
  return ringSnapshot().filter(e => e.event === 'key_budget_threshold');
}

describe('budgetThresholdCrossings (pure)', () => {
  it('never crosses for unlimited caps', () => {
    expect(budgetThresholdCrossings({ requestCap: 0, tokenCap: 0 }, { requests: 10_000, tokens: 10_000_000 })).toEqual([]);
  });
  it('crosses 80% then 100% as usage grows', () => {
    const caps = { requestCap: 100, tokenCap: 0 };
    expect(budgetThresholdCrossings(caps, { requests: 79, tokens: 0 }).map(c => c.threshold)).toEqual([]);
    expect(budgetThresholdCrossings(caps, { requests: 80, tokens: 0 }).map(c => c.threshold)).toEqual([0.8]);
    const at = budgetThresholdCrossings(caps, { requests: 100, tokens: 0 });
    expect(at.map(c => c.threshold)).toEqual([0.8, 1.0]);
    expect(at.every(c => c.kind === 'requests')).toBe(true);
  });
  it('evaluates request and token caps independently', () => {
    const crossings = budgetThresholdCrossings(
      { requestCap: 1000, tokenCap: 100 },
      { requests: 10, tokens: 90 },
    );
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({ kind: 'tokens', threshold: 0.8, used: 90, cap: 100 });
  });
});

describe('budget alerts (end to end through the request log)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    clearLogs();
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM key_monthly_usage').run();
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'budget_alerts_fired%'").run();
    insertKey();
  });

  it('logs nothing below 80% and once at/above 80%', () => {
    setMonthlyBudgetCaps(keyId, { requestCap: 10, tokenCap: 0 });
    for (let i = 0; i < 7; i++) logRequest('groq', 'llama', keyId, 'success', 10, 0, 5, null);
    expect(alertEntries()).toHaveLength(0);

    logRequest('groq', 'llama', keyId, 'success', 10, 0, 5, null); // 8th → 80%
    const first = alertEntries();
    expect(first).toHaveLength(1);
    expect(first[0].message).toMatch(/80% of its monthly requests cap \(8\/10\)/);
    expect(firedBudgetAlerts(keyId)).toEqual(['requests:0.8']);

    logRequest('groq', 'llama', keyId, 'success', 10, 0, 5, null); // 9th → still 80% band
    expect(alertEntries()).toHaveLength(1); // deduped
  });

  it('logs a hard "AT CAP" warn once at 100% and keeps the 80% alert distinct', () => {
    setMonthlyBudgetCaps(keyId, { requestCap: 5, tokenCap: 0 });
    for (let i = 0; i < 5; i++) logRequest('groq', 'llama', keyId, 'success', 10, 0, 5, null);
    const entries = alertEntries();
    expect(entries).toHaveLength(2); // 80% + 100%
    const hard = entries.find(e => e.message.includes('KEY AT CAP'));
    expect(hard).toBeDefined();
    expect(hard!.level).toBe('warn');
    expect(hard!.message).toMatch(/100% of its monthly requests cap \(5\/5\)/);
    expect(firedBudgetAlerts(keyId).sort()).toEqual(['requests:0.8', 'requests:1']);

    logRequest('groq', 'llama', keyId, 'success', 10, 0, 5, null); // over cap: no new alerts
    expect(alertEntries()).toHaveLength(2);
  });

  it('meters token caps from the same ledger the block enforces', () => {
    setMonthlyBudgetCaps(keyId, { requestCap: 0, tokenCap: 1000 });
    logRequest('groq', 'llama', keyId, 'success', 850, 0, 5, null);
    const entries = alertEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toMatch(/85% of its monthly tokens cap \(850\/1000\)/);
  });

  it('stays silent for uncapped keys (the hot path pays one indexed read)', () => {
    logRequest('groq', 'llama', keyId, 'success', 1_000_000, 0, 5, null);
    expect(alertEntries()).toHaveLength(0);
  });

  it('noteBudgetAlerts never throws on a bogus key id', () => {
    expect(() => noteBudgetAlerts(999_999)).not.toThrow();
  });
});

describe('budget alert webhook', () => {
  const saved = process.env.BUDGET_ALERT_WEBHOOK_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.BUDGET_ALERT_WEBHOOK_URL;
    else process.env.BUDGET_ALERT_WEBHOOK_URL = saved;
  });

  it('accepts only http(s) URLs', () => {
    delete process.env.BUDGET_ALERT_WEBHOOK_URL;
    expect(budgetAlertWebhookUrl()).toBeNull();
    process.env.BUDGET_ALERT_WEBHOOK_URL = 'file:///etc/passwd';
    expect(budgetAlertWebhookUrl()).toBeNull();
    process.env.BUDGET_ALERT_WEBHOOK_URL = ' https://hooks.example.test/abc ';
    expect(budgetAlertWebhookUrl()).toBe('https://hooks.example.test/abc');
  });

  it('payload marks the hard threshold as blocked', () => {
    const payload = budgetWebhookPayload(3, 'prod', 'groq', [
      { threshold: 0.8, kind: 'requests', used: 80, cap: 100 },
      { threshold: 1.0, kind: 'tokens', used: 1000, cap: 1000 },
    ]);
    expect(payload.type).toBe('freellmapi.key_budget_threshold');
    expect(payload.thresholds).toEqual([
      { kind: 'requests', threshold: 0.8, used: 80, cap: 100, blocked: false },
      { kind: 'tokens', threshold: 1, used: 1000, cap: 1000, blocked: true },
    ]);
  });
});
