import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  assertBackupPathAllowed,
  createBackup,
  deleteBackup,
  getBackupFile,
  listBackups,
  listTables,
  readBackupSchedule,
  restoreBackup,
  writeBackupSchedule,
  type BackupSchedule,
} from '../services/backups.js';

export const backupsRouter = Router();

const createSchema = z.object({
  tables: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
}).strict();

const scheduleSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm'),
  intervalDays: z.number().int().min(1).max(365),
  backupPath: z.string().max(2000),
}).strict();

function parseSchedule(body: unknown): { schedule?: BackupSchedule; error?: string } {
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) {
    return { error: parsed.error.errors.map((e) => e.message).join(', ') };
  }
  return { schedule: { ...parsed.data, backupPath: parsed.data.backupPath.trim() } };
}

/** Route params are strings; only a bare run of digits is a backup id. A
 *  permissive parseInt would accept "12/../../etc" and quietly read 12. */
function parseId(raw: unknown): number | null {
  const value = String(raw ?? '');
  if (!/^\d+$/.test(value)) return null;
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) ? id : null;
}

function fail(res: Response, err: unknown, fallbackStatus: number, fallbackMessage: string): void {
  const status = (err as { status?: number }).status ?? fallbackStatus;
  res.status(status).json({ error: { message: err instanceof Error ? err.message : fallbackMessage } });
}

backupsRouter.get('/tables', (_req: Request, res: Response) => {
  res.json({ tables: listTables(getDb()) });
});

backupsRouter.get('/schedule', (_req: Request, res: Response) => {
  res.json({ schedule: readBackupSchedule() });
});

backupsRouter.put('/schedule', (req: Request, res: Response) => {
  const { schedule, error } = parseSchedule(req.body);
  if (error || !schedule) {
    res.status(400).json({ error: { message: error ?? 'Invalid schedule' } });
    return;
  }
  try {
    // Reject a directory the writer would refuse later, while the operator is
    // still looking at the field they typed it into.
    assertBackupPathAllowed(getDb(), schedule.backupPath);
  } catch (err) {
    fail(res, err, 400, 'Invalid backup path');
    return;
  }
  res.json({ schedule: writeBackupSchedule(schedule) });
});

backupsRouter.get('/', (req: Request, res: Response) => {
  const page = Number.parseInt(String(req.query.page ?? '1'), 10) || 1;
  const pageSize = Number.parseInt(String(req.query.pageSize ?? '20'), 10) || 20;
  res.json(listBackups(getDb(), { page, pageSize }));
});

backupsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map((e) => e.message).join(', ') } });
    return;
  }
  try {
    const backup = createBackup(getDb(), { tables: parsed.data.tables ?? [], source: 'manual' });
    res.status(201).json({ backup });
  } catch (err) {
    fail(res, err, 500, 'Backup failed');
  }
});

backupsRouter.get('/:id/download', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid backup ID' } });
    return;
  }
  try {
    const file = getBackupFile(getDb(), id);
    res.download(file.path, file.filename);
  } catch (err) {
    fail(res, err, 404, 'Download failed');
  }
});

backupsRouter.post('/:id/restore', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid backup ID' } });
    return;
  }
  try {
    const { backup, snapshot } = restoreBackup(getDb(), id);
    res.json({ success: true, backup, snapshot });
  } catch (err) {
    fail(res, err, 400, 'Restore failed');
  }
});

backupsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: { message: 'Invalid backup ID' } });
    return;
  }
  try {
    deleteBackup(getDb(), id);
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 400, 'Delete failed');
  }
});
