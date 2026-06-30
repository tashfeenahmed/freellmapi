import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  getAllPenalties,
  recordRateLimitHit,
  routeRequest,
  setRoutingStrategy,
} from '../../services/router.js';
import { setCooldown } from '../../services/ratelimit.js';

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    // These cases assert the manual priority order specifically; pin it so the
    // bandit (now the default strategy) doesn't reorder by score.
    setRoutingStrategy('priority');
    db.prepare('DELETE FROM api_keys').run();
    // Disable active profile so the router falls back to fallback_config
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    // Reset fallback order to intelligence ranking
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('skips a model whose context window cannot hold the request (#167)', () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Remove token rate-limit interference so we isolate the context-window
    // behavior (canUseTokens would otherwise also skip on a large estimate).
    db.prepare("UPDATE models SET tpm_limit = NULL, tpd_limit = NULL WHERE platform = 'groq'").run();

    // Whatever model a small request lands on, give it a tiny context window.
    const baseline = routeRequest(5);
    db.prepare('UPDATE models SET context_window = 10 WHERE id = ?').run(baseline.modelDbId);

    // A small request still lands on it (5 < 10) ...
    expect(routeRequest(5).modelDbId).toBe(baseline.modelDbId);

    // ... but a request larger than its window is routed elsewhere (2000 > 10).
    const large = routeRequest(2000);
    expect(large.modelDbId).not.toBe(baseline.modelDbId);
  });

  it('skips GitHub GPT-4.1 above its free-tier 8K request cap (#426)', () => {
    const db = getDb();
    const githubKey = encrypt('test-github-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('github', 'github', githubKey.encrypted, githubKey.iv, githubKey.authTag, 'healthy', 1);
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'groq', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const github = db.prepare(`
      SELECT id, context_window FROM models
       WHERE platform = 'github' AND model_id = 'openai/gpt-4.1'
    `).get() as { id: number; context_window: number };
    const groq = db.prepare(`
      SELECT id FROM models
       WHERE platform = 'groq' AND context_window > 9000
       LIMIT 1
    `).get() as { id: number };

    db.prepare('UPDATE fallback_config SET priority = 1000, enabled = 1').run();
    db.prepare('UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?').run(github.id);
    db.prepare('UPDATE fallback_config SET priority = 2 WHERE model_db_id = ?').run(groq.id);
    db.prepare(`
      UPDATE models SET tpm_limit = NULL, tpd_limit = NULL
       WHERE id IN (?, ?)
    `).run(github.id, groq.id);

    expect(github.context_window).toBe(8000);
    expect(routeRequest(7000).modelDbId).toBe(github.id);
    expect(routeRequest(9000).modelDbId).toBe(groq.id);
  });

  it('still routes a model with an unknown (null) context window (#167)', () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);
    db.prepare("UPDATE models SET tpm_limit = NULL, tpd_limit = NULL WHERE platform = 'groq'").run();
    // A null context_window means "unknown" — never filtered out, even for a huge request.
    db.prepare("UPDATE models SET context_window = NULL WHERE platform = 'groq'").run();
    expect(() => routeRequest(500000)).not.toThrow();
  });

  it('should skip keys that cannot be decrypted and use a valid fallback key', () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'corrupt', 'not-hex', 'not-hex', 'not-hex', 'healthy', 1);

    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    const result = routeRequest();
    const corruptKey = db.prepare("SELECT status FROM api_keys WHERE label = 'corrupt'").get() as { status: string };

    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
    expect(corruptKey.status).toBe('error');
  });

  it('applies elapsed decay before adding a new 429 penalty', () => {
    vi.useFakeTimers();
    const modelDbId = 987654321;

    recordRateLimitHit(modelDbId);
    vi.advanceTimersByTime(10 * 60 * 1000);
    recordRateLimitHit(modelDbId);

    expect(getAllPenalties()).toContainEqual({
      modelDbId,
      count: 2,
      penalty: 3,
    });
  });
});

describe('Router exhaustion diagnostics (issue _1)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    setRoutingStrategy('priority');
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches a non-empty per-model disposition to the exhaustion error', () => {
    // No keys configured → every chain model is unroutable. The thrown error
    // must carry diagnostics so the synchronous routing_error is debuggable
    // instead of opaque (the failure that NOTHING else logs).
    let caught: any;
    try { routeRequest(); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(Array.isArray(caught.diagnostics)).toBe(true);
    expect(caught.diagnostics.length).toBeGreaterThan(0);
    // Every entry is "<platform>/<model>: <reason>"; with no keys the reason is
    // the platform having no enabled+healthy key.
    expect(caught.diagnostics.every((d: string) => d.includes(': '))).toBe(true);
    expect(caught.diagnostics.some((d: string) => /no enabled.*key/i.test(d))).toBe(true);
  });

  it('records cooldown as the skip reason for a benched key', () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);

    // Bench every groq model on this key, so the only configured provider is
    // fully cooled down and the pool empties with a key present (not absent).
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform='groq'").get() as { id: number }).id;
    const groqModels = db.prepare("SELECT model_id FROM models WHERE platform='groq' AND enabled=1").all() as { model_id: string }[];
    for (const m of groqModels) setCooldown('groq', m.model_id, keyId, 5 * 60 * 1000);

    let caught: any;
    try { routeRequest(); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.diagnostics.some((d: string) => /cooldown/.test(d))).toBe(true);
  });
});
