import '../../env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { connectDb } from '../index.js';
import { getMigrationStatuses, runMigrations } from './runner.js';

type Command = 'up' | 'down' | 'fresh' | 'status' | 'create';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const TEMPLATE_PATH = path.resolve(__dirname, 'TEMPLATE.ts');
const DEFAULTS_PATH = path.resolve(__dirname, 'defaults.ts');

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;

  if (command === 'create') {
    createMigrationFile();
    return;
  }

  const db = connectDb();

  switch (command) {
    case 'up':
      await runMigrations(db, 'up');
      return;
    case 'down':
      await runMigrations(db, 'down');
      return;
    case 'fresh':
      await runFresh(db);
      return;
    case 'status':
      printStatus(db);
      return;
    default:
      console.error('Usage: tsx src/db/migrate/cli.ts <up|down|fresh|status|create>');
      process.exit(1);
  }
}

async function runFresh(db: Database.Database): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('db:migration:fresh is not allowed in production');
    process.exit(1);
  }

  dropAllUserTables(db);
  await runMigrations(db, 'up');
}

function printStatus(db: Database.Database): void {
  const statuses = getMigrationStatuses(db);
  console.table(statuses.map(status => ({
    filename: status.filename,
    status: status.status,
    applied_at: status.appliedAt ?? '',
  })));
}

function createMigrationFile(): void {
  const rawName = getMigrationName();
  if (!rawName) {
    console.error('Error: --name is required. Usage: npm run db:migration:create --name=<description>');
    process.exit(1);
  }

  const sanitisedName = sanitiseMigrationName(rawName);
  if (!sanitisedName) {
    console.error('Error: --name must contain at least one letter or digit');
    process.exit(1);
  }

  const now = new Date();
  const filename = `${formatTimestamp(now)}_${sanitisedName}.ts`;
  const outputPath = path.join(MIGRATIONS_DIR, filename);
  const relativeOutputPath = toPosixPath(path.relative(process.cwd(), outputPath));

  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`Error: migration template not found at ${toPosixPath(TEMPLATE_PATH)}`);
    process.exit(1);
  }

  if (fs.existsSync(outputPath)) {
    console.error(`Error: migration already exists at ${relativeOutputPath}`);
    process.exit(1);
  }

  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const content = template
    .replaceAll('<short description>', rawName)
    .replaceAll('<YYYY-MM-DD>', formatDate(now));

  fs.writeFileSync(outputPath, content, { flag: 'wx' });
  updateDefaultMigrationRegistry(filename);
  console.log(`Created ${relativeOutputPath}`);
}

function updateDefaultMigrationRegistry(filename: string): void {
  if (!fs.existsSync(DEFAULTS_PATH)) {
    console.error(`Error: migration registry not found at ${toPosixPath(DEFAULTS_PATH)}`);
    process.exit(1);
  }

  const bindingName = toMigrationBindingName(filename);
  const importPath = `../migrations/${filename.replace(/\.ts$/, '.js')}`;
  const importLine = `import * as ${bindingName} from '${importPath}';`;
  const entryLine = `  { filename: '${filename}', module: ${bindingName} },`;
  const registry = fs.readFileSync(DEFAULTS_PATH, 'utf8');

  if (registry.includes(importLine) || registry.includes(entryLine)) return;

  const withImport = registry.replace(
    '\nexport interface MigrationModule',
    `\n${importLine}\n\nexport interface MigrationModule`,
  );

  if (withImport === registry) {
    console.error('Error: could not update migration registry imports');
    process.exit(1);
  }

  const withEntry = withImport.replace(
    /\n\];\s*$/,
    `\n${entryLine}\n];\n`,
  );

  if (withEntry === withImport) {
    console.error('Error: could not update migration registry entries');
    process.exit(1);
  }

  fs.writeFileSync(DEFAULTS_PATH, withEntry);
}

function getMigrationName(): string | undefined {
  const argvName = process.argv
    .map(arg => arg.match(/^--name=(.+)$/)?.[1]?.trim())
    .find((name): name is string => Boolean(name));

  return argvName || process.env.npm_config_name?.trim();
}

function sanitiseMigrationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[ -]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatTimestamp(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '_',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

function formatDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join('-');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toMigrationBindingName(filename: string): string {
  return `migration${filename.replace(/\.ts$/, '').replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function dropAllUserTables(db: Database.Database): void {
  const tables = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name ASC
  `).all() as { name: string }[];

  db.pragma('foreign_keys = OFF');
  try {
    const dropTables = db.transaction(() => {
      for (const { name } of tables) {
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
      }
    });
    dropTables();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function toPosixPath(value: string): string {
  return value.replaceAll(path.sep, '/');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
