import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  getAllPenalties,
  recordRateLimitHit,
  routeRequest,
  setRoutingStrategy,
} from '../../services/router.js';

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
    db.prepare('UPDATE models SET enabled = 1').run();
    db.prepare('UPDATE fallback_config SET enabled = 1').run();
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

  it('biases coding requests toward coding-capable models before generic ones', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const openRouterKey = encrypt('test-openrouter-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('openrouter', 'test', openRouterKey.encrypted, openRouterKey.iv, openRouterKey.authTag, 'healthy', 1);

    const flash = db.prepare(`
      SELECT id FROM models
       WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
       ORDER BY id ASC LIMIT 1
    `).get() as { id: number } | undefined;
    const qwenCoder = db.prepare(`
      SELECT id FROM models
       WHERE platform = 'openrouter'
         AND enabled = 1
         AND supports_tools = 1
         AND (
           LOWER(model_id) LIKE '%coder%'
           OR LOWER(display_name) LIKE '%coder%'
         )
       ORDER BY
         CASE WHEN LOWER(model_id) LIKE '%qwen3-coder%' THEN 0 ELSE 1 END,
       intelligence_rank ASC,
       id ASC
       LIMIT 1
    `).get() as { id: number } | undefined;

    expect(flash).toBeDefined();
    expect(qwenCoder).toBeDefined();

    db.prepare('UPDATE models SET enabled = 1 WHERE id IN (?, ?)').run(flash!.id, qwenCoder!.id);
    db.prepare('UPDATE fallback_config SET priority = 0, enabled = 1 WHERE model_db_id = ?').run(flash!.id);
    db.prepare('UPDATE fallback_config SET priority = 1, enabled = 1 WHERE model_db_id = ?').run(qwenCoder!.id);

    const plain = routeRequest(1000);
    expect(plain.modelDbId).toBe(flash!.id);

    const coding = routeRequest(1000, undefined, undefined, false, false, undefined, undefined, {
      kind: 'coding',
      coding: true,
      agentic: false,
      research: false,
      chat: false,
    });
    expect(coding.modelDbId).toBe(qwenCoder!.id);
  });

  it('biases research prompts toward deeper, larger-context models', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const cohereKey = encrypt('test-cohere-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('cohere', 'test', cohereKey.encrypted, cohereKey.iv, cohereKey.authTag, 'healthy', 1);

    const flash = db.prepare(`
      SELECT id FROM models
       WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
       LIMIT 1
    `).get() as { id: number } | undefined;
    const reasoning = db.prepare(`
      SELECT id FROM models
       WHERE platform = 'cohere'
         AND enabled = 1
         AND (
           size_label = 'Frontier'
           OR size_label = 'Large'
         )
         AND (
           LOWER(model_id) LIKE '%reasoning%'
           OR LOWER(model_id) LIKE '%deepseek%'
           OR LOWER(model_id) LIKE '%command-a%'
           OR LOWER(display_name) LIKE '%reasoning%'
         )
       ORDER BY intelligence_rank ASC, id ASC
       LIMIT 1
    `).get() as { id: number } | undefined;

    expect(flash).toBeDefined();
    expect(reasoning).toBeDefined();

    db.prepare('UPDATE models SET enabled = 1 WHERE id IN (?, ?)').run(flash!.id, reasoning!.id);
    db.prepare('UPDATE fallback_config SET priority = 0, enabled = 1 WHERE model_db_id = ?').run(flash!.id);
    db.prepare('UPDATE fallback_config SET priority = 1, enabled = 1 WHERE model_db_id = ?').run(reasoning!.id);

    const plain = routeRequest(1000);
    expect(plain.modelDbId).toBe(flash!.id);

    const research = routeRequest(1000, undefined, undefined, false, false, undefined, undefined, {
      kind: 'research',
      coding: false,
      agentic: false,
      research: true,
      chat: false,
    });
    expect(research.modelDbId).toBe(reasoning!.id);
  });

  it('biases conversational prompts toward fast chat models over coding specialists', () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);

    const openRouterKey = encrypt('test-openrouter-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('openrouter', 'test', openRouterKey.encrypted, openRouterKey.iv, openRouterKey.authTag, 'healthy', 1);

    const coder = db.prepare(`
      SELECT id FROM models
       WHERE enabled = 1
         AND supports_tools = 1
         AND (
           LOWER(model_id) LIKE '%coder%'
           OR LOWER(display_name) LIKE '%coder%'
         )
       ORDER BY
         CASE WHEN LOWER(model_id) LIKE '%qwen3-coder%' THEN 0 ELSE 1 END,
         intelligence_rank ASC,
         id ASC
       LIMIT 1
    `).get() as { id: number } | undefined;
    const flash = db.prepare(`
      SELECT id FROM models
       WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
       LIMIT 1
    `).get() as { id: number } | undefined;

    expect(coder).toBeDefined();
    expect(flash).toBeDefined();

    db.prepare('UPDATE models SET enabled = 1 WHERE id IN (?, ?)').run(coder!.id, flash!.id);
    db.prepare('UPDATE fallback_config SET priority = 0, enabled = 1 WHERE model_db_id = ?').run(coder!.id);
    db.prepare('UPDATE fallback_config SET priority = 1, enabled = 1 WHERE model_db_id = ?').run(flash!.id);

    const plain = routeRequest(1000);
    expect(plain.modelDbId).toBe(coder!.id);

    const chat = routeRequest(1000, undefined, undefined, false, false, undefined, undefined, {
      kind: 'chat',
      coding: false,
      agentic: false,
      research: false,
      chat: true,
    });
    expect(chat.modelDbId).toBe(flash!.id);
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
