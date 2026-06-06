import { Router } from 'express';
import type { Request, Response } from 'express';
import { getB2StorageStatus, uploadDbSnapshot, downloadDbSnapshot, uploadTimestampedBackup } from '../storage/b2.js';
import { getDatabasePath, getPersistenceStatus } from '../storage/persistence.js';

export const storageRouter = Router();

storageRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    ...getB2StorageStatus(),
    databasePath: getDatabasePath() ?? 'default',
    restoreOnBoot: process.env.B2_RESTORE_ON_BOOT === 'true',
    snapshotIntervalSeconds: Number(process.env.B2_SNAPSHOT_INTERVAL_SECONDS ?? 300),
  });
});

storageRouter.post('/snapshot', async (_req: Request, res: Response) => {
  const dbPath = getDatabasePath();
  if (!dbPath) {
    res.status(400).json({ error: { message: 'DATABASE_PATH is not configured; default embedded DB path is not safe for manual B2 snapshots.' } });
    return;
  }

  try {
    await uploadDbSnapshot(dbPath);
    const backupObjectKey = await uploadTimestampedBackup(dbPath);
    res.json({ success: true, objectKey: process.env.B2_DB_OBJECT_KEY ?? 'db/freellmapi.sqlite', backupObjectKey });
  } catch (error) {
    res.status(500).json({ error: { message: (error as Error).message } });
  }
});

storageRouter.post('/restore', async (_req: Request, res: Response) => {
  const dbPath = getDatabasePath();
  if (!dbPath) {
    res.status(400).json({ error: { message: 'DATABASE_PATH is not configured; refusing manual restore.' } });
    return;
  }

  try {
    const restored = await downloadDbSnapshot(dbPath);
    res.json({ success: restored, restored, databasePath: dbPath });
  } catch (error) {
    res.status(500).json({ error: { message: (error as Error).message } });
  }
});
