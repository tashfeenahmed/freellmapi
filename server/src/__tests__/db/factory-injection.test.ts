import { describe, it, expect, vi } from 'vitest';
import { connectDb } from '../../db/index.js';
import type { Db, DbFactory } from '../../db/types.js';

// A minimal in-memory stub that satisfies the Db interface.
function makeStubDb(): Db {
  const store = new Map<string, unknown>();
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn().mockReturnValue({ changes: 0 }),
    }),
    exec: vi.fn(),
    transaction: vi.fn().mockImplementation((fn) => fn),
    pragma: vi.fn(),
  };
}

describe('connectDb — factory injection', () => {
  it('calls the injected factory instead of opening a filesystem path', () => {
    const stub = makeStubDb();
    const factory: DbFactory = vi.fn().mockReturnValue(stub);

    const result = connectDb('/fake/non-existent/path.db', { factory, ensureDir: false });

    expect(factory).toHaveBeenCalledWith('/fake/non-existent/path.db');
    expect(result).toBe(stub);
  });

  it('does not touch the filesystem when an in-memory stub factory is supplied', () => {
    const stub = makeStubDb();
    const factory: DbFactory = () => stub;

    // ensureDir: false skips mkdirSync so the fake path never hits the filesystem.
    expect(() => connectDb('/definitely/does/not/exist/db.sqlite', { factory, ensureDir: false })).not.toThrow();
  });
});
