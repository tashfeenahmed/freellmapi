import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up, down } from '../../../db/migrations/20261017_000002_remove_github_provider.js';

// GitHub Models was retired upstream (#549); leftover keys looked healthy and
// custom GitHub models still joined the chain (#1557).

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

async function migratedDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  dbs.push(db);
  await runMigrations(db, 'up');
  return db;
}

function githubCounts(db: Database.Database) {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    keys: count("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'github'"),
    models: count("SELECT COUNT(*) AS n FROM models WHERE platform = 'github'"),
    chain: count("SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'github')"),
  };
}

describe('remove_github_provider migration (#1557)', () => {
  it('removes a leftover GitHub key and custom model, keeps other providers, and DOWN restores them', async () => {
    const db = await migratedDb();
    // The state a user upgrading from 0.15.0 has: a GitHub key and a custom
    // GitHub model in the fallback chain.
    const keyId = Number(db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('github', 'gh', 'enc', 'iv', 'tag', 'healthy', 1)
    `).run().lastInsertRowid);
    const modelId = Number(db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
      VALUES ('github', 'openai/gpt-4.1', 'GPT-4.1', 20, 7, 1, 'user')
    `).run().lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 999, 1)').run(modelId);
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'groq', 'enc', 'iv', 'tag', 'healthy', 1)
    `).run();
    const otherModels = (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform != 'github'").get() as { n: number }).n;

    up(db);
    expect(githubCounts(db)).toEqual({ keys: 0, models: 0, chain: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get()).toEqual({ n: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform != 'github'").get() as { n: number }).n).toBe(otherModels);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    down(db);
    expect(githubCounts(db)).toEqual({ keys: 1, models: 1, chain: 1 });
    expect(db.prepare('SELECT id, status, enabled FROM api_keys WHERE platform = ?').get('github'))
      .toEqual({ id: keyId, status: 'healthy', enabled: 1 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'migration_github_removed_rows'").get()).toBeUndefined();
  });
});
