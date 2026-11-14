import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb, getSetting } from '../../db/index.js';
import { startBackupScheduler, writeBackupSchedule } from '../../services/backups.js';
import type { Scheduler } from '../../lib/scheduler.js';

// M39: the schedule's time is the operator's local hh:mm, but the "already ran
// today" day was the UTC date. East of UTC the UTC date rolls over a few hours
// into the local day, so one local day got two scheduled backups.
const previousTz = process.env.TZ;
let dataDir = '';

beforeAll(() => {
  process.env.TZ = 'Asia/Riyadh'; // UTC+3, no DST
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backup-sched-'));
  process.env.FREEAPI_DB_PATH = path.join(dataDir, 'freeapi.db');
  initDb(':memory:');
});

afterAll(() => {
  vi.useRealTimers();
  if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const scheduledCount = () =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM backups WHERE source = 'scheduled'").get() as { n: number }).n;

it('runs once per local day, keyed by the local date', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  writeBackupSchedule({ enabled: true, time: '02:00', intervalDays: 1, backupPath: dataDir });
  const ticks: Array<() => void | Promise<void>> = [];
  const scheduler: Scheduler = {
    every: (_ms, fn) => { ticks.push(fn); return () => {}; },
    after: () => () => {},
  };

  // 01:30 local on the 14th: before the scheduled time.
  vi.setSystemTime(new Date('2026-11-13T22:30:00Z'));
  startBackupScheduler(scheduler);
  expect(scheduledCount()).toBe(0);

  // 02:30 local on the 14th (still the 13th in UTC): due.
  vi.setSystemTime(new Date('2026-11-13T23:30:00Z'));
  void ticks[0]!();
  expect(scheduledCount()).toBe(1);
  expect(getSetting('backup_last_run_day')).toBe('2026-11-14');

  // 03:30 local, same local day, but the UTC date has just rolled over.
  vi.setSystemTime(new Date('2026-11-14T00:30:00Z'));
  void ticks[0]!();
  expect(scheduledCount()).toBe(1);

  // 02:30 local on the 15th: the next day's run.
  vi.setSystemTime(new Date('2026-11-14T23:30:00Z'));
  void ticks[0]!();
  expect(scheduledCount()).toBe(2);
  expect(getSetting('backup_last_run_day')).toBe('2026-11-15');
});
