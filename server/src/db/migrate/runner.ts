import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type Database from 'better-sqlite3';
import { DEFAULT_MIGRATIONS, type MigrationModule } from './defaults.js';

export type MigrationDirection = 'up' | 'down';
export type MigrationState = 'applied' | 'pending';

export interface MigrationRunnerOptions {
  migrationsDir?: string;
  migrationFileExtension?: '.ts' | '.js';
}

export interface MigrationStatus {
  filename: string;
  status: MigrationState;
  appliedAt: string | null;
}

interface AppliedMigrationRow {
  filename: string;
  applied_at: string;
}

interface MigrationRecord {
  filename: string;
  module?: MigrationModule;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

export async function runMigrations(
  db: Database.Database,
  direction: MigrationDirection = 'up',
  options: MigrationRunnerOptions = {},
): Promise<void> {
  initializeMigrationTracking(db);
  const records = getMigrationRecords(options);

  if (direction === 'up') {
    await runPendingMigrations(db, records, options);
    return;
  }

  if (direction === 'down') {
    await runLatestDownMigration(db, records, options);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export function runMigrationsSync(
  db: Database.Database,
  direction: MigrationDirection = 'up',
): void {
  initializeMigrationTracking(db);
  const records = getDefaultMigrationRecords();

  if (direction === 'up') {
    runPendingMigrationsSync(db, records);
    return;
  }

  if (direction === 'down') {
    runLatestDownMigrationSync(db, records);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export function getMigrationStatuses(
  db: Database.Database,
  options: MigrationRunnerOptions = {},
): MigrationStatus[] {
  initializeMigrationTracking(db);

  const applied = getAppliedMigrations(db);
  return getMigrationRecords(options).map(record => ({
    filename: record.filename,
    status: applied.has(record.filename) ? 'applied' : 'pending',
    appliedAt: applied.get(record.filename) ?? null,
  }));
}

function initializeMigrationTracking(db: Database.Database): void {
  ensureMigrationsTable(db);
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(CREATE_MIGRATIONS_TABLE_SQL);
}

async function runPendingMigrations(
  db: Database.Database,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const applied = getAppliedMigrations(db);

  for (const record of records) {
    if (applied.has(record.filename)) continue;

    const migration = await loadMigrationModule(record, options);
    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(record.filename);
    });

    applyMigration();
    applied.set(record.filename, new Date().toISOString());
  }
}

async function runLatestDownMigration(
  db: Database.Database,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) return;

  const record = records.find(record => record.filename === row.filename);
  if (!record) throw new Error(`Migration file not found: ${row.filename}`);

  const migration = await loadMigrationModule(record, options);
  const revertMigration = db.transaction(() => {
    migration.down(db);
    db.prepare('DELETE FROM migrations WHERE filename = ?').run(row.filename);
  });

  revertMigration();
}

function runPendingMigrationsSync(
  db: Database.Database,
  records: readonly MigrationRecord[],
): void {
  const applied = getAppliedMigrations(db);

  for (const record of records) {
    if (applied.has(record.filename)) continue;
    if (!record.module) throw new Error(`Migration ${record.filename} cannot run synchronously`);

    const applyMigration = db.transaction(() => {
      record.module!.up(db);
      db.prepare('INSERT INTO migrations (filename) VALUES (?)').run(record.filename);
    });

    applyMigration();
    applied.set(record.filename, new Date().toISOString());
  }
}

function runLatestDownMigrationSync(
  db: Database.Database,
  records: readonly MigrationRecord[],
): void {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) return;

  const record = records.find(record => record.filename === row.filename);
  if (!record?.module) throw new Error(`Migration ${row.filename} cannot run synchronously`);

  const revertMigration = db.transaction(() => {
    record.module!.down(db);
    db.prepare('DELETE FROM migrations WHERE filename = ?').run(row.filename);
  });

  revertMigration();
}

function getAppliedMigrations(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`
    SELECT filename, applied_at
      FROM migrations
     ORDER BY filename ASC
  `).all() as AppliedMigrationRow[];

  return new Map(rows.map(row => [row.filename, row.applied_at]));
}

function getMigrationRecords(options: MigrationRunnerOptions): MigrationRecord[] {
  if (isDefaultMigrationSet(options)) return getDefaultMigrationRecords();

  return getMigrationFilenames(options).map(filename => ({ filename }));
}

function getDefaultMigrationRecords(): MigrationRecord[] {
  return DEFAULT_MIGRATIONS.map(migration => ({
    filename: migration.filename,
    module: migration.module,
  }));
}

function getMigrationFilenames(options: MigrationRunnerOptions): string[] {
  const migrationsDir = getMigrationsDir(options);
  if (!fs.existsSync(migrationsDir)) return [];

  const extension = getMigrationFileExtension(options);
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(filename => filename.endsWith(extension) && !filename.endsWith('.d.ts'))
    .sort((left, right) => left.localeCompare(right));
}

async function loadMigrationModule(
  record: MigrationRecord,
  options: MigrationRunnerOptions,
): Promise<MigrationModule> {
  if (record.module) return record.module;

  const migrationPath = path.join(getMigrationsDir(options), record.filename);
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found: ${record.filename}`);
  }

  const imported = await import(pathToFileURL(migrationPath).href) as Partial<MigrationModule>;
  if (typeof imported.up !== 'function' || typeof imported.down !== 'function') {
    throw new Error(`Migration ${record.filename} must export up(db) and down(db) functions`);
  }

  return {
    up: imported.up,
    down: imported.down,
  };
}

function isDefaultMigrationSet(options: MigrationRunnerOptions): boolean {
  return options.migrationsDir === undefined && options.migrationFileExtension === undefined;
}

function getMigrationsDir(options: MigrationRunnerOptions): string {
  return options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
}

function getMigrationFileExtension(options: MigrationRunnerOptions): '.ts' | '.js' {
  if (options.migrationFileExtension) return options.migrationFileExtension;
  return fileURLToPath(import.meta.url).endsWith('.ts') ? '.ts' : '.js';
}
