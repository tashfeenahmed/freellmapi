import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/index.js';
import {
  createBackup,
  getAutoDumpRetention,
  pruneAutoDumps,
} from '../../services/backups.js';

// #1675: automatic dumps (scheduled + the desktop updater's pre-update
// snapshot) used to pile up forever. Manual and pre-restore dumps are never
// auto-deleted.
const ORIGINAL_KEEP = process.env.AUTO_BACKUP_DUMP_RETENTION;

function restoreEnv() {
  if (ORIGINAL_KEEP === undefined) delete process.env.AUTO_BACKUP_DUMP_RETENTION;
  else process.env.AUTO_BACKUP_DUMP_RETENTION = ORIGINAL_KEEP;
}

function fileOf(id: number): string {
  return (getDb().prepare('SELECT filepath FROM backups WHERE id = ?').get(id) as { filepath: string }).filepath;
}

describe('auto backup dump retention (#1675)', () => {
  let dataDir = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-autodump-'));
    process.env.FREEAPI_DB_PATH = path.join(dataDir, 'freeapi.db');
    initDb(':memory:');
  });

  afterAll(() => {
    delete process.env.FREEAPI_DB_PATH;
    restoreEnv();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM backups').run();
  });

  afterEach(restoreEnv);

  it('defaults to keeping 10 auto dumps and honours valid env overrides', () => {
    delete process.env.AUTO_BACKUP_DUMP_RETENTION;
    expect(getAutoDumpRetention()).toBe(10);
    process.env.AUTO_BACKUP_DUMP_RETENTION = '3';
    expect(getAutoDumpRetention()).toBe(3);
    process.env.AUTO_BACKUP_DUMP_RETENTION = '0';
    expect(getAutoDumpRetention()).toBe(0);
    process.env.AUTO_BACKUP_DUMP_RETENTION = 'nope';
    expect(getAutoDumpRetention()).toBe(10);
    process.env.AUTO_BACKUP_DUMP_RETENTION = '-2';
    expect(getAutoDumpRetention()).toBe(10);
  });

  it('prunes old scheduled/pre-update dumps and unlinks their files, keeping the newest', () => {
    // Sweep disabled while writing, so all four dumps exist before the prune.
    process.env.AUTO_BACKUP_DUMP_RETENTION = '0';
    const auto = [
      createBackup(getDb(), { source: 'scheduled' }),
      createBackup(getDb(), { source: 'pre-update' }),
      createBackup(getDb(), { source: 'scheduled' }),
      createBackup(getDb(), { source: 'pre-update' }),
    ];
    // 4 auto dumps, keep 2: the two newest survive, the two oldest go.
    const paths = auto.map((b) => fileOf(b.id));
    process.env.AUTO_BACKUP_DUMP_RETENTION = '2';
    const deleted = pruneAutoDumps(getDb());
    expect(deleted).toBe(2);
    const remaining = (getDb().prepare('SELECT id FROM backups ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    expect(remaining).toEqual([auto[2].id, auto[3].id]);
    expect(fs.existsSync(paths[0])).toBe(false);
    expect(fs.existsSync(paths[1])).toBe(false);
    expect(fs.existsSync(paths[2])).toBe(true);
  });

  it('never deletes manual or pre-restore dumps', () => {
    process.env.AUTO_BACKUP_DUMP_RETENTION = '0';
    const manual = createBackup(getDb(), { source: 'manual' });
    const preRestore = createBackup(getDb(), { source: 'pre-restore' });
    const scheduled = createBackup(getDb(), { source: 'scheduled' });
    // Turn the knob on after the fact: the auto one is the only candidate.
    process.env.AUTO_BACKUP_DUMP_RETENTION = '0';
    expect(pruneAutoDumps(getDb(), 0)).toBe(0);
    process.env.AUTO_BACKUP_DUMP_RETENTION = '5';
    expect(pruneAutoDumps(getDb())).toBe(0); // only 1 auto dump, under the bound
    expect(fs.existsSync(fileOf(manual.id))).toBe(true);
    expect(fs.existsSync(fileOf(preRestore.id))).toBe(true);
    // And a keep of 1 still spares both non-auto dumps while the single auto
    // dump is the newest auto row.
    const scheduledFile = fileOf(scheduled.id);
    const second = createBackup(getDb(), { source: 'pre-update' });
    expect(pruneAutoDumps(getDb(), 1)).toBe(1); // the older auto dump goes
    const remaining = (getDb().prepare('SELECT id FROM backups ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    expect(remaining).toEqual([manual.id, preRestore.id, second.id]);
    expect(fs.existsSync(scheduledFile)).toBe(false);
  });

  it('createBackup sweeps automatically once the bound is exceeded', () => {
    process.env.AUTO_BACKUP_DUMP_RETENTION = '2';
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(createBackup(getDb(), { source: 'pre-update' }).id);
    const remaining = (getDb().prepare('SELECT id FROM backups ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    expect(remaining).toEqual(ids.slice(3));
  });
});
