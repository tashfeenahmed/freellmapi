import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
import { restrictDirToOwner, restrictToOwner } from '../lib/file-permissions.js';
import type { Scheduler } from '../lib/scheduler.js';

const execFileAsync = promisify(execFile);

const SCHEDULE_SETTING = 'backup_schedule';
const LAST_RUN_SETTING = 'backup_last_run_day';

export interface BackupSchedule {
  enabled: boolean;
  /** Local wall-clock time, HH:mm. */
  time: string;
  /** Minimum days between automatic backups. */
  intervalDays: number;
  /** Optional override directory; '' falls back to <db-dir>/backups. */
  backupPath: string;
}

export interface BackupMeta {
  id: number;
  filename: string;
  filesize: number;
  isFull: boolean;
  source: 'manual' | 'scheduled';
  createdAt: string;
  tables: string[];
}

const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  time: '03:00',
  intervalDays: 1,
  backupPath: '',
};

/* ------------------------------------------------------------------ */
/* Database-kind detection                                            */
/* ------------------------------------------------------------------ */

type DbKind = 'sqlite' | 'mysql';

/** The MySQL deployment is signalled by MYSQL_* env vars (its driver is the
 *  async mysql2 wrapper that isn't linked into this build). SQLite is the
 *  default and is what this repository runs on. */
function dbKind(): DbKind {
  return process.env.MYSQL_HOST || process.env.MYSQL_DATABASE ? 'mysql' : 'sqlite';
}

function isInternalTable(name: string): boolean {
  // `backups` is the on-disk backup index itself; dumping/restoring it would
  // wipe the metadata that tracks the backup files.
  return name === 'migrations' || name === 'backups' || name.startsWith('sqlite_');
}

function defaultBackupDir(): string {
  // 项目根目录下的 data/backups/ (与部署包根目录的 data/ 保持一致)。
  return path.resolve(process.cwd(), 'data', 'backups');
}

function resolveBackupDir(override?: string): string {
  const dir = override && override.trim() ? override.trim() : defaultBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  restrictDirToOwner(dir);
  return dir;
}

function ensureDirOwned(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  restrictDirToOwner(dir);
}

/* ------------------------------------------------------------------ */
/* Schedule                                                           */
/* ------------------------------------------------------------------ */

export function readBackupSchedule(): BackupSchedule {
  const raw = getSetting(SCHEDULE_SETTING);
  if (!raw) return { ...DEFAULT_SCHEDULE };
  try {
    const parsed = JSON.parse(raw) as Partial<BackupSchedule>;
    return {
      enabled: parsed.enabled === true,
      time: typeof parsed.time === 'string' && /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : DEFAULT_SCHEDULE.time,
      intervalDays: typeof parsed.intervalDays === 'number' && parsed.intervalDays >= 1 ? Math.floor(parsed.intervalDays) : DEFAULT_SCHEDULE.intervalDays,
      backupPath: typeof parsed.backupPath === 'string' ? parsed.backupPath : DEFAULT_SCHEDULE.backupPath,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export function writeBackupSchedule(schedule: BackupSchedule): BackupSchedule {
  setSetting(SCHEDULE_SETTING, JSON.stringify(schedule));
  return schedule;
}

/* ------------------------------------------------------------------ */
/* SQLite dump/restore (default)                                      */
/* ------------------------------------------------------------------ */

function sqliteEscape(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  const s = String(value);
  return `'${s.replace(/'/g, "''")}'`;
}

function sqliteCreateTable(db: Db, table: string): string | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!row?.sql) return null;
  return `${row.sql.replace(/^CREATE TABLE/i, 'CREATE TABLE IF NOT EXISTS')};`;
}

function sqliteDumpTable(db: Db, table: string): string {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const lines: string[] = [`DELETE FROM "${table}";`];
  if (rows.length > 0) {
    const columnList = columns.map((c) => `"${c}"`).join(', ');
    const valueRows = rows.map((row) => `(${columns.map((c) => sqliteEscape(row[c])).join(', ')})`);
    lines.push(`INSERT INTO "${table}" (${columnList}) VALUES\n  ${valueRows.join(',\n  ')};`);
  }
  return lines.join('\n');
}

function sqliteDump(db: Db, tables: string[]): string {
  const lines = ['-- freellmapi SQLite backup', 'BEGIN TRANSACTION;'];
  for (const table of tables) {
    const create = sqliteCreateTable(db, table);
    if (create) lines.push(create);
    lines.push(sqliteDumpTable(db, table));
  }
  lines.push('COMMIT;');
  return `${lines.join('\n')}\n`;
}

function restoreSqlite(db: Db, sqlContent: string): void {
  const previouslyOn = (() => {
    try {
      const result = db.pragma('foreign_keys') as unknown;
      if (Array.isArray(result) && result[0] && typeof result[0] === 'object') return (result[0] as Record<string, unknown>).foreign_keys === 1;
      if (typeof result === 'object' && result !== null) return (result as Record<string, unknown>).foreign_keys === 1;
    } catch {
      /* ignore */
    }
    return true;
  })();

  try {
    db.pragma('foreign_keys = OFF');
    db.exec(sqlContent);
  } finally {
    if (previouslyOn) {
      try {
        db.pragma('foreign_keys = ON');
      } catch {
        /* restore succeeded even if we cannot flip the pragma back */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* MySQL dump/restore (mysqldump / mysql CLI)                          */
/* ------------------------------------------------------------------ */

function getMysqlConfig() {
  const envHost = process.env.MYSQL_HOST || 'localhost';
  const host = envHost === 'localhost' ? '127.0.0.1' : envHost;
  return {
    host,
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'freellmapi',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'freellmapi',
  };
}

function createTempOptionsFile(config: ReturnType<typeof getMysqlConfig>): string {
  const content = `[client]\nhost=${config.host}\nport=${config.port}\nuser=${config.user}\npassword=${config.password}\n`;
  const filePath = path.join(os.tmpdir(), `mysql_opts_${Date.now()}_${process.pid}.cnf`);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  return filePath;
}

function spawnWithInput(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`));
    });
    child.on('error', reject);
    child.stdin.write(input);
    child.stdin.end();
  });
}

function mysqlListTables(): Promise<string[]> {
  const config = getMysqlConfig();
  const optsFile = createTempOptionsFile(config);
  const args = [`--defaults-extra-file=${optsFile}`, '--default-character-set=utf8mb4', '-N', '-e', 'SHOW TABLES', config.database];
  return execFileAsync(process.env.MYSQL_CLI_PATH || 'mysql', args, { maxBuffer: 50 * 1024 * 1024 })
    .then(({ stdout }) =>
      stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !isInternalTable(s)),
    )
    .finally(() => {
      try {
        fs.unlinkSync(optsFile);
      } catch {
        /* already cleaned up */
      }
    });
}

function mysqlDump(tables: string[], filepath: string): Promise<void> {
  const config = getMysqlConfig();
  const optsFile = createTempOptionsFile(config);
  const args = [
    `--defaults-extra-file=${optsFile}`,
    '--skip-lock-tables',
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    '--default-character-set=utf8mb4',
    config.database,
    ...tables,
  ];
  return execFileAsync(process.env.MYSQLDUMP_PATH || 'mysqldump', args, { maxBuffer: 500 * 1024 * 1024 })
    .then(({ stdout }) => {
      fs.writeFileSync(filepath, stdout);
    })
    .finally(() => {
      try {
        fs.unlinkSync(optsFile);
      } catch {
        /* already cleaned up */
      }
    });
}

function mysqlRestore(filepath: string): Promise<void> {
  const config = getMysqlConfig();
  const optsFile = createTempOptionsFile(config);
  const args = [`--defaults-extra-file=${optsFile}`, '--default-character-set=utf8mb4', config.database];
  const sqlContent = fs.readFileSync(filepath, 'utf8');
  return spawnWithInput(process.env.MYSQL_CLI_PATH || 'mysql', args, sqlContent).finally(() => {
    try {
      fs.unlinkSync(optsFile);
    } catch {
      /* already cleaned up */
    }
  });
}

/* ------------------------------------------------------------------ */
/* Table listing                                                      */
/* ------------------------------------------------------------------ */

export async function listTables(): Promise<string[]> {
  if (dbKind() === 'mysql') return mysqlListTables();
  const db = getDb();
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return rows.map((row) => row.name).filter((name) => !isInternalTable(name));
}

/* ------------------------------------------------------------------ */
/* Backup creation                                                    */
/* ------------------------------------------------------------------ */

export async function createBackup(
  db: Db,
  opts: { tables?: string[]; source?: 'manual' | 'scheduled'; backupPath?: string } = {},
): Promise<BackupMeta> {
  const kind = dbKind();
  const available = kind === 'mysql' ? await mysqlListTables() : sqliteUserTables(db);
  const requested = (opts.tables ?? []).filter((t) => available.includes(t));
  const isFull = requested.length === 0;
  const tables = isFull ? available : requested;

  if (tables.length === 0) {
    throw new Error('No tables to backup');
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const prefix = opts.source === 'scheduled' ? 'auto-backup' : 'backup';
  const filename = `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}.sql`;

  const dir = resolveBackupDir(opts.backupPath ?? readBackupSchedule().backupPath);
  ensureDirOwned(dir);
  const filepath = path.join(dir, filename);

  if (kind === 'mysql') {
    await mysqlDump(tables, filepath);
  } else {
    fs.writeFileSync(filepath, sqliteDump(db, tables), 'utf8');
  }
  restrictToOwner(filepath);

  const filesize = fs.statSync(filepath).size;
  const result = db.prepare(
    'INSERT INTO backups (filename, filepath, filesize, is_full, source, created_at, tables_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(filename, filepath, filesize, isFull ? 1 : 0, opts.source ?? 'manual', createdAt, JSON.stringify(tables));

  return {
    id: Number(result.lastInsertRowid),
    filename,
    filesize,
    isFull,
    source: opts.source ?? 'manual',
    createdAt,
    tables,
  };
}

function sqliteUserTables(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return rows.map((row) => row.name).filter((name) => !isInternalTable(name));
}

/* ------------------------------------------------------------------ */
/* Backup listing / download / delete / restore                        */
/* ------------------------------------------------------------------ */

interface BackupRow {
  id: number;
  filename: string;
  filepath: string | null;
  filesize: number;
  is_full: number;
  source: string;
  created_at: string;
  tables_json: string;
}

function toMeta(row: BackupRow): BackupMeta {
  let tables: string[] = [];
  try {
    const parsed = JSON.parse(row.tables_json) as unknown;
    if (Array.isArray(parsed)) tables = parsed.map(String);
  } catch {
    tables = [];
  }
  return {
    id: row.id,
    filename: row.filename,
    filesize: row.filesize,
    isFull: row.is_full === 1,
    source: row.source === 'scheduled' ? 'scheduled' : 'manual',
    createdAt: row.created_at,
    tables,
  };
}

export function listBackups(db: Db, opts: { page?: number; pageSize?: number } = {}): { items: BackupMeta[]; total: number } {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 20));
  const total = (db.prepare('SELECT COUNT(*) AS n FROM backups').get() as { n: number }).n;
  const rows = db.prepare('SELECT id, filename, filepath, filesize, is_full, source, created_at, tables_json FROM backups ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize) as BackupRow[];
  return { items: rows.map(toMeta), total };
}

function readBackupRecord(db: Db, id: number): BackupRow {
  const row = db.prepare('SELECT id, filename, filepath, filesize, is_full, source, created_at, tables_json FROM backups WHERE id = ?').get(id) as BackupRow | undefined;
  if (!row) {
    throw Object.assign(new Error('Backup not found'), { status: 404 });
  }
  return row;
}

function backupFilePath(row: BackupRow): string {
  if (row.filepath) return row.filepath;
  return path.join(resolveBackupDir(readBackupSchedule().backupPath), row.filename);
}

export function getBackupFile(db: Db, id: number): { path: string; filename: string } {
  const row = readBackupRecord(db, id);
  const filePath = backupFilePath(row);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('Backup file is missing'), { status: 404 });
  }
  return { path: filePath, filename: row.filename };
}

export function deleteBackup(db: Db, id: number): void {
  const row = readBackupRecord(db, id);
  const filePath = backupFilePath(row);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Metadata removal below still succeeds; a missing file is not fatal.
  }
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
}

export async function restoreBackup(db: Db, id: number): Promise<BackupMeta> {
  const row = readBackupRecord(db, id);
  const filePath = backupFilePath(row);
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('Backup file is missing'), { status: 404 });
  }

  if (dbKind() === 'mysql') {
    await mysqlRestore(filePath);
  } else {
    const sqlContent = fs.readFileSync(filePath, 'utf8');
    restoreSqlite(db, sqlContent);
  }

  return toMeta(row);
}

/* ------------------------------------------------------------------ */
/* Auto-backup scheduler                                              */
/* ------------------------------------------------------------------ */

export function startBackupScheduler(scheduler: Scheduler): () => void {
  let lastRunDay: string | null = getSetting(LAST_RUN_SETTING) ?? null;

  const tick = (): void => {
    const schedule = readBackupSchedule();
    if (!schedule.enabled) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < schedule.time) return;

    const today = now.toISOString().slice(0, 10);
    if (lastRunDay === today) return;

    const intervalDays = Math.max(1, schedule.intervalDays);
    if (lastRunDay) {
      const daysSince = Math.floor((Date.parse(today) - Date.parse(lastRunDay)) / 86_400_000);
      if (daysSince < intervalDays) return;
    }

    lastRunDay = today;
    setSetting(LAST_RUN_SETTING, today);
    void createBackup(getDb(), { tables: [], source: 'scheduled', backupPath: schedule.backupPath }).catch((err) => {
      console.error('[backups] scheduled backup failed:', err);
    });
  };

  const stop = scheduler.every(60_000, tick);
  tick();
  return stop;
}
