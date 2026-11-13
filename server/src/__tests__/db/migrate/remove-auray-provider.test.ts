import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up, down } from '../../../db/migrations/20261019_000001_remove_auray_provider.js';

// Auray started charging for API access and asked to be removed (#1583).

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

function aurayCounts(db: Database.Database) {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    keys: count("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'auray'"),
    models: count("SELECT COUNT(*) AS n FROM models WHERE platform = 'auray'"),
    embeddings: count("SELECT COUNT(*) AS n FROM embedding_models WHERE platform = 'auray'"),
    chain: count("SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'auray')"),
  };
}

describe('remove_auray_provider migration (#1583)', () => {
  it('removes Auray keys, models, embeddings and chain rows, keeps other providers, and DOWN restores them', async () => {
    const db = await migratedDb();
    // The state a Premium user upgrading from 0.16.3 has: an Auray key, its
    // catalog models in the chain, and the Auray embedding row.
    const keyId = Number(db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('auray', 'auray', 'enc', 'iv', 'tag', 'healthy', 1)
    `).run().lastInsertRowid);
    const modelId = Number(db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
      VALUES ('auray', 'kimi-k3', 'Kimi K3', 20, 7, 1, 'catalog')
    `).run().lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 999, 1)').run(modelId);
    db.prepare(`
      INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, enabled)
      VALUES ('qwen3-embedding-8b', 'auray', 'qwen3-embedding-8b', 'Qwen3 Embedding 8B', 4096, 1)
    `).run();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'groq', 'enc', 'iv', 'tag', 'healthy', 1)
    `).run();
    const otherModels = (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform != 'auray'").get() as { n: number }).n;

    up(db);
    expect(aurayCounts(db)).toEqual({ keys: 0, models: 0, embeddings: 0, chain: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get()).toEqual({ n: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform != 'auray'").get() as { n: number }).n).toBe(otherModels);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    down(db);
    expect(aurayCounts(db)).toEqual({ keys: 1, models: 1, embeddings: 1, chain: 1 });
    expect(db.prepare('SELECT id, status, enabled FROM api_keys WHERE platform = ?').get('auray'))
      .toEqual({ id: keyId, status: 'healthy', enabled: 1 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'migration_auray_removed_rows'").get()).toBeUndefined();
  });
});
