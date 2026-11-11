import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, getSetting, initDb, setSetting } from '../../db/index.js';
import { NodeScheduler } from '../../lib/scheduler.js';
import { startBackupScheduler, writeBackupSchedule } from '../../services/backups.js';

// #1888: the scheduler compared the configured HH:MM to local time but stamped
// backup_last_run_day with the UTC date, so a non-UTC host ran at the local
// hour UTC midnight crossed — and twice on the first day.
const LAST_RUN_SETTING = 'backup_last_run_day';
const ORIGINAL_TZ = process.env.TZ;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function useTz(tz: string): void {
  process.env.TZ = tz;
}

function restoreTz(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

/** Local hour of 15:00 UTC must match the zone under test, or a missed TZ
 *  assignment would fail for a different reason than #1888. */
function expectOffsetHours(hoursFromUtc: number): void {
  const probe = new Date(Date.UTC(2026, 10, 10, 15, 0, 0));
  expect(probe.getHours()).toBe((15 + hoursFromUtc + 24) % 24);
}

function scheduledRuns(): string[] {
  const rows = getDb().prepare(
    "SELECT created_at FROM backups WHERE source = 'scheduled' ORDER BY id",
  ).all() as { created_at: string }[];
  return rows.map((row) => localStamp(new Date(row.created_at)));
}

/** Walk the real 60s scheduler from local 2026-11-10 00:00 across `days`
 *  midnights, one minute per tick — the same step the bug was reported with. */
function stepLocalDays(days: number): { runs: string[]; lastRunDay: string | undefined } {
  const start = new Date(2026, 10, 10, 0, 0, 0);
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const stop = startBackupScheduler(new NodeScheduler());
  try {
    for (let minute = 0; minute < days * 24 * 60; minute++) {
      vi.advanceTimersByTime(60_000);
    }
  } finally {
    stop();
    vi.useRealTimers();
  }
  return { runs: scheduledRuns(), lastRunDay: getSetting(LAST_RUN_SETTING) };
}

describe('backup scheduler local day (#1888)', () => {
  let dataDir = '';
  let loggedErrors: unknown[][] = [];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backup-day-'));
    process.env.FREEAPI_DB_PATH = path.join(dataDir, 'freeapi.db');
    initDb(':memory:');
  });

  afterAll(() => {
    restoreTz();
    delete process.env.FREEAPI_DB_PATH;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    loggedErrors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      loggedErrors.push(args);
    });
    getDb().prepare('DELETE FROM backups').run();
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(LAST_RUN_SETTING);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreTz();
  });

  it('runs once per local day at 03:00 in America/Argentina/Buenos_Aires', () => {
    useTz('America/Argentina/Buenos_Aires');
    expectOffsetHours(-3);
    writeBackupSchedule({ enabled: true, time: '03:00', intervalDays: 1, backupPath: '' });

    const observed = stepLocalDays(3);

    expect(loggedErrors).toEqual([]);
    // 21:00 is UTC midnight in this zone. The UTC day key fires there, and
    // again at 03:00 on day one.
    expect(observed).toEqual({
      runs: ['2026-11-10 03:00', '2026-11-11 03:00', '2026-11-12 03:00'],
      lastRunDay: '2026-11-12',
    });
  });

  it('runs once per local day at 08:00 in a UTC+9 zone', () => {
    useTz('Asia/Tokyo');
    expectOffsetHours(9);
    writeBackupSchedule({ enabled: true, time: '08:00', intervalDays: 1, backupPath: '' });

    const observed = stepLocalDays(3);

    expect(loggedErrors).toEqual([]);
    // 09:00 is UTC midnight here, one hour after the configured 08:00, so day
    // one runs at both and later days run at 09:00.
    expect(observed).toEqual({
      runs: ['2026-11-10 08:00', '2026-11-11 08:00', '2026-11-12 08:00'],
      lastRunDay: '2026-11-12',
    });
  });

  it('spaces runs by intervalDays on the local calendar', () => {
    useTz('America/Argentina/Buenos_Aires');
    expectOffsetHours(-3);
    writeBackupSchedule({ enabled: true, time: '03:00', intervalDays: 2, backupPath: '' });

    const observed = stepLocalDays(5);

    expect(loggedErrors).toEqual([]);
    expect(observed).toEqual({
      runs: ['2026-11-10 03:00', '2026-11-12 03:00', '2026-11-14 03:00'],
      lastRunDay: '2026-11-14',
    });
  });

  it('honors an existing backup_last_run_day value for the local calendar', () => {
    useTz('America/Argentina/Buenos_Aires');
    expectOffsetHours(-3);
    writeBackupSchedule({ enabled: true, time: '03:00', intervalDays: 1, backupPath: '' });
    // Same YYYY-MM-DD the scheduler already persists. Stored before this
    // process starts, so a same-local-day tick must not run again.
    setSetting(LAST_RUN_SETTING, '2026-11-10');

    const observed = stepLocalDays(3);

    expect(loggedErrors).toEqual([]);
    expect(observed).toEqual({
      runs: ['2026-11-11 03:00', '2026-11-12 03:00'],
      lastRunDay: '2026-11-12',
    });
  });
});
