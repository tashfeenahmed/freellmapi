import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  PERSIST_MAX_PER_SECOND,
  initServerLogs,
  recordLogEntry,
  resetServerLogsForTest,
  ringSnapshot,
} from '../../lib/server-logs.js';

function rows(): Array<{ id: number; message: string }> {
  return getDb().prepare('SELECT id, message FROM server_logs ORDER BY id').all() as Array<{ id: number; message: string }>;
}

describe('server_logs persist rate cap', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM server_logs').run();
    resetServerLogsForTest();
    initServerLogs();
  });

  it('persists at most PERSIST_MAX_PER_SECOND rows per second, then one summary row', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 200; i++) recordLogEntry({ level: 'error', message: `storm ${i}`, tsMs: t0 + i });
    expect(rows()).toHaveLength(PERSIST_MAX_PER_SECOND);
    // Every line still reached the live view.
    expect(ringSnapshot().filter(e => e.message.startsWith('storm'))).toHaveLength(200);

    recordLogEntry({ level: 'warn', message: 'after the storm', tsMs: t0 + 1500 });
    const all = rows();
    expect(all).toHaveLength(PERSIST_MAX_PER_SECOND + 2);
    expect(all[all.length - 2]!.message).toContain(`${200 - PERSIST_MAX_PER_SECOND} warn/error lines not persisted`);
    expect(all[all.length - 1]!.message).toBe('after the storm');

    // Ids in the ring stay strictly increasing (the dashboard's sinceId cursor relies on it).
    const ids = ringSnapshot().map(e => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not cap a normal rate, and info lines never count', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 1000; i++) recordLogEntry({ level: 'info', message: `info ${i}`, tsMs: t0 });
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 10; i++) recordLogEntry({ level: 'warn', message: `w ${s}.${i}`, tsMs: t0 + s * 1000 + i });
    }
    expect(rows()).toHaveLength(50);
    expect(rows().some(r => r.message.includes('not persisted'))).toBe(false);
  });
});
