import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import type Database from 'better-sqlite3';
import type { Scheduler } from './scheduler.js';
import { getDefaultDbPath } from '../db/index.js';

const MAGIC = Buffer.from('FAPIBK1\0');
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const PLACEHOLDER_KEY = 'replace-with-64-char-hex';

export interface DbBackupResult {
  ok: boolean;
  target?: string;
  bytes?: number;
  restored?: boolean;
  skipped?: string;
}

function backupTarget(): string | null {
  const raw = process.env.FREEAPI_DB_BACKUP_TARGET
    ?? process.env.FREEAPI_DB_BACKUP_URL
    ?? process.env.FREEAPI_DB_BACKUP_PATH
    ?? '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isDbBackupConfigured(): boolean {
  return backupTarget() !== null;
}

function backupIntervalMs(): number {
  const raw = process.env.FREEAPI_DB_BACKUP_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_INTERVAL_MS;
}

function isHttpTarget(target: string): boolean {
  return target.startsWith('https://') || target.startsWith('http://');
}

function parseBackupKey(): Buffer {
  const raw = (process.env.FREEAPI_DB_BACKUP_KEY || process.env.ENCRYPTION_KEY || '').trim();
  if (!raw || raw === PLACEHOLDER_KEY || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('FREEAPI_DB_BACKUP_KEY or ENCRYPTION_KEY must be a 64-character hex key when DB backup is enabled');
  }
  return Buffer.from(raw, 'hex');
}

function encryptBackup(plain: Buffer): Buffer {
  const key = parseBackupKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decryptBackup(payload: Buffer): Buffer {
  if (payload.length < MAGIC.length + 12 + 16 || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('backup payload has an unsupported format');
  }
  const key = parseBackupKey();
  const ivStart = MAGIC.length;
  const tagStart = ivStart + 12;
  const bodyStart = tagStart + 16;
  const iv = payload.subarray(ivStart, tagStart);
  const tag = payload.subarray(tagStart, bodyStart);
  const ciphertext = payload.subarray(bodyStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function readTarget(target: string): Promise<Buffer | null> {
  if (isHttpTarget(target)) {
    const headers: Record<string, string> = {};
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(target, { method: 'GET', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`backup restore failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

async function writeTarget(target: string, payload: Buffer): Promise<void> {
  if (isHttpTarget(target)) {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    const token = process.env.FREEAPI_DB_BACKUP_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(target, {
      method: 'PUT',
      headers,
      body: payload,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`backup upload failed: HTTP ${res.status}`);
    return;
  }

  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, payload);
}

export async function restoreDbBackupIfNeeded(dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) return { ok: true, target, skipped: 'database already exists' };

  const payload = await readTarget(target);
  if (!payload || payload.length === 0) return { ok: true, target, skipped: 'no backup found' };

  let restored: Buffer;
  try {
    restored = gunzipSync(decryptBackup(payload));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not restore SQLite backup from ${target}: ${detail}`);
  }

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  fs.writeFileSync(dbPath, restored);
  console.log(`[db-backup] restored ${restored.length} bytes from ${target}`);
  return { ok: true, target, bytes: restored.length, restored: true };
}

export async function backupDbNow(db: Database.Database, dbPath = getDefaultDbPath()): Promise<DbBackupResult> {
  const target = backupTarget();
  if (!target) return { ok: true, skipped: 'not configured' };
  if (dbPath === ':memory:') return { ok: true, target, skipped: 'memory database' };
  if (!fs.existsSync(dbPath)) return { ok: false, target, skipped: 'database file missing' };

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Best effort: reading the main DB still works for rollback-journal or quiet WAL DBs.
  }

  const plain = fs.readFileSync(dbPath);
  const payload = encryptBackup(gzipSync(plain));
  await writeTarget(target, payload);
  console.log(`[db-backup] uploaded ${plain.length} bytes to ${target}`);
  return { ok: true, target, bytes: plain.length };
}

export function startDbBackupPump(db: Database.Database, scheduler: Scheduler, dbPath = getDefaultDbPath()): (() => void) | null {
  if (!backupTarget()) return null;
  const run = () => {
    void backupDbNow(db, dbPath).catch(err => {
      console.warn(`[db-backup] ${err instanceof Error ? err.message : err}`);
    });
  };
  run();
  return scheduler.every(backupIntervalMs(), run);
}
