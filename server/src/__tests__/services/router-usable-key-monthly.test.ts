import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { hasOtherUsableKey, hasUsableKeyForModel, setRoutingStrategy } from '../../services/router.js';

// The "is this model servable right now" probes (hasOtherUsableKey /
// hasUsableKeyForModel) document that they apply the router's own gates —
// cooldown, provider daily cap, rpm/rpd/tpm/tpd. selectKeyForModel ALSO
// enforces the per-key monthly budget (#1158); the probes didn't, so a model
// whose only keys had spent their monthly caps was listed `ready` on
// /v1/models (#1100 semantics: the listing cannot claim a model the router
// would immediately skip) and a 429 on a capped sibling failed to demote the
// model, because the capped sibling counted as a "usable alternative".

function insertKey(overrides: { monthlyRequestCap?: number } = {}): number {
  const { encrypted, iv, authTag } = encrypt('sk-test');
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap)
    VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, overrides.monthlyRequestCap ?? 0);
  return Number(result.lastInsertRowid);
}

function spendMonthlyRequests(keyId: number, requests: number) {
  getDb().prepare(
    'INSERT INTO key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, ?, 10)',
  ).run(keyId, new Date().toISOString().slice(0, 7), requests);
}

function groqModelId(): number {
  const row = getDb().prepare(
    "SELECT id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY id LIMIT 1",
  ).get() as { id: number } | undefined;
  if (!row) throw new Error('seed catalog has no groq model');
  return row.id;
}

describe('Usable-key probes honor the monthly budget (#1158)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    setRoutingStrategy('priority');
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM key_monthly_usage').run();
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  });

  it('hasUsableKeyForModel is false when the only key spent its monthly cap', () => {
    const modelDbId = groqModelId();
    const key = insertKey({ monthlyRequestCap: 1 });
    spendMonthlyRequests(key, 1);
    expect(hasUsableKeyForModel(modelDbId)).toBe(false);
  });

  it('hasOtherUsableKey does not count a capped sibling as an alternative', () => {
    const modelDbId = groqModelId();
    const failing = insertKey();
    const capped = insertKey({ monthlyRequestCap: 1 });
    spendMonthlyRequests(capped, 1);
    expect(hasOtherUsableKey(modelDbId, failing)).toBe(false);
  });

  it('hasOtherUsableKey still counts an uncapped sibling (regression)', () => {
    const modelDbId = groqModelId();
    const failing = insertKey();
    insertKey();
    expect(hasOtherUsableKey(modelDbId, failing)).toBe(true);
  });
});
