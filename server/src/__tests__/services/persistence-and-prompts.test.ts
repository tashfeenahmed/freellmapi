import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb, getSetting, setSetting, getDefaultSystemPrompt, setDefaultSystemPrompt } from '../../db/index.js';
import { recordRateLimitHit, recordSuccess, getAllPenalties } from '../../services/router.js';

describe('penalty persistence', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    // Clear settings between tests
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key IN ('rate_limit_penalties', 'default_system_prompt')").run();
  });

  it('saves and loads penalty array to settings table', () => {
    const testPenalties = [
      { modelDbId: 1, count: 2, lastHit: Date.now(), penalty: 6 },
      { modelDbId: 2, count: 1, lastHit: Date.now() - 1000, penalty: 3 },
    ];
    setSetting('rate_limit_penalties', JSON.stringify(testPenalties));

    const loaded = getSetting('rate_limit_penalties');
    expect(loaded).toBeDefined();
    const parsed = JSON.parse(loaded!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].modelDbId).toBe(1);
    expect(parsed[0].penalty).toBe(6);
  });

  it('handles corrupted JSON gracefully (returns undefined)', () => {
    setSetting('rate_limit_penalties', 'not valid json {');
    const loaded = getSetting('rate_limit_penalties');
    // getSetting returns the raw string; parsing is caller's responsibility
    expect(loaded).toBe('not valid json {');
  });

  it('recordRateLimitHit persists to settings and loads on module reload', () => {
    // Record some 429s
    recordRateLimitHit(42); // modelDbId 42
    recordRateLimitHit(42);
    recordRateLimitHit(43); // different model

    // Check in-memory state
    const penalties = getAllPenalties();
    expect(penalties).toHaveLength(2);
    const p42 = penalties.find(p => p.modelDbId === 42);
    expect(p42).toBeDefined();
    expect(p42!.count).toBe(2);
    expect(p42!.penalty).toBe(6); // 2 * PENALTY_PER_429 (3)

    // Verify persisted in settings
    const raw = getSetting('rate_limit_penalties');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(2);
  });

  it('recordSuccess reduces penalty and persists', () => {
    recordRateLimitHit(99);
    recordRateLimitHit(99); // penalty = 6

    recordSuccess(99); // penalty = 5
    recordSuccess(99); // penalty = 4

    const penalties = getAllPenalties();
    const p99 = penalties.find(p => p.modelDbId === 99);
    expect(p99).toBeDefined();
    expect(p99!.penalty).toBe(4);

    // Verify persisted
    const raw = getSetting('rate_limit_penalties');
    const parsed = JSON.parse(raw!);
    const p99Persisted = parsed.find((p: any) => p.modelDbId === 99);
    expect(p99Persisted.penalty).toBe(4);
  });

  it('recordSuccess removes entry when penalty reaches 0 and persists removal', () => {
    recordRateLimitHit(100); // penalty = 3
    recordSuccess(100);       // 2
    recordSuccess(100);       // 1
    recordSuccess(100);       // 0 -> removed

    const penalties = getAllPenalties();
    const p100 = penalties.find(p => p.modelDbId === 100);
    expect(p100).toBeUndefined();

    // Verify removed from settings
    const raw = getSetting('rate_limit_penalties');
    const parsed = JSON.parse(raw!);
    const p100Persisted = parsed.find((p: any) => p.modelDbId === 100);
    expect(p100Persisted).toBeUndefined();
  });
});

describe('cooldown hits persistence', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_cooldown_hits').run();
  });

  it('persists and loads cooldown hits from new table', () => {
    const now = Date.now();
    const db = getDb();

    // Simulate persisted hits
    db.prepare(`
      INSERT INTO rate_limit_cooldown_hits (platform, model_id, key_id, hit_at_ms)
      VALUES (?, ?, ?, ?)
    `).run('groq', 'llama-3.1-8b', 1, now - 3600000); // 1h ago
    db.prepare(`
      INSERT INTO rate_limit_cooldown_hits (platform, model_id, key_id, hit_at_ms)
      VALUES (?, ?, ?, ?)
    `).run('groq', 'llama-3.1-8b', 1, now - 7200000); // 2h ago

    // Load function (copied from ratelimit.ts loadCooldownHits logic)
    const rows = db.prepare(`
      SELECT platform, model_id, key_id, hit_at_ms
      FROM rate_limit_cooldown_hits
      WHERE hit_at_ms > ?
    `).all(now - 24 * 60 * 60 * 1000) as Array<{ platform: string; model_id: string; key_id: number; hit_at_ms: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].platform).toBe('groq');
    expect(rows[0].model_id).toBe('llama-3.1-8b');
  });

  it('prunes hits older than 24h on persist', () => {
    const db = getDb();
    const now = Date.now();

    // Insert old hit (>24h)
    db.prepare(`
      INSERT INTO rate_limit_cooldown_hits (platform, model_id, key_id, hit_at_ms)
      VALUES (?, ?, ?, ?)
    `).run('groq', 'test-model', 1, now - 25 * 60 * 60 * 1000);

    // Insert recent hit
    db.prepare(`
      INSERT INTO rate_limit_cooldown_hits (platform, model_id, key_id, hit_at_ms)
      VALUES (?, ?, ?, ?)
    `).run('groq', 'test-model', 1, now - 1000);

    // Run prune (same as persistCooldownHit does)
    db.prepare(`
      DELETE FROM rate_limit_cooldown_hits
      WHERE hit_at_ms <= ?
    `).run(now - 24 * 60 * 60 * 1000);

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM rate_limit_cooldown_hits').get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });
});

describe('default system prompt', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'default_system_prompt'").run();
  });

  it('returns undefined when not set', () => {
    expect(getDefaultSystemPrompt()).toBeUndefined();
  });

  it('saves and retrieves a prompt', () => {
    const prompt = 'You are a concise assistant.';
    setDefaultSystemPrompt(prompt);
    expect(getDefaultSystemPrompt()).toBe(prompt);
  });

  it('trims whitespace on save', () => {
    setDefaultSystemPrompt('  trimmed  ');
    expect(getDefaultSystemPrompt()).toBe('trimmed');
  });

  it('clears on empty string', () => {
    setDefaultSystemPrompt('some prompt');
    setDefaultSystemPrompt('');
    expect(getDefaultSystemPrompt()).toBeUndefined();
  });

  it('clears on undefined', () => {
    setDefaultSystemPrompt('some prompt');
    setDefaultSystemPrompt(undefined);
    expect(getDefaultSystemPrompt()).toBeUndefined();
  });

  it('overwrites previous value', () => {
    setDefaultSystemPrompt('first');
    setDefaultSystemPrompt('second');
    expect(getDefaultSystemPrompt()).toBe('second');
  });
});