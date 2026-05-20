import fs from 'fs';
import path from 'path';
import { get, put } from '@vercel/blob';

const DEFAULT_DB_BLOB_PATH = 'sqlite/freeapi.db';

let activeDbPath: string | null = null;
let activeDbIsMemory = true;
let checkpoint: (() => void) | null = null;
let persistQueue: Promise<boolean> = Promise.resolve(false);

function dbBlobPath(): string {
  return process.env.FREEAPI_DB_BLOB_PATH ?? DEFAULT_DB_BLOB_PATH;
}

function hasBlobAuth(): boolean {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN
    || (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID),
  );
}

export function dbSnapshotPersistenceEnabled(dbPath = activeDbPath, isMemory = activeDbIsMemory): boolean {
  return !isMemory && Boolean(dbPath) && hasBlobAuth();
}

export function configureDbSnapshotPersistence(
  dbPath: string,
  isMemory: boolean,
  checkpointFn: (() => void) | null,
): void {
  activeDbPath = dbPath;
  activeDbIsMemory = isMemory;
  checkpoint = checkpointFn;
}

async function writeStreamToFile(stream: ReadableStream<Uint8Array>, filePath: string): Promise<void> {
  const reader = stream.getReader();
  const writer = fs.createWriteStream(filePath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) writer.write(Buffer.from(value));
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

export async function restoreDbSnapshot(dbPath: string, isMemory: boolean): Promise<boolean> {
  if (!dbSnapshotPersistenceEnabled(dbPath, isMemory)) return false;

  const result = await get(dbBlobPath(), { access: 'private', useCache: false });
  if (!result) return false;
  if (result.statusCode !== 200 || !result.stream) return false;

  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const tempPath = `${dbPath}.restore-${process.pid}-${Date.now()}`;
  await writeStreamToFile(result.stream, tempPath);
  fs.renameSync(tempPath, dbPath);

  console.log(`[DB] Restored SQLite snapshot from Vercel Blob: ${dbBlobPath()}`);
  return true;
}

export async function persistDbSnapshot(reason = 'manual'): Promise<boolean> {
  if (!dbSnapshotPersistenceEnabled() || !activeDbPath) return false;

  persistQueue = persistQueue.catch(() => false).then(async () => {
    if (!activeDbPath || !fs.existsSync(activeDbPath)) return false;

    checkpoint?.();

    const tempPath = `${activeDbPath}.snapshot-${process.pid}-${Date.now()}`;
    fs.copyFileSync(activeDbPath, tempPath);

    try {
      await put(dbBlobPath(), fs.createReadStream(tempPath), {
        access: 'private',
        allowOverwrite: true,
        contentType: 'application/vnd.sqlite3',
        cacheControlMaxAge: 60,
      });
      console.log(`[DB] Persisted SQLite snapshot to Vercel Blob (${reason})`);
      return true;
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  });

  return persistQueue;
}
