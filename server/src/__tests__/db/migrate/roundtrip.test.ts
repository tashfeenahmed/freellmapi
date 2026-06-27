import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { connectDb } from '../../../db/index.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';

const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface DatabaseSnapshot {
  schema: SchemaRow[];
  rows: Record<string, unknown[]>;
}

describe('migration round trip', () => {
  it('connectDb opens a connection without applying migrations', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const db = connectDb(':memory:');

    try {
      expect(hasTable(db, 'models')).toBe(false);
      expect(hasTable(db, 'migrations')).toBe(false);
    } finally {
      db.close();
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('runs the legacy baseline against existing legacy DBs so rebased legacy changes apply', async () => {
    const db = new Database(':memory:');

    try {
      runLegacyBaseline(db);
      db.prepare(`
        UPDATE models
           SET enabled = 1
         WHERE platform = 'opencode'
           AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
      `).run();

      expect(getEnabledZenDeadPromoCount(db)).toBe(2);

      await runMigrations(db, 'up');

      expect(getEnabledZenDeadPromoCount(db)).toBe(0);
      expect(getAppliedMigrationNames(db)).toEqual([
        LEGACY_BASELINE_FILENAME,
        CUSTOM_PROVIDER_MODALITIES_FILENAME,
      ]);
    } finally {
      db.close();
    }
  });

  it('runs all migrations up, down to baseline, then up to the same schema', async () => {
    const db = new Database(':memory:');

    try {
      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);

      const fullState = snapshotAppState(db);
      await runDownToBaseline(db);

      expect(getAppliedMigrationNames(db)).toEqual([LEGACY_BASELINE_FILENAME]);

      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);
      expect(snapshotAppState(db)).toEqual(fullState);
    } finally {
      db.close();
    }
  });
});

async function runDownToBaseline(db: Database.Database): Promise<void> {
  while (getAppliedMigrationNames(db).length > 1) {
    const migrationName = getLatestAppliedMigrationName(db);
    const before = snapshotAppState(db);

    await runMigrations(db, 'down');

    expect(snapshotAppState(db), `${migrationName} down() must alter app DB state or throw irreversible`)
      .not.toEqual(before);
  }
}

function getLatestAppliedMigrationName(db: Database.Database): string {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) throw new Error('No applied migrations found');
  return row.filename;
}

function getAppliedMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'applied')
    .map(status => status.filename);
}

function getPendingMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'pending')
    .map(status => status.filename);
}

function getEnabledZenDeadPromoCount(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM models
     WHERE platform = 'opencode'
       AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       AND enabled = 1
  `).get() as { count: number };

  return row.count;
}

function snapshotSchema(db: Database.Database): SchemaRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE type IN ('index', 'table', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all() as SchemaRow[];
}

function snapshotAppState(db: Database.Database): DatabaseSnapshot {
  const tableNames = getAppTableNames(db);
  const rows: Record<string, unknown[]> = {};

  for (const tableName of tableNames) {
    rows[tableName] = snapshotTableRows(db, tableName);
  }

  return {
    schema: snapshotSchema(db),
    rows,
  };
}

function getAppTableNames(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name <> 'migrations'
     ORDER BY name
  `).all() as { name: string }[];

  return rows.map(row => row.name);
}

function snapshotTableRows(db: Database.Database, tableName: string): unknown[] {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as { name: string }[];
  const orderBy = columns.map(column => quoteIdentifier(column.name)).join(', ');

  return db.prepare(`
    SELECT *
      FROM ${quoteIdentifier(tableName)}
     ORDER BY ${orderBy}
  `).all() as unknown[];
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(tableName);

  return Boolean(row);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
