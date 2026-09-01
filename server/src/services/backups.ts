import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { getDb, getDefaultDbPath, getSetting, setSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
import { encryptionKeyFingerprint } from '../lib/crypto.js';
import { restrictDirToOwner, restrictToOwner } from '../lib/file-permissions.js';
import type { Scheduler } from '../lib/scheduler.js';

const SCHEDULE_SETTING = 'backup_schedule';
const LAST_RUN_SETTING = 'backup_last_run_day';

/** Bumped whenever the on-disk dump layout changes in a way an older restore
 *  path would misread. Restore refuses anything it does not know. */
const DUMP_FORMAT = 1;

export type BackupSource = 'manual' | 'scheduled' | 'pre-restore';

export interface BackupSchedule {
  enabled: boolean;
  /** Local wall-clock time, HH:mm. */
  time: string;
  /** Minimum days between automatic backups. */
  intervalDays: number;
  /** Optional sub-directory of the database directory; '' means <db-dir>/backups. */
  backupPath: string;
}

export interface BackupMeta {
  id: number;
  filename: string;
  filesize: number;
  isFull: boolean;
  source: BackupSource;
  createdAt: string;
  tables: string[];
}

const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  time: '03:00',
  intervalDays: 1,
  backupPath: '',
};

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/* ------------------------------------------------------------------ */
/* Table selection                                                    */
/* ------------------------------------------------------------------ */

// Credentials and live login state. A dump is a file an operator downloads,
// mails to themselves and drops in cloud storage; it must not carry the
// password hashes and session tokens that authenticate the dashboard, and
// restoring one must not resurrect deleted accounts or revoked sessions (or
// log the current operator out mid-restore). `settings` is deliberately NOT
// here: routing strategy, the unified key and the proxy config are exactly
// what an operator expects a backup to bring back.
const EXCLUDED_TABLES = new Set(['users', 'sessions', 'url_tokens']);

/** `backups` is the on-disk backup index itself; dumping and restoring it
 *  would wipe the metadata that tracks the files. `migrations` is the schema
 *  ledger, which restore checks rather than overwrites. */
function isInternalTable(name: string): boolean {
  return name === 'migrations' || name === 'backups' || name.startsWith('sqlite_');
}

export function isExcludedTable(name: string): boolean {
  return EXCLUDED_TABLES.has(name);
}

function isBackupableTable(name: string): boolean {
  return !isInternalTable(name) && !isExcludedTable(name);
}

/** Every table a dump may contain, in a stable order. */
export function listTables(db: Db = getDb()): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
  return rows.map((row) => row.name).filter(isBackupableTable);
}

/* ------------------------------------------------------------------ */
/* Backup directory (confined to the database directory)              */
/* ------------------------------------------------------------------ */

/** The directory that holds the database file. Dumps live beside the data they
 *  came from — never relative to process.cwd(), which depends on how the server
 *  happened to be launched and can sit anywhere on the disk. */
function dataDir(db: Db): string {
  const name = db.name;
  if (name && name !== ':memory:' && db.memory !== true) {
    return path.resolve(path.dirname(path.resolve(name)));
  }
  return path.resolve(path.dirname(path.resolve(getDefaultDbPath())));
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Resolve (and create) the directory a dump is written to. `override` is
 *  interpreted relative to the database directory and may not escape it:
 *  an operator-supplied path is otherwise an arbitrary-write primitive, and
 *  `..`, an absolute path or a symlink out of the tree would all take it
 *  there. Both the lexical path and — once the directory exists — its real
 *  path are checked, so a symlink planted inside the data directory does not
 *  widen the hole. */
export function resolveBackupDir(db: Db, override?: string): string {
  const root = dataDir(db);
  const trimmed = override?.trim() ?? '';
  const dir = trimmed ? path.resolve(root, trimmed) : path.join(root, 'backups');
  if (!isInside(root, dir)) {
    throw httpError(`backupPath must stay inside the database directory (${root})`, 400);
  }

  fs.mkdirSync(dir, { recursive: true });
  restrictDirToOwner(dir);

  try {
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(dir);
    if (!isInside(realRoot, realDir)) {
      throw httpError(`backupPath resolves outside the database directory (${realRoot})`, 400);
    }
  } catch (err) {
    if ((err as { status?: number }).status === 400) throw err;
    // realpath is best-effort hardening; the lexical check above already ran.
  }

  return dir;
}

/** Validation hook for the schedule route: reject a path the writer would
 *  refuse later, at the moment the operator types it. */
export function assertBackupPathAllowed(db: Db, backupPath: string): void {
  if (!backupPath.trim()) return;
  resolveBackupDir(db, backupPath);
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
/* Dump header                                                        */
/* ------------------------------------------------------------------ */

/** Identity of the schema a dump was taken against: the number of applied
 *  migrations plus the latest filename. Restoring a dump into a database at a
 *  different schema silently drops columns added since, or fails halfway; the
 *  header lets restore refuse instead. */
export function schemaVersion(db: Db): string {
  const rows = db.prepare('SELECT filename FROM migrations ORDER BY filename').all() as { filename: string }[];
  const latest = rows.length > 0 ? rows[rows.length - 1].filename : '(none)';
  return `${rows.length} migrations, latest ${latest}`;
}

function currentKeyFingerprint(): string {
  return encryptionKeyFingerprint() ?? 'none';
}

interface DumpHeader {
  format: number;
  schema: string;
  keyFingerprint: string;
  tables: string[];
}

function renderHeader(db: Db, tables: string[], createdAt: string): string {
  return [
    '-- freellmapi database backup',
    `-- format: ${DUMP_FORMAT}`,
    `-- created: ${createdAt}`,
    `-- schema: ${schemaVersion(db)}`,
    `-- key-fingerprint: ${currentKeyFingerprint()}`,
    `-- tables: ${tables.join(', ')}`,
    '-- excluded by policy: ' + [...EXCLUDED_TABLES].join(', '),
    '',
  ].join('\n');
}

function readHeaderField(sql: string, field: string): string | null {
  const match = new RegExp(`^--\\s*${field}:\\s*(.*)$`, 'm').exec(sql);
  return match ? match[1].trim() : null;
}

function parseHeader(sql: string): DumpHeader {
  const format = Number.parseInt(readHeaderField(sql, 'format') ?? '', 10);
  const schema = readHeaderField(sql, 'schema');
  const keyFingerprint = readHeaderField(sql, 'key-fingerprint');
  const tablesLine = readHeaderField(sql, 'tables');
  if (!Number.isInteger(format) || schema === null || keyFingerprint === null) {
    throw httpError('This file is not a freellmapi backup (its header is missing or damaged).', 400);
  }
  return {
    format,
    schema,
    keyFingerprint,
    tables: (tablesLine ?? '').split(',').map((t) => t.trim()).filter((t) => t.length > 0),
  };
}

/* ------------------------------------------------------------------ */
/* SQLite dump                                                        */
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
  const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
  const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
  const lines: string[] = [`DELETE FROM "${table}";`];
  if (rows.length > 0) {
    const columnList = columns.map((c) => `"${c}"`).join(', ');
    const valueRows = rows.map((row) => `(${columns.map((c) => sqliteEscape(row[c])).join(', ')})`);
    lines.push(`INSERT INTO "${table}" (${columnList}) VALUES\n  ${valueRows.join(',\n  ')};`);
  }
  return lines.join('\n');
}

// No BEGIN/COMMIT in the body: restore runs the whole file inside one
// db.transaction() so a failure halfway through rolls the database back to
// where it started, and a nested BEGIN would abort that.
function sqliteDump(db: Db, tables: string[], createdAt: string): string {
  const lines = [renderHeader(db, tables, createdAt)];
  for (const table of tables) {
    const create = sqliteCreateTable(db, table);
    if (create) lines.push(create);
    lines.push(sqliteDumpTable(db, table));
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Backup creation                                                    */
/* ------------------------------------------------------------------ */

export function createBackup(
  db: Db,
  opts: { tables?: string[]; source?: BackupSource; backupPath?: string } = {},
): BackupMeta {
  const available = listTables(db);
  const requested = (opts.tables ?? []).filter((t) => available.includes(t));
  const isFull = requested.length === 0;
  const tables = isFull ? available : requested;

  if (tables.length === 0) {
    throw httpError('No tables to backup', 400);
  }

  const source: BackupSource = opts.source ?? 'manual';
  const now = new Date();
  const createdAt = now.toISOString();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const prefix = source === 'scheduled' ? 'auto-backup' : source === 'pre-restore' ? 'pre-restore' : 'backup';
  const filename = `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}.sql`;

  const dir = resolveBackupDir(db, opts.backupPath ?? readBackupSchedule().backupPath);
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, sqliteDump(db, tables, createdAt), { encoding: 'utf8', mode: 0o600 });
  restrictToOwner(filepath);

  const filesize = fs.statSync(filepath).size;
  const result = db.prepare(
    'INSERT INTO backups (filename, filepath, filesize, is_full, source, created_at, tables_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(filename, filepath, filesize, isFull ? 1 : 0, source, createdAt, JSON.stringify(tables));

  return { id: Number(result.lastInsertRowid), filename, filesize, isFull, source, createdAt, tables };
}

/* ------------------------------------------------------------------ */
/* Backup listing / download / delete / restore                       */
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

const SELECT_COLUMNS = 'id, filename, filepath, filesize, is_full, source, created_at, tables_json';

function toMeta(row: BackupRow): BackupMeta {
  let tables: string[] = [];
  try {
    const parsed = JSON.parse(row.tables_json) as unknown;
    if (Array.isArray(parsed)) tables = parsed.map(String);
  } catch {
    tables = [];
  }
  const source: BackupSource =
    row.source === 'scheduled' ? 'scheduled' : row.source === 'pre-restore' ? 'pre-restore' : 'manual';
  return {
    id: row.id,
    filename: row.filename,
    filesize: row.filesize,
    isFull: row.is_full === 1,
    source,
    createdAt: row.created_at,
    tables,
  };
}

export function listBackups(db: Db, opts: { page?: number; pageSize?: number } = {}): { items: BackupMeta[]; total: number } {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 20));
  const total = (db.prepare('SELECT COUNT(*) AS n FROM backups').get() as { n: number }).n;
  const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM backups ORDER BY id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as BackupRow[];
  return { items: rows.map(toMeta), total };
}

function readBackupRecord(db: Db, id: number): BackupRow {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM backups WHERE id = ?`).get(id) as BackupRow | undefined;
  if (!row) throw httpError('Backup not found', 404);
  return row;
}

/** The recorded path, re-checked against the data directory on every read: a
 *  row written before the directory moved (or edited by hand) must not become
 *  a way to read or delete a file elsewhere on the disk. */
function backupFilePath(db: Db, row: BackupRow): string {
  const root = dataDir(db);
  const candidate = row.filepath
    ? path.resolve(row.filepath)
    : path.join(resolveBackupDir(db, readBackupSchedule().backupPath), row.filename);
  if (!isInside(root, candidate)) {
    throw httpError('Backup file lies outside the database directory', 400);
  }
  return candidate;
}

export function getBackupFile(db: Db, id: number): { path: string; filename: string } {
  const row = readBackupRecord(db, id);
  const filePath = backupFilePath(db, row);
  if (!fs.existsSync(filePath)) {
    throw httpError('Backup file is missing', 404);
  }
  return { path: filePath, filename: row.filename };
}

export function deleteBackup(db: Db, id: number): void {
  const row = readBackupRecord(db, id);
  const filePath = backupFilePath(db, row);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Metadata removal below still succeeds; a missing file is not fatal.
  }
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
}

/** Statements naming a table the dump policy excludes. A dump this server
 *  wrote never contains them, so hitting this means the file was edited or
 *  produced elsewhere — and restoring it would overwrite the operator's own
 *  accounts and sessions. */
const EXCLUDED_STATEMENT_RE = new RegExp(
  `\\b(?:INSERT\\s+INTO|DELETE\\s+FROM|UPDATE|DROP\\s+TABLE)\\s+"?(?:${[...EXCLUDED_TABLES].join('|')})"?\\b`,
  'i',
);

export interface RestoreResult {
  backup: BackupMeta;
  /** Dump of the pre-restore state, written before anything was changed. */
  snapshot: BackupMeta;
}

export function restoreBackup(db: Db, id: number): RestoreResult {
  const row = readBackupRecord(db, id);
  const filePath = backupFilePath(db, row);
  if (!fs.existsSync(filePath)) {
    throw httpError('Backup file is missing', 404);
  }

  const sql = fs.readFileSync(filePath, 'utf8');
  const header = parseHeader(sql);

  if (header.format !== DUMP_FORMAT) {
    throw httpError(`This backup uses dump format ${header.format}; this server reads format ${DUMP_FORMAT}.`, 409);
  }

  // A dump only carries rows, not the schema evolution around them. Restoring
  // one taken at a different migration state would drop columns added since,
  // or insert into columns that no longer exist.
  const current = schemaVersion(db);
  if (header.schema !== current) {
    throw httpError(
      `This backup was taken at a different schema version (backup: ${header.schema}; database: ${current}). ` +
      'Restore it into a server running the matching version.',
      409,
    );
  }

  // api_keys rows hold AES-GCM ciphertext keyed by ENCRYPTION_KEY. Restoring a
  // dump written under a different key would load provider keys nothing on this
  // server can decrypt — every request would then fail at send time, with the
  // real cause several layers away.
  const fingerprint = currentKeyFingerprint();
  if (header.keyFingerprint !== fingerprint) {
    throw httpError(
      `This backup was written under a different ENCRYPTION_KEY (backup: ${header.keyFingerprint}; server: ${fingerprint}). ` +
      'The stored provider keys could not be decrypted. Restore it on the server that holds the original key.',
      409,
    );
  }

  const offending = header.tables.find(isExcludedTable);
  if (offending || EXCLUDED_STATEMENT_RE.test(sql)) {
    throw httpError(
      `This backup writes to ${offending ?? 'an account or session table'}, which backups never include. Refusing to restore it.`,
      400,
    );
  }

  // Written before a single row changes, so a restore that turns out to be the
  // wrong file is one restore away from being undone.
  const snapshot = createBackup(db, { source: 'pre-restore' });

  // SQLite ignores `PRAGMA foreign_keys` inside a transaction, so it has to be
  // flipped out here. The dump deletes and reloads whole tables, which
  // transiently breaks references between them.
  const foreignKeysWereOn = readForeignKeysPragma(db);
  try {
    db.pragma('foreign_keys = OFF');
    // One transaction for the whole file: better-sqlite3 rolls it back if any
    // statement throws, so a bad dump leaves the database exactly as it was.
    db.transaction(() => {
      db.exec(sql);
    })();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw httpError(
      `Restore failed and was rolled back; the database is unchanged (${reason}). ` +
      `A snapshot of the current data was saved as ${snapshot.filename}.`,
      400,
    );
  } finally {
    if (foreignKeysWereOn) {
      try {
        db.pragma('foreign_keys = ON');
      } catch {
        // The restore itself already succeeded or rolled back; the pragma is
        // re-applied on the next connection either way.
      }
    }
  }

  return { backup: toMeta(row), snapshot };
}

function readForeignKeysPragma(db: Db): boolean {
  try {
    const result = db.pragma('foreign_keys') as unknown;
    if (Array.isArray(result) && result[0] && typeof result[0] === 'object') {
      return (result[0] as Record<string, unknown>).foreign_keys === 1;
    }
    if (typeof result === 'object' && result !== null) {
      return (result as Record<string, unknown>).foreign_keys === 1;
    }
  } catch {
    // Drivers without pragma introspection: assume it was on, which is the
    // stricter of the two states to put back.
  }
  return true;
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
    try {
      createBackup(getDb(), { tables: [], source: 'scheduled', backupPath: schedule.backupPath });
    } catch (err) {
      console.error('[backups] scheduled backup failed:', err);
    }
  };

  const stop = scheduler.every(60_000, tick);
  tick();
  return stop;
}
