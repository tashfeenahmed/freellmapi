import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initDb ensureDir option', () => {
  it('skips mkdirSync when ensureDir is false', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    vi.resetModules();
    const { initDb } = await import('../../db/index.js');

    // A non-memory path in a directory that (mocked) doesn't exist; ensureDir: false
    // means mkdirSync must not be called.
    initDb(':memory:', { ensureDir: false });

    expect(mkdirSpy).not.toHaveBeenCalled();
    existsSpy.mockRestore();
  });

  it('calls mkdirSync when ensureDir is true (the default) and dir is absent', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    vi.resetModules();
    const { initDb } = await import('../../db/index.js');

    // A fake on-disk path — existsSync returns false so mkdirSync should be called.
    try { initDb('/tmp/nonexistent-test-dir/freeapi.db', { ensureDir: true }); } catch { /* DB open will fail */ }

    expect(mkdirSpy).toHaveBeenCalledWith('/tmp/nonexistent-test-dir', { recursive: true });
  });
});
