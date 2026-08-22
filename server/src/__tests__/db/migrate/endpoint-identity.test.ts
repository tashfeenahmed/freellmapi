import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import {
  up as endpointIdentityUp,
  down as endpointIdentityDown,
} from '../../../db/migrations/20260729_000001_custom_model_endpoint_identity.js';

// Per-endpoint model identity (#651): the migration has to change the shape of
// a table two other tables point INTO, on databases that are already carrying
// user data. These cases pin the two things that could quietly destroy an
// install: row ids drifting (which would silently re-point every fallback /
// profile / fusion reference at a different model) and the constraint change
// leaking into catalog platforms.

function addCustomKey(db: Database.Database, baseUrl: string, label: string): number {
  const r = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, 'enc', 'iv', 'tag', 'unknown', 1, ?)
  `).run(label, baseUrl);
  return Number(r.lastInsertRowid);
}

function addCustomModel(db: Database.Database, modelId: string, keyId: number): number {
  const r = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id)
    VALUES ('custom', ?, ?, 50, 50, 1, ?)
  `).run(modelId, modelId, keyId);
  return Number(r.lastInsertRowid);
}

/** A DB seeded the way an existing install looks: custom models + chain refs. */
async function seededLegacyDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  runLegacyBaseline(db);
  db.pragma('foreign_keys = ON');

  const keyA = addCustomKey(db, 'https://relay-a.example.com/v1', 'Relay A');
  const modelA = addCustomModel(db, 'deepseek-v3.1', keyA);
  const legacy = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
    VALUES ('custom', 'orphan-model', 'Orphan', 50, 50, 1)
  `).run();

  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 900, 1)').run(modelA);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 901, 1)')
    .run(Number(legacy.lastInsertRowid));

  const profile = db.prepare("INSERT INTO profiles (name) VALUES ('Seeded')").run();
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
    .run(Number(profile.lastInsertRowid), modelA);

  return db;
}

describe('custom model endpoint identity migration', () => {
  it('keeps row ids and chain references intact on an existing DB', async () => {
    const db = await seededLegacyDb();
    try {
      const customBefore = db.prepare(
        "SELECT id, platform, model_id, key_id FROM models WHERE platform = 'custom' ORDER BY id",
      ).all();
      const seededIds = (customBefore as { id: number }[]).map(r => r.id);
      const chainOf = () => db.prepare(
        `SELECT model_db_id, priority, enabled FROM fallback_config
          WHERE model_db_id IN (${seededIds.join(',')}) ORDER BY model_db_id`,
      ).all();
      const seededProfileId = (db.prepare("SELECT id FROM profiles WHERE name = 'Seeded'")
        .get() as { id: number }).id;
      const seededModelId = seededIds[0];
      const profileOf = () => db.prepare(
        'SELECT profile_id, model_db_id, priority, enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?',
      ).all(seededProfileId, seededModelId);
      const fallbackBefore = chainOf();
      const profileBefore = profileOf();
      const totalBefore = (db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n;
      const githubBefore = (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'github'").get() as { n: number }).n;

      await runMigrations(db, 'up');

      // Ids are the load-bearing part: fallback_config / profile_models / saved
      // fusion configs all address models BY id, so a rebuild that renumbered
      // would silently re-point them at unrelated models.
      expect(db.prepare(
        "SELECT id, platform, model_id, key_id FROM models WHERE platform = 'custom' ORDER BY id",
      ).all()).toEqual(customBefore);
      expect(chainOf()).toEqual(fallbackBefore);
      expect(profileOf()).toEqual(profileBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // Nothing was dropped on the way through except the rows the
      // retire_github_models migration intentionally removes (#877).
      expect((db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n)
        .toBeGreaterThanOrEqual(totalBefore - githubBefore);
    } finally {
      db.close();
    }
  });

  it('backfills the endpoint scope from each custom model\'s bound key', async () => {
    const db = await seededLegacyDb();
    try {
      await runMigrations(db, 'up');

      const scopes = db.prepare('SELECT model_id, endpoint_scope FROM models ORDER BY model_id')
        .all() as { model_id: string; endpoint_scope: string }[];
      const byId = new Map(scopes.map(s => [s.model_id, s.endpoint_scope]));

      expect(byId.get('deepseek-v3.1')).toBe('https://relay-a.example.com/v1');
      // No bound key → no scope, so a legacy row keeps the identity it had.
      expect(byId.get('orphan-model')).toBe('');
      // Catalog rows are never endpoint-scoped.
      const catalogScoped = db.prepare(
        "SELECT COUNT(*) AS n FROM models WHERE platform != 'custom' AND endpoint_scope <> ''",
      ).get() as { n: number };
      expect(catalogScoped.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('lets two endpoints hold the same model id, but still rejects catalog duplicates', async () => {
    const db = await seededLegacyDb();
    try {
      await runMigrations(db, 'up');

      const keyB = addCustomKey(db, 'https://relay-b.example.com/v1', 'Relay B');
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id, source, endpoint_scope)
        VALUES ('custom', 'deepseek-v3.1', 'deepseek-v3.1', 50, 50, 1, ?, 'user', 'https://relay-b.example.com/v1')
      `).run(keyB);

      const rows = db.prepare("SELECT endpoint_scope FROM models WHERE model_id = 'deepseek-v3.1' ORDER BY id")
        .all() as { endpoint_scope: string }[];
      expect(rows.map(r => r.endpoint_scope)).toEqual([
        'https://relay-a.example.com/v1',
        'https://relay-b.example.com/v1',
      ]);

      // Same endpoint, same model id → still one row.
      expect(() => db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source, endpoint_scope)
        VALUES ('custom', 'deepseek-v3.1', 'dupe', 50, 50, 1, 'user', 'https://relay-b.example.com/v1')
      `).run()).toThrow(/UNIQUE/i);

      // Catalog platforms keep exactly the old (platform, model_id) rule.
      const anyCatalog = db.prepare("SELECT platform, model_id FROM models WHERE platform != 'custom' LIMIT 1")
        .get() as { platform: string; model_id: string };
      expect(() => db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES (?, ?, 'dupe', 50, 50, 1)
      `).run(anyCatalog.platform, anyCatalog.model_id)).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('keeps the AUTOINCREMENT high-water mark so deleted ids are never reused', async () => {
    const db = await seededLegacyDb();
    try {
      await runMigrations(db, 'up');

      // Catalog sync prunes models routinely, so the highest ids are often gone
      // while the counter still remembers them. A rebuild that lets the counter
      // fall back to MAX(id) would re-issue those ids, and a stale
      // fallback_config / profile_models row would silently adopt a new model.
      const top = (db.prepare('SELECT MAX(id) AS m FROM models').get() as { m: number }).m;
      db.prepare('DELETE FROM profile_models WHERE model_db_id > ?').run(top - 3);
      db.prepare('DELETE FROM fallback_config WHERE model_db_id > ?').run(top - 3);
      db.prepare('DELETE FROM models WHERE id > ?').run(top - 3);
      const seqBefore = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'models'")
        .get() as { seq: number }).seq;
      expect(seqBefore).toBeGreaterThan(
        (db.prepare('SELECT MAX(id) AS m FROM models').get() as { m: number }).m,
      );

      // Exercise the rebuild itself, with no other migration able to nudge the
      // counter back up.
      endpointIdentityDown(db);
      endpointIdentityUp(db);

      expect((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'models'")
        .get() as { seq: number }).seq).toBe(seqBefore);
      const inserted = db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('custom', 'fresh-model', 'Fresh', 50, 50, 1) RETURNING id
      `).get() as { id: number };
      expect(inserted.id).toBeGreaterThan(seqBefore - 1);
      expect(inserted.id).toBeGreaterThan(top);
    } finally {
      db.close();
    }
  });

  it('is idempotent across a down/up round trip and refuses to drop duplicates', async () => {
    const db = await seededLegacyDb();
    try {
      await runMigrations(db, 'up');
      const afterFirstUp = db.prepare('SELECT * FROM models ORDER BY id').all();
      const schemaAfterFirstUp = db.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'models'",
      ).get() as { sql: string };

      endpointIdentityDown(db);
      expect(db.prepare('PRAGMA table_info(models)').all()
        .some((c: any) => c.name === 'endpoint_scope')).toBe(false);

      endpointIdentityUp(db);
      expect(db.prepare('SELECT * FROM models ORDER BY id').all()).toEqual(afterFirstUp);
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'models'").get() as { sql: string }).sql)
        .toBe(schemaAfterFirstUp.sql);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      // With a real duplicate on the books, down() has no honest answer.
      const keyB = addCustomKey(db, 'https://relay-b.example.com/v1', 'Relay B');
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id, source, endpoint_scope)
        VALUES ('custom', 'deepseek-v3.1', 'deepseek-v3.1', 50, 50, 1, ?, 'user', 'https://relay-b.example.com/v1')
      `).run(keyB);
      expect(() => endpointIdentityDown(db)).toThrow(/more than one endpoint/);
    } finally {
      db.close();
    }
  });
});
