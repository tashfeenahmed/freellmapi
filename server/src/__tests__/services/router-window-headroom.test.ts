import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getRoutingScores, refreshStatsCache, setHeadroomThresholds } from '../../services/router.js';
import { invalidateWindowUsage, modelWindowUsedFraction } from '../../services/ratelimit.js';

// #899: the headroom guardrail used to have an opinion only about models that
// declare a monthly_token_budget. A model capped by rpd/tpd was binary-gated —
// full score until the request that finally 429s it. These tests pin the graded
// behaviour: demotion as the window fills, no opinion while it is empty,
// automatic recovery when the window rolls, and operator-tunable thresholds.
describe('rate-window headroom guardrail (#899)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let busy: { id: number; modelId: string };
  let idle: { id: number; modelId: string };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();

    const rows = db.prepare(
      "SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 2"
    ).all() as { id: number; model_id: string }[];
    expect(rows.length).toBe(2);
    [busy, idle] = rows.map(r => ({ id: r.id, modelId: r.model_id }));

    // Two peers that differ ONLY in window utilization: same tier and rank so
    // the intelligence axis ties, no monthly budget so that guardrail stays out
    // of it, and the same daily request cap.
    for (const m of rows) {
      db.prepare(`
        UPDATE models
           SET monthly_token_budget = '', rpd_limit = 100, rpm_limit = NULL,
               tpm_limit = NULL, tpd_limit = NULL,
               size_label = 'medium', intelligence_rank = 10
         WHERE id = ?
      `).run(m.id);
    }
    // Every other model out of the chain, so the two peers are the whole
    // ranking and the intelligence normalization cannot reorder them.
    db.prepare("UPDATE models SET enabled = 0 WHERE id NOT IN (?, ?)").run(busy.id, idle.id);

    const { encrypted, iv, authTag } = encrypt('groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'k0', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    setHeadroomThresholds(null, null);
    invalidateWindowUsage();
  });

  function keyId(): number {
    return (getDb().prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;
  }

  /** n recorded requests for `modelId`, aged `ageMs` into the past. */
  function recordRequests(modelId: string, n: number, ageMs = 0) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('groq', ?, ?, 'request', 0, ?)
    `);
    const at = Date.now() - ageMs;
    for (let i = 0; i < n; i++) stmt.run(modelId, keyId(), at);
    invalidateWindowUsage();
  }

  function headroomOf(modelDbId: number): number {
    refreshStatsCache(getDb(), true);
    const { scores } = getRoutingScores();
    const row = scores.find(s => s.modelDbId === modelDbId);
    if (!row) throw new Error('model missing from routing scores');
    return row.headroom;
  }

  function scoreOf(modelDbId: number): number {
    refreshStatsCache(getDb(), true);
    const { scores } = getRoutingScores();
    const row = scores.find(s => s.modelDbId === modelDbId);
    if (!row) throw new Error('model missing from routing scores');
    return row.score;
  }

  it('leaves an untouched model alone (factor 1)', () => {
    expect(headroomOf(busy.id)).toBe(1);
    expect(headroomOf(idle.id)).toBe(1);
  });

  it('still has no opinion at low utilization, below the ramp', () => {
    recordRequests(busy.modelId, 50); // 50% of RPD — 50% left, ramp starts at 20%
    expect(headroomOf(busy.id)).toBe(1);
  });

  it('demotes a model at 95% of its RPD below an idle peer', () => {
    recordRequests(busy.modelId, 95);
    const busyHeadroom = headroomOf(busy.id);
    expect(busyHeadroom).toBeLessThan(1);
    // 5% remaining, ramp 20%, floor 0.1 → 0.1 + 0.9·(0.05/0.2) = 0.325
    expect(busyHeadroom).toBeCloseTo(0.325, 5);
    expect(headroomOf(idle.id)).toBe(1);
    expect(scoreOf(busy.id)).toBeLessThan(scoreOf(idle.id));

    // And the ranking actually flips — the busy model is no longer first.
    const { scores } = getRoutingScores();
    expect(scores[0].modelDbId).toBe(idle.id);
  });

  it('recovers on its own once the day window rolls past the usage', () => {
    recordRequests(busy.modelId, 95);
    expect(headroomOf(busy.id)).toBeLessThan(1);

    // Age the same rows out of the sliding day. Nothing resets a counter — the
    // window simply stops counting them.
    getDb().prepare(
      "UPDATE rate_limit_usage SET created_at_ms = ? WHERE model_id = ?"
    ).run(Date.now() - DAY_MS - 60_000, busy.modelId);
    invalidateWindowUsage();

    expect(headroomOf(busy.id)).toBe(1);
    expect(scoreOf(busy.id)).toBeCloseTo(scoreOf(idle.id), 10);
  });

  it('honours the tunable thresholds from the settings API', () => {
    recordRequests(busy.modelId, 60); // 40% left — outside the 20% default ramp
    expect(headroomOf(busy.id)).toBe(1);

    // Operator asks to start protecting at 50% remaining with a 0.3 floor.
    setHeadroomThresholds(0.5, 0.3);
    invalidateWindowUsage();
    // 0.3 + 0.7·(0.4/0.5) = 0.86
    expect(headroomOf(busy.id)).toBeCloseTo(0.86, 5);
    expect(headroomOf(idle.id)).toBe(1);
  });

  it('takes the busiest window across rpd and tpd', () => {
    const db = getDb();
    db.prepare("UPDATE models SET tpd_limit = 1000 WHERE id = ?").run(busy.id);
    recordRequests(busy.modelId, 10); // only 10% of RPD
    db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('groq', ?, ?, 'tokens', 900, ?)
    `).run(busy.modelId, keyId(), Date.now());
    invalidateWindowUsage();

    // 90% of TPD binds, not 10% of RPD.
    expect(headroomOf(busy.id)).toBeCloseTo(0.55, 5); // 0.1 + 0.9·(0.1/0.2)
    db.prepare("UPDATE models SET tpd_limit = NULL WHERE id = ?").run(busy.id);
  });

  it('follows the eligible key with the most headroom, not the worst one', () => {
    const db = getDb();
    const second = encrypt('groq-key-2');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'k1', ?, ?, ?, 'healthy', 1)
    `).run(second.encrypted, second.iv, second.authTag);
    const ids = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq' ORDER BY id").all() as { id: number }[]).map(r => r.id);

    const stmt = db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('groq', ?, ?, 'request', 0, ?)
    `);
    for (let i = 0; i < 99; i++) stmt.run(busy.modelId, ids[0], Date.now());
    invalidateWindowUsage();

    // One key is all but exhausted; the other is untouched, and the router will
    // land on it, so the model is not under any real pressure.
    expect(headroomOf(busy.id)).toBe(1);
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(ids[1]);
    invalidateWindowUsage();
  });

  it('has no opinion for a model that declares no window limits', () => {
    getDb().prepare("UPDATE models SET rpd_limit = NULL WHERE id = ?").run(busy.id);
    recordRequests(busy.modelId, 500);
    expect(modelWindowUsedFraction(
      { platform: 'groq', modelId: busy.modelId, keyId: null },
      { rpm: null, rpd: null, tpm: null, tpd: null },
    )).toBeNull();
    expect(headroomOf(busy.id)).toBe(1);
    getDb().prepare("UPDATE models SET rpd_limit = 100 WHERE id = ?").run(busy.id);
  });
});
