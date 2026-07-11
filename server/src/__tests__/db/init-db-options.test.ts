import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initDb ensureDir option', () => {
  it('skips mkdirSync when ensureDir is false', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');

    vi.resetModules();
    const { initDb } = await import('../../db/index.js');

    // A non-memory path in a directory that (mocked) doesn't exist; ensureDir:
    // false means initDb must not check or create the parent directory.
    const dbPath = path.join('/tmp', `freeapi-missing-${Date.now()}-${Math.random()}`, 'freeapi.db');
    try { initDb(dbPath, { ensureDir: false }); } catch { /* DB open will fail */ }

    expect(mkdirSpy).not.toHaveBeenCalled();
  });

  it('calls mkdirSync when ensureDir is true (the default) and dir is absent', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    vi.resetModules();
    const { initDb } = await import('../../db/index.js');

    // A fake on-disk path — existsSync returns false so mkdirSync should be called.
    const dir = path.join('/tmp', `freeapi-missing-${Date.now()}-${Math.random()}`);
    const dbPath = path.join(dir, 'freeapi.db');
    try { initDb(dbPath, { ensureDir: true }); } catch { /* DB open will fail */ }

    expect(mkdirSpy).toHaveBeenCalledWith(dir, { recursive: true });
  });
});
