import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';
import { up as legacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';

// #1603: a DB whose models rows were written by an older code path (a
// pre-migrator install, a restore, or a catalog-sync that already carried the
// new id) used to crash the legacy baseline with
//   UNIQUE constraint failed: models.platform, models.model_id
// because its model renames were bare UPDATEs into a (platform, model_id)
// that already existed.

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function freshLegacyDb(): Database.Database {
  // A DB at the baseline's pre-#651 shape: UNIQUE(platform, model_id), no
  // endpoint_scope, no migrations bookkeeping — what a pre-migrator install
  // hands to the current binary.
  const db = new Database(':memory:');
  dbs.push(db);
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      key_id INTEGER,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      paid_input_per_m REAL,
      paid_output_per_m REAL,
      source TEXT NOT NULL DEFAULT 'catalog',
      UNIQUE(platform, model_id)
    );
  `);
  return db;
}

function seedModel(db: Database.Database, platform: string, modelId: string) {
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
    VALUES (?, ?, ?, 10, 10)
  `).run(platform, modelId, modelId);
}

describe('legacy baseline re-run against a post-rename DB (#1603)', () => {
  it('survives a re-run when the rename target already exists (cerebras qwen3-235b)', () => {
    const db = freshLegacyDb();
    // The state that crashed: the newer id already present (catalog-sync or a
    // previous partial run carried it) AND the old id still around.
    seedModel(db, 'cerebras', 'qwen3-235b');
    seedModel(db, 'cerebras', 'qwen-3-235b-a22b-instruct-2507');

    expect(() => legacyBaseline(db)).not.toThrow();

    // Merge rule: the fresh row wins, the stale old id is gone.
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE model_id = 'qwen3-235b'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE model_id = 'qwen-3-235b-a22b-instruct-2507'").get()).toEqual({ n: 1 });
  });

  it('still renames when the target does NOT exist (old behaviour preserved)', () => {
    const db = freshLegacyDb();
    seedModel(db, 'cerebras', 'qwen3-235b');

    expect(() => legacyBaseline(db)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE model_id = 'qwen3-235b'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE model_id = 'qwen-3-235b-a22b-instruct-2507'").get()).toEqual({ n: 1 });
  });

  it('the whole migration runner completes on a legacy DB carrying post-rename rows', async () => {
    // End-to-end shape of #1603: an existing DB (models already at the current
    // ids) without a `migrations` table — the runner replays the baseline and
    // must not die.
    const base = new Database(':memory:');
    await runMigrations(base, 'up');
    const rows = base.prepare('SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, context_window FROM models').all();
    base.close();

    const db = new Database(':memory:');
    dbs.push(db);
    db.exec(`
      CREATE TABLE models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL,
        intelligence_rank INTEGER NOT NULL, speed_rank INTEGER NOT NULL,
        size_label TEXT NOT NULL DEFAULT '',
        rpm_limit INTEGER, rpd_limit INTEGER, tpm_limit INTEGER, tpd_limit INTEGER,
        monthly_token_budget TEXT NOT NULL DEFAULT '', context_window INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1, supports_vision INTEGER NOT NULL DEFAULT 0,
        key_id INTEGER, supports_tools INTEGER NOT NULL DEFAULT 0,
        paid_input_per_m REAL, paid_output_per_m REAL, source TEXT NOT NULL DEFAULT 'catalog',
        UNIQUE(platform, model_id)
      );
    `);
    const insert = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                          size_label, monthly_token_budget, context_window)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Re-insert only the post-rename rows (a DB that already ran the old
    // baseline once, then lost its migrations bookkeeping).
    for (const m of rows as Record<string, unknown>[]) {
      insert.run(m.platform, m.model_id, m.display_name, m.intelligence_rank, m.speed_rank,
        m.size_label, m.monthly_token_budget, m.context_window);
    }

    await expect(runMigrations(db, 'up')).resolves.toBeUndefined();
    // No model id appears twice, and the runner recorded the journal.
    expect(db.prepare('SELECT COUNT(*) AS n FROM migrations').get()).toEqual({ n: DEFAULT_MIGRATIONS.length });
    expect(db.prepare('SELECT COUNT(*) AS n FROM (SELECT platform, model_id FROM models GROUP BY platform, model_id HAVING COUNT(*) > 1)').get()).toEqual({ n: 0 });
  });
});
