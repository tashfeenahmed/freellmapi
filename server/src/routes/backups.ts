import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
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

backupsRouter.get('/tables', async (_req: Request, res: Response) => {
  res.json({ tables: await listTables() });
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
  res.json({ schedule: writeBackupSchedule(schedule) });
});

backupsRouter.get('/', (req: Request, res: Response) => {
  const page = Number.parseInt(String(req.query.page ?? '1'), 10) || 1;
  const pageSize = Number.parseInt(String(req.query.pageSize ?? '20'), 10) || 20;
  res.json(listBackups(getDb(), { page, pageSize }));
});

backupsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map((e) => e.message).join(', ') } });
    return;
  }
  try {
    const backup = await createBackup(getDb(), { tables: parsed.data.tables ?? [], source: 'manual' });
    res.status(201).json({ backup });
  } catch (err) {
    res.status(500).json({ error: { message: err instanceof Error ? err.message : 'Backup failed' } });
  }
});

backupsRouter.get('/:id/download', (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid backup ID' } });
    return;
  }
  try {
    const file = getBackupFile(getDb(), id);
    res.download(file.path, file.filename);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 404;
    res.status(status).json({ error: { message: err instanceof Error ? err.message : 'Download failed' } });
  }
});

backupsRouter.post('/:id/restore', async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid backup ID' } });
    return;
  }
  try {
    const backup = await restoreBackup(getDb(), id);
    res.json({ success: true, backup });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    res.status(status).json({ error: { message: err instanceof Error ? err.message : 'Restore failed' } });
  }
});

backupsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid backup ID' } });
    return;
  }
  try {
    deleteBackup(getDb(), id);
    res.json({ success: true });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 400;
    res.status(status).json({ error: { message: err instanceof Error ? err.message : 'Delete failed' } });
  }
});
