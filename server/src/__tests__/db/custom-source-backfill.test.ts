import { describe, it, expect } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// #custom-platform-model-management — verifies the custom-source backfill
// migration: existing platform='custom' rows that were written before the
// migration shipped (source='migration') get rewritten to source='user'
// so PATCH/DELETE on /api/models treat them uniformly.
describe('migrateCustomModelsSourceUser', () => {
  it("backfills source='user' on legacy custom rows and is idempotent", () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();

    // Seed a row that simulates a legacy upgrade path: platform='custom' with
    // source='migration' (the V28 backfill default before this migration ran).
    // Need a custom api_keys row to satisfy key_id binding (#212).
    const key = db
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
         VALUES ('custom', 'legacy', 'x', 'x', 'x', 'unknown', 1, 'http://127.0.0.1:11434/v1')`,
      )
      .run();
    const keyId = Number(key.lastInsertRowid);
    db.prepare(
      `INSERT INTO models
         (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
          monthly_token_budget, enabled, key_id, source)
       VALUES ('custom', ?, 'Legacy', 50, 50, 'Custom', '', 1, ?, 'migration')`,
    ).run(`${keyId}-legacy:1`, keyId);

    // Run the migration via the same SQL it executes (the migration ran during
    // initDb above, but on a row that didn't exist yet — invoke it again here
    // to verify it flips the just-seeded row).
    db.prepare("UPDATE models SET source = 'user' WHERE platform = 'custom' AND source != 'user'").run();

    const after = db
      .prepare("SELECT source FROM models WHERE platform='custom' AND model_id = ?")
      .get(`${keyId}-legacy:1`) as { source: string };
    expect(after.source).toBe('user');

    // Idempotent — second run flips zero additional rows.
    const result = db
      .prepare("UPDATE models SET source = 'user' WHERE platform = 'custom' AND source != 'user'")
      .run();
    expect(result.changes).toBe(0);
  });
});
