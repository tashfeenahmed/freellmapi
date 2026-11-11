import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/index.js';
import { startBackupScheduler, writeBackupSchedule } from '../../services/backups.js';
import type { Scheduler } from '../../lib/scheduler.js';

// #1888: the schedule time is local wall clock, but the scheduler used to
// derive the day it gated on from the UTC date. Whenever UTC midnight fell
// after the configured time within the local day, the backup ran again at the
// local hour UTC midnight passed — and from then on at that hour, not the one
// the operator picked. Negative offsets lost the configured hour entirely.

const MINUTE = 60_000;
const ORIGINAL_TZ = process.env.TZ;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A Scheduler that hands back its registered tick so the test can step the
 *  clock one minute at a time, the way the reporter did. */
function captureTicks(): { scheduler: Scheduler; tick: () => void } {
  const ticks: (() => void)[] = [];
  return {
    tick: () => ticks[0](),
    scheduler: {
      every: (_ms, fn) => {
        ticks.push(() => { void fn(); });
        return () => {};
      },
      after: () => () => {},
    },
  };
}

function scheduledRuns(): string[] {
  const rows = getDb().prepare(
    "SELECT created_at FROM backups WHERE source = 'scheduled' ORDER BY id",
  ).all() as { created_at: string }[];
  return rows.map((row) => localStamp(row.created_at));
}

/** Step the fake clock from `start` for `days` local days, one tick a minute. */
function runMinutes(start: Date, days: number, tick: () => void): void {
  for (let minute = 1; minute <= days * 24 * 60; minute++) {
    vi.setSystemTime(start.getTime() + minute * MINUTE);
    tick();
  }
}

describe('scheduled backups follow the local clock (#1888)', () => {
  let dataDir = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backup-tz-'));
    process.env.FREEAPI_DB_PATH = path.join(dataDir, 'freeapi.db');
    initDb(':memory:');
  });

  afterAll(() => {
    delete process.env.FREEAPI_DB_PATH;
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM backups').run();
    getDb().prepare("DELETE FROM settings WHERE key = 'backup_last_run_day'").run();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once per local day at the configured time in a negative-offset zone', () => {
    // UTC-3: the reporter's zone, where 03:00 local is 06:00 UTC and UTC
    // midnight lands at 21:00 local.
    process.env.TZ = 'America/Argentina/Buenos_Aires';
    writeBackupSchedule({ enabled: true, time: '03:00', intervalDays: 1, backupPath: '' });

    const start = new Date(2026, 10, 10, 0, 0, 0);
    vi.setSystemTime(start);
    const { scheduler, tick } = captureTicks();
    const stop = startBackupScheduler(scheduler);
    runMinutes(start, 3, tick);
    stop();

    expect(scheduledRuns()).toEqual([
      '2026-11-10 03:00',
      '2026-11-11 03:00',
      '2026-11-12 03:00',
    ]);
  });

  it('runs once per local interval at the configured time in a positive-offset zone', () => {
    // UTC+9, 08:00 local = 23:00 UTC: the configured time is earlier than the
    // local hour of UTC midnight, the other shape of the same bug.
    process.env.TZ = 'Asia/Tokyo';
    writeBackupSchedule({ enabled: true, time: '08:00', intervalDays: 2, backupPath: '' });

    const start = new Date(2026, 10, 10, 0, 0, 0);
    vi.setSystemTime(start);
    const { scheduler, tick } = captureTicks();
    const stop = startBackupScheduler(scheduler);
    runMinutes(start, 6, tick);
    stop();

    expect(scheduledRuns()).toEqual([
      '2026-11-10 08:00',
      '2026-11-12 08:00',
      '2026-11-14 08:00',
    ]);
  });
});
