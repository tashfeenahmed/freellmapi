import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';

const tempDirs: string[] = [];
const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migration runner', () => {
  it('runs pending migrations up and records applied files', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_create_widgets.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY)');
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE IF EXISTS widgets');
      }
    `);
    writeMigration(migrationsDir, '20260608_000002_create_gadgets.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE IF NOT EXISTS gadgets (id INTEGER PRIMARY KEY)');
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE IF EXISTS gadgets');
      }
    `);

    const db = new Database(':memory:');
    try {
      await runMigrations(db, 'up', { migrationsDir });

      const applied = db.prepare('SELECT filename FROM migrations ORDER BY filename ASC').all() as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual([
        '20260608_000001_create_widgets.ts',
        '20260608_000002_create_gadgets.ts',
      ]);
      expect(hasTable(db, 'widgets')).toBe(true);
      expect(hasTable(db, 'gadgets')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('runs one down migration and removes its migrations row', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_create_widgets.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY)');
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE IF EXISTS widgets');
      }
    `);
    writeMigration(migrationsDir, '20260608_000002_create_gadgets.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE IF NOT EXISTS gadgets (id INTEGER PRIMARY KEY)');
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE IF EXISTS gadgets');
      }
    `);

    const db = new Database(':memory:');
    try {
      await runMigrations(db, 'up', { migrationsDir });
      await runMigrations(db, 'down', { migrationsDir });

      const applied = db.prepare('SELECT filename FROM migrations ORDER BY filename ASC').all() as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual(['20260608_000001_create_widgets.ts']);
      expect(hasTable(db, 'widgets')).toBe(true);
      expect(hasTable(db, 'gadgets')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('skips already-applied migrations on later up runs', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_insert_counter.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE IF NOT EXISTS run_counter (value INTEGER NOT NULL)');
        db.prepare('INSERT INTO run_counter (value) VALUES (1)').run();
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE IF EXISTS run_counter');
      }
    `);

    const db = new Database(':memory:');
    try {
      await runMigrations(db, 'up', { migrationsDir });
      await runMigrations(db, 'up', { migrationsDir });

      const runs = db.prepare('SELECT COUNT(*) AS count FROM run_counter').get() as { count: number };
      const applied = db.prepare('SELECT COUNT(*) AS count FROM migrations').get() as { count: number };
      expect(runs.count).toBe(1);
      expect(applied.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rolls back a failing up migration and does not record it', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_fails.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE failed_table (id INTEGER PRIMARY KEY)');
        throw new Error('boom');
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE IF EXISTS failed_table');
      }
    `);

    const db = new Database(':memory:');
    try {
      await expect(runMigrations(db, 'up', { migrationsDir })).rejects.toThrow('boom');

      const applied = db.prepare('SELECT COUNT(*) AS count FROM migrations').get() as { count: number };
      expect(applied.count).toBe(0);
      expect(hasTable(db, 'failed_table')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('runs the legacy baseline even when the legacy sentinel schema exists', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, LEGACY_BASELINE_FILENAME, `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE IF NOT EXISTS baseline_ran (id INTEGER PRIMARY KEY)');
      }

      export function down(_db: Database.Database): void {
        throw new Error('baseline is irreversible');
      }
    `);
    writeMigration(migrationsDir, '20260608_000001_after_baseline.ts', `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE IF NOT EXISTS after_baseline (id INTEGER PRIMARY KEY)');
      }

      export function down(db: Database.Database): void {
        db.exec('DROP TABLE IF EXISTS after_baseline');
      }
    `);

    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE models (
          id INTEGER PRIMARY KEY,
          supports_tools INTEGER NOT NULL DEFAULT 0
        );
      `);

      await runMigrations(db, 'up', { migrationsDir });

      const applied = db.prepare('SELECT filename FROM migrations ORDER BY id ASC').all() as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual([
        LEGACY_BASELINE_FILENAME,
        '20260608_000001_after_baseline.ts',
      ]);
      expect(hasTable(db, 'baseline_ran')).toBe(true);
      expect(hasTable(db, 'after_baseline')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('runs the legacy baseline normally for fresh DBs', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, LEGACY_BASELINE_FILENAME, `
      import type Database from 'better-sqlite3';

      export function up(db: Database.Database): void {
        db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, supports_tools INTEGER NOT NULL DEFAULT 0)');
      }

      export function down(_db: Database.Database): void {
        throw new Error('baseline is irreversible');
      }
    `);

    const db = new Database(':memory:');
    try {
      await runMigrations(db, 'up', { migrationsDir });

      const applied = db.prepare('SELECT filename FROM migrations ORDER BY id ASC').all() as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual([LEGACY_BASELINE_FILENAME]);
      expect(hasTable(db, 'models')).toBe(true);
      expect(hasColumn(db, 'models', 'supports_tools')).toBe(true);
    } finally {
      db.close();
    }
  });
});

function createMigrationsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-migrations-'));
  tempDirs.push(dir);
  return dir;
}

function writeMigration(migrationsDir: string, filename: string, source: string): void {
  fs.writeFileSync(path.join(migrationsDir, filename), source.trimStart());
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

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as { name: string }[];
  return columns.some(column => column.name === columnName);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
