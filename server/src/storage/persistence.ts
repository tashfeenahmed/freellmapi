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

export function getDatabasePath(): string {
  return process.env.DATABASE_PATH?.trim() || '/tmp/freellmapi.sqlite';
}

export async function restoreDatabaseBeforeBoot(): Promise<void> {
  const dbPath = getDatabasePath();
  if (dbPath === ':memory:') return;
  if (fs.existsSync(dbPath)) return;

  if (!hasRemoteSnapshotConfig()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return;
  }

  try {
    const restored = await downloadDbSnapshot(dbPath);
    if (restored) {
      console.log(`[persistence] Restored SQLite database from remote object storage to ${dbPath}`);
      return;
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    console.warn('[persistence] No remote DB snapshot found; creating a new local SQLite DB.');
  } catch (error) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
      await uploadDbSnapshot(dbPath);
      await uploadTimestampedBackup(dbPath);
      console.log('[persistence] Uploaded SQLite snapshot to remote object storage.');
    } catch (error) {
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
