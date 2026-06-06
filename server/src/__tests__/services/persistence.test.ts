import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { restoreDatabaseBeforeBoot } from '../../storage/persistence.js';
import * as b2 from '../../storage/b2.js';

vi.mock('fs');
vi.mock('../../storage/b2.js');

describe('Persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DATABASE_PATH = '/tmp/test.sqlite';
    process.env.B2_ENDPOINT = 'http://test';
    process.env.B2_BUCKET = 'bucket';
    process.env.B2_KEY_ID = 'key';
    process.env.B2_APPLICATION_KEY = 'secret';
  });

  it('skips restore if local DB exists and size > 0', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 } as any);

    await restoreDatabaseBeforeBoot();

    expect(b2.downloadDbSnapshot).not.toHaveBeenCalled();
  });

  it('attempts restore if local DB exists but size is 0', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 0 } as any);
    vi.spyOn(b2, 'downloadDbSnapshot').mockResolvedValue(true);

    await restoreDatabaseBeforeBoot();

    expect(b2.downloadDbSnapshot).toHaveBeenCalled();
  });

  it('attempts restore if local DB does not exist', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(b2, 'downloadDbSnapshot').mockResolvedValue(true);

    await restoreDatabaseBeforeBoot();

    expect(b2.downloadDbSnapshot).toHaveBeenCalled();
  });
});
