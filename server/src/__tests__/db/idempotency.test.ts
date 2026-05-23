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

    const live = db.prepare(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'arcee-ai/trinity-large-thinking:free',
           'baidu/cobuddy:free',
           'openrouter/owl-alpha',
           'nousresearch/hermes-3-llama-3.1-405b:free'
         )
       ORDER BY model_id
    `).all() as { model_id: string }[];
    expect(live.map(r => r.model_id)).toEqual([
      'arcee-ai/trinity-large-thinking:free',
      'baidu/cobuddy:free',
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
