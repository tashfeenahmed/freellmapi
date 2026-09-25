import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import pg from 'pg';
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

interface MigrationRecord {
  filename: string;
  module?: MigrationModule;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export async function runMigrations(
  pool: pg.Pool,
  direction: MigrationDirection = 'up',
  options: MigrationRunnerOptions = {},
): Promise<void> {
  await ensureMigrationsTable(pool);
  const records = getMigrationRecords(options);

  if (direction === 'up') {
    await runPendingMigrations(pool, records, options);
    return;
  }

  if (direction === 'down') {
    await runLatestDownMigration(pool, records, options);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export async function getMigrationStatuses(
  pool: pg.Pool,
  options: MigrationRunnerOptions = {},
): Promise<MigrationStatus[]> {
  await ensureMigrationsTable(pool);

  const applied = await getAppliedMigrations(pool);
  return getMigrationRecords(options).map(record => ({
    filename: record.filename,
    status: applied.has(record.filename) ? 'applied' : 'pending',
    appliedAt: applied.get(record.filename) ?? null,
  }));
}

async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(CREATE_MIGRATIONS_TABLE_SQL);
}

async function runPendingMigrations(
  pool: pg.Pool,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const applied = await getAppliedMigrations(pool);

  for (const record of records) {
    if (applied.has(record.filename)) continue;

    const migration = await loadMigrationModule(record, options);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await migration.up(client);
      await client.query('INSERT INTO migrations (filename) VALUES ($1)', [record.filename]);
      await client.query('COMMIT');
      applied.set(record.filename, new Date().toISOString());
      console.log(`[migration] Applied ${record.filename}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

async function runLatestDownMigration(
  pool: pg.Pool,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const res = await pool.query(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `);
  const row = res.rows[0] as { filename: string } | undefined;
  if (!row) return;

  const record = records.find(r => r.filename === row.filename);
  if (!record) throw new Error(`Migration file not found: ${row.filename}`);

  const migration = await loadMigrationModule(record, options);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await migration.down(client);
    await client.query('DELETE FROM migrations WHERE filename = $1', [row.filename]);
    await client.query('COMMIT');
    console.log(`[migration] Reverted ${row.filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getAppliedMigrations(pool: pg.Pool): Promise<Map<string, string>> {
  const res = await pool.query(`
    SELECT filename, applied_at
      FROM migrations
     ORDER BY filename ASC
  `);
  return new Map(res.rows.map((row: any) => [row.filename, new Date(row.applied_at).toISOString()]));
}

function getMigrationRecords(options: MigrationRunnerOptions): MigrationRecord[] {
  if (isDefaultMigrationSet(options)) return [...DEFAULT_MIGRATIONS];

  return getMigrationFilenames(options).map(filename => ({ filename }));
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
    throw new Error(`Migration ${record.filename} must export up(client) and down(client) functions`);
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
