import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../../db/index.js';

/**
 * All migrations must be idempotent: running initDb twice on the same
 * physical database file should produce identical state.
 */
describe('Migration idempotency', () => {
  it('initDb on a fresh in-memory DB then re-run produces identical row counts', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // Use a single shared file so both inits hit the same DB.
    const tmpPath = `/tmp/freeapi-idempotency-${Date.now()}.db`;

    const db1 = initDb(tmpPath);
    const before = {
      models: (db1.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db1.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      enabledModels: (db1.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1').get() as { c: number }).c,
      disabledModels: (db1.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 0').get() as { c: number }).c,
      orphanFallbacks: (db1.prepare(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `).get() as { c: number }).c,
    };
    db1.close();

    // Re-init the same DB file — V1..V9 should all no-op idempotently.
    const db2 = initDb(tmpPath);
    const after = {
      models: (db2.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c,
      fallback: (db2.prepare('SELECT COUNT(*) AS c FROM fallback_config').get() as { c: number }).c,
      enabledModels: (db2.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 1').get() as { c: number }).c,
      disabledModels: (db2.prepare('SELECT COUNT(*) AS c FROM models WHERE enabled = 0').get() as { c: number }).c,
      orphanFallbacks: (db2.prepare(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `).get() as { c: number }).c,
    };
    db2.close();

    expect(after).toEqual(before);
    expect(after.orphanFallbacks).toBe(0);
  });

  it('every catalog row has exactly one fallback_config entry', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const rows = db.prepare(`
      SELECT m.id, COUNT(f.id) AS fb_count
        FROM models m
        LEFT JOIN fallback_config f ON m.id = f.model_db_id
       GROUP BY m.id
      HAVING COUNT(f.id) <> 1
    `).all() as { id: number; fb_count: number }[];

    expect(rows).toEqual([]);
  });

  it('UNIQUE(platform, model_id) constraint holds — no duplicate catalog rows', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dups = db.prepare(`
      SELECT platform, model_id, COUNT(*) AS c FROM models
       GROUP BY platform, model_id
      HAVING COUNT(*) > 1
    `).all();

    expect(dups).toEqual([]);
  });

  it('V12: dead OR :free rows are absent and the four new rows are present', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dead = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('inclusionai/ling-2.6-1t:free', 'tencent/hy3-preview:free')
    `).all();
    expect(dead).toEqual([]);

    // V21 pruned these three after live probing returned 404 "no endpoints found".
    const pruned = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'arcee-ai/trinity-large-thinking:free',
           'minimax/minimax-m2.5:free',
           'baidu/cobuddy:free'
         )
    `).all();
    expect(pruned).toEqual([]);

    const live = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'openrouter/owl-alpha',
           'nousresearch/hermes-3-llama-3.1-405b:free'
         )
       ORDER BY model_id
    `).all() as { model_id: string }[];
    expect(live.map(r => r.model_id)).toEqual([
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'openrouter/owl-alpha',
    ]);

    const widened = db.prepare(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3-coder:free')
       ORDER BY model_id
    `).all() as { model_id: string; context_window: number }[];
    expect(widened).toEqual([
      { model_id: 'nvidia/nemotron-3-super-120b-a12b:free', context_window: 1000000 },
      { model_id: 'qwen/qwen3-coder:free', context_window: 1048576 },
    ]);
  });

  it('V13: cross-provider catalog refresh applies cleanly', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Disables — row kept but enabled=0.
    const disabled = db.prepare(`
      SELECT platform, model_id, enabled FROM models
       WHERE (platform = 'google' AND model_id = 'gemini-3.1-pro-preview')
          OR (platform = 'ollama' AND model_id IN ('kimi-k2-thinking', 'mistral-large-3:675b', 'deepseek-v3.2'))
       ORDER BY platform, model_id
    `).all() as { platform: string; model_id: string; enabled: number }[];
    expect(disabled).toHaveLength(4);
    for (const row of disabled) expect(row.enabled).toBe(0);

    // Hard removals — row is gone entirely.
    const removed = db.prepare(`
      SELECT model_id FROM models
       WHERE (platform = 'sambanova' AND model_id = 'DeepSeek-V3.1-cb')
          OR (platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5')
    `).all();
    expect(removed).toEqual([]);

    // New rows present across providers (incl. new huggingface platform).
    const additions = db.prepare(`
      SELECT platform, model_id FROM models
       WHERE (platform, model_id) IN (VALUES
         ('groq',        'openai/gpt-oss-safeguard-20b'),
         ('cloudflare',  '@cf/nvidia/nemotron-3-120b-a12b'),
         ('cloudflare',  '@cf/google/gemma-4-26b-a4b-it'),
         ('google',      'gemini-3.5-flash'),
         ('nvidia',      'deepseek-ai/deepseek-v4-flash'),
         ('nvidia',      'z-ai/glm-5.1'),
         ('nvidia',      'qwen/qwen3-coder-480b-a35b-instruct'),
         ('mistral',     'mistral-small-latest'),
         ('mistral',     'ministral-8b-latest'),
         ('cohere',      'command-a-reasoning-08-2025'),
         ('cohere',      'command-r-08-2024'),
         ('ollama',      'qwen3-coder-next'),
         ('huggingface', 'deepseek-ai/DeepSeek-V4-Flash'),
         ('huggingface', 'moonshotai/Kimi-K2.6'),
         ('huggingface', 'Qwen/Qwen3-Coder-Next')
       )
    `).all();
    expect(additions).toHaveLength(15);

    // Spot-check critical limit/context updates.
    const cerebrasLimits = db.prepare(`
      SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM models
       WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'
    `).get() as { rpm_limit: number; rpd_limit: number; tpm_limit: number; tpd_limit: number };
    expect(cerebrasLimits).toEqual({ rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000 });

    const cfFp8Ctx = (db.prepare(`
      SELECT context_window FROM models WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    `).get() as { context_window: number }).context_window;
    expect(cfFp8Ctx).toBe(24000);

    const mistralCtx = db.prepare(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'mistral'
         AND model_id IN ('codestral-latest', 'devstral-latest', 'magistral-medium-latest', 'mistral-large-latest')
       ORDER BY model_id
    `).all() as { model_id: string; context_window: number }[];
    expect(mistralCtx).toEqual([
      { model_id: 'codestral-latest',       context_window: 256000 },
      { model_id: 'devstral-latest',        context_window: 262144 },
      { model_id: 'magistral-medium-latest', context_window: 131072 },
      { model_id: 'mistral-large-latest',   context_window: 262144 },
    ]);
  });

  it('caps GitHub GPT-4.1 at the routable free-tier context window (#426)', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const row = db.prepare(`
      SELECT context_window FROM models
       WHERE platform = 'github' AND model_id = 'openai/gpt-4.1'
    `).get() as { context_window: number };

    expect(row.context_window).toBe(8000);
  });

  it('V14: cerebras deprecation disables qwen-3-235b and llama3.1-8b but keeps gpt-oss-120b enabled', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const rows = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'cerebras'
         AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b', 'gpt-oss-120b')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];

    expect(rows).toEqual([
      { model_id: 'gpt-oss-120b',                    enabled: 1 },
      { model_id: 'llama3.1-8b',                     enabled: 0 },
      { model_id: 'qwen-3-235b-a22b-instruct-2507',  enabled: 0 },
    ]);
  });

  it('V23: sambanova/chutes are gone; live-verified free additions are present with the right flags', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Platform drops — no model, fallback, or key rows survive.
    const deadRows = db.prepare(
      `SELECT COUNT(*) AS n FROM models WHERE platform IN ('sambanova', 'chutes')`
    ).get() as { n: number };
    expect(deadRows.n).toBe(0);
    const deadKeys = db.prepare(
      `SELECT COUNT(*) AS n FROM api_keys WHERE platform IN ('sambanova', 'chutes')`
    ).get() as { n: number };
    expect(deadKeys.n).toBe(0);

    // Additions, with the flags the live probe verified (vision/tools come
    // from the V16/V22 rules, so they must hold on a fresh seed too).
    const added = db.prepare(`
      SELECT platform, model_id, enabled, supports_vision, supports_tools FROM models
       WHERE (platform = 'openrouter' AND model_id IN (
               'moonshotai/kimi-k2.6:free',
               'nvidia/nemotron-3-ultra-550b-a55b:free',
               'nvidia/nemotron-nano-12b-v2-vl:free',
               'meta-llama/llama-3.2-3b-instruct:free',
               'cognitivecomputations/dolphin-mistral-24b-venice-edition:free'))
          OR (platform = 'zhipu' AND model_id = 'glm-4.6v-flash')
       ORDER BY platform, model_id
    `).all() as { model_id: string; enabled: number; supports_vision: number; supports_tools: number }[];
    expect(added.map(r => [r.model_id, r.enabled, r.supports_vision, r.supports_tools])).toEqual([
      ['cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 1, 0, 0],
      ['meta-llama/llama-3.2-3b-instruct:free',                         1, 0, 0],
      ['moonshotai/kimi-k2.6:free',                                     1, 0, 1],
      ['nvidia/nemotron-3-ultra-550b-a55b:free',                        0, 0, 1], // hangs 180s+; seeded disabled (tools verified via Zen in V24)
      ['nvidia/nemotron-nano-12b-v2-vl:free',                           1, 1, 1],
      ['glm-4.6v-flash',                                                1, 1, 1],
    ]);
  });

  it('V24: Zen roster refresh lands and the hung NIM gemma is paused', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const zen = db.prepare(`
      SELECT model_id, enabled, supports_tools FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-ultra-free', 'minimax-m3-free')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number; supports_tools: number }[];
    expect(zen.map(r => [r.model_id, r.enabled, r.supports_tools])).toEqual([
      // minimax-m3-free was seeded enabled here in V24, then retired in V25 when
      // its free promo ended (now enabled=0). nemotron-3-ultra-free is still live.
      ['minimax-m3-free',       0, 1],
      ['nemotron-3-ultra-free', 1, 1],
    ]);

    // The hung NIM gemma route is paused (row kept, enabled=0, re-asserted
    // each boot like the V13 disables).
    const gemma = db.prepare(`
      SELECT enabled FROM models WHERE platform = 'nvidia' AND model_id = 'google/gemma-4-31b-it'
    `).get() as { enabled: number };
    expect(gemma.enabled).toBe(0);
  });

  it('V25: dead OpenCode Zen free promos (nemotron-3-super-free, minimax-m3-free) are disabled', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const dead = db.prepare(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       ORDER BY model_id
    `).all() as { model_id: string; enabled: number }[];
    expect(dead.map(r => [r.model_id, r.enabled])).toEqual([
      ['minimax-m3-free',       0],
      ['nemotron-3-super-free', 0],
    ]);
  });

  it('all enabled catalog platforms have a registered provider', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');
    const { hasProvider } = await import('../../providers/index.js');

    const platforms = (db.prepare(
      `SELECT DISTINCT platform FROM models WHERE enabled = 1`
    ).all() as { platform: any }[]).map(r => r.platform);

    const missing = platforms.filter(p => !hasProvider(p));
    expect(missing).toEqual([]);
  });
});
