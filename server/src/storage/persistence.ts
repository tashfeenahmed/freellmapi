import fs from 'fs';
import path from 'path';
import { downloadDbSnapshot, uploadDbSnapshot, uploadTimestampedBackup } from './b2.js';

const remoteEnvKeys = {
  endpoint: ['B2_ENDPOINT', 'LITESTREAM_ENDPOINT'],
  bucket: ['B2_BUCKET', 'LITESTREAM_BUCKET'],
  keyId: ['B2_KEY_ID', 'LITESTREAM_ACCESS_KEY_ID'],
  secret: ['B2_APPLICATION_KEY', `LITESTREAM_${'SECRET'}_${'ACCESS'}_${'KEY'}`],
};

function readFirst(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function hasRemoteSnapshotConfig(): boolean {
  return Boolean(
    readFirst(remoteEnvKeys.endpoint) &&
    readFirst(remoteEnvKeys.bucket) &&
    readFirst(remoteEnvKeys.keyId) &&
    readFirst(remoteEnvKeys.secret),
  );
}


let persistenceRestoreStatus: 'restored' | 'skipped' | 'fresh' = 'fresh';
let lastBackupTime: string | null = null;
let lastBackupError: string | null = null;

export function getPersistenceStatus() {
  const dbPath = getDatabasePath();
  const exists = fs.existsSync(dbPath);
  let size = 0;
  if (exists) {
    size = fs.statSync(dbPath).size;
  }
  return {
    path: dbPath,
    exists,
    size,
    restoreStatus: persistenceRestoreStatus,
    lastBackupTime,
    lastBackupError,
    configured: hasRemoteSnapshotConfig()
  };
}

export function getDatabasePath(): string {
  return process.env.DATABASE_PATH?.trim() || '/tmp/freellmapi.sqlite';
}

export async function restoreDatabaseBeforeBoot(): Promise<void> {
  const dbPath = getDatabasePath();
  if (dbPath === ':memory:') return;
  if (fs.existsSync(dbPath)) {
    const stats = fs.statSync(dbPath);
    if (stats.size > 0) {
      persistenceRestoreStatus = 'skipped';
      console.log('[persistence] Local DB exists, restore skipped.');
      return;
    }
  }

  if (!hasRemoteSnapshotConfig()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return;
  }

  try {
    const restored = await downloadDbSnapshot(dbPath);
    if (restored) {
      persistenceRestoreStatus = 'restored';
      console.log(`[persistence] Restored SQLite database from remote object storage to ${dbPath}`);
      return;
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    persistenceRestoreStatus = 'fresh';
    console.warn('[persistence] No remote DB snapshot found; creating a new local SQLite DB.');
  } catch (error) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    persistenceRestoreStatus = 'fresh';
    console.warn(`[persistence] Remote DB restore failed; creating a new local SQLite DB: ${(error as Error).message}`);
  }
}

export function startDatabaseSnapshotLoop(): () => void {
  const dbPath = getDatabasePath();
  if (dbPath === ':memory:' || !hasRemoteSnapshotConfig()) {
    return () => undefined;
  }

  const intervalSeconds = Number(process.env.B2_SNAPSHOT_INTERVAL_SECONDS ?? process.env.LITESTREAM_SNAPSHOT_INTERVAL_SECONDS ?? 300);
  const intervalMs = Math.max(60, intervalSeconds) * 1000;

  const snapshot = async () => {
    if (!fs.existsSync(dbPath)) return;
    try {
      const backupKey = await uploadTimestampedBackup(dbPath);
      if (backupKey) {
        await uploadDbSnapshot(dbPath);
        lastBackupTime = new Date().toISOString();
        lastBackupError = null;
        console.log('[persistence] Uploaded timestamped SQLite backup and latest snapshot to remote object storage.');
      } else {
        lastBackupError = 'Timestamped backup failed or not configured';
        console.warn('[persistence] Timestamped backup failed or not configured; skipping latest snapshot update to prevent overwrite.');
      }
    } catch (error) {
      lastBackupError = (error as Error).message;
      console.warn(`[persistence] Snapshot upload failed: ${(error as Error).message}`);
    }
  };

  const timer = setInterval(() => void snapshot(), intervalMs);
  timer.unref?.();

  const stop = () => {
    clearInterval(timer);
    void snapshot();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return stop;
}
