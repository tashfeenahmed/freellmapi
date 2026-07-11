import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getRoutingScores, refreshStatsCache } from '../../services/router.js';

// The monthly free-tier budget is PER KEY, and monthly usage is pooled across
// all keys — so the headroom guardrail must scale the budget by the usable key
// count or a multi-key model gets damped to the floor after one account's worth
// of tokens (#456).
describe('routing headroom scales the monthly budget by usable key count (#456)', () => {
  let modelDbId: number;
  let modelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    const m = db.prepare("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 1").get() as { id: number; model_id: string };
    modelDbId = m.id;
    modelId = m.model_id;
    // A known, parseable per-key budget so headroom math is deterministic.
    db.prepare("UPDATE models SET monthly_token_budget = '~1M' WHERE id = ?").run(modelDbId);
    // ~950k tokens used this month (pooled across keys): 95% of a single key's 1M.
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, created_at)
      VALUES (?, ?, NULL, 'success', 500000, 450000, 10, NULL, 'chat', datetime('now'))
    `).run('groq', modelId);
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  function headroomFor(): number {
    refreshStatsCache(getDb(), true); // force so the inserted usage is picked up
    const { scores } = getRoutingScores();
    const row = scores.find(s => s.modelDbId === modelDbId);
    if (!row) throw new Error('model missing from routing scores');
    return row.headroom;
  }

  function addGroqKeys(n: number) {
    const db = getDb();
    for (let i = 0; i < n; i++) {
      const { encrypted, iv, authTag } = encrypt(`groq-${i}`);
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('groq', ?, ?, ?, ?, 'healthy', 1)
      `).run(`k${i}`, encrypted, iv, authTag);
    }
  }

  it('damps a nearly-spent single-key model below full headroom', () => {
    addGroqKeys(1);
    expect(headroomFor()).toBeLessThan(1); // 950k / 1M → <20% left → protecting
  });

  it('restores full headroom once three usable keys pool 3x the budget', () => {
    addGroqKeys(3);
    // 950k / 3M → ~68% left → the guardrail stops protecting.
    expect(headroomFor()).toBe(1);
  });

  it('ignores disabled and unhealthy keys when scaling (same filter as the endpoints)', () => {
    addGroqKeys(1); // one healthy key
    const db = getDb();
    // An invalid and a disabled key add NO pooled capacity.
    const bad = encrypt('bad'); const off = encrypt('off');
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','bad',?,?,?,'invalid',1)").run(bad.encrypted, bad.iv, bad.authTag);
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','off',?,?,?,'healthy',0)").run(off.encrypted, off.iv, off.authTag);
    // Still effectively single-key → still damped.
    expect(headroomFor()).toBeLessThan(1);
  });
});
