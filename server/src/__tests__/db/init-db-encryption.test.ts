import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

let tempDir: string | undefined;

function restoreEnv() {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;

  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}

describe('initDb encryption bootstrapping', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-db-'));
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
  });

  afterEach(() => {
    restoreEnv();
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('loads the encryption key on dev boot when migrations are already applied', async () => {
    const dbPath = path.join(tempDir!, 'freeapi.db');

    process.env.NODE_ENV = 'test';
    vi.resetModules();
    const firstDbModule = await import('../../db/index.js');
    const firstCryptoModule = await import('../../lib/crypto.js');
    const firstDb = firstDbModule.initDb(dbPath);
    const encrypted = firstCryptoModule.encrypt('provider-secret');
    firstDb.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'Google', ?, ?, ?, 'healthy', 1)
    `).run(encrypted.encrypted, encrypted.iv, encrypted.authTag);
    firstDb.close();

    process.env.NODE_ENV = 'development';
    vi.resetModules();
    const secondDbModule = await import('../../db/index.js');
    const secondCryptoModule = await import('../../lib/crypto.js');
    const secondDb = secondDbModule.initDb(dbPath);
    const row = secondDb.prepare(`
      SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'google'
    `).get() as { encrypted_key: string; iv: string; auth_tag: string };

    expect(secondCryptoModule.decrypt(row.encrypted_key, row.iv, row.auth_tag)).toBe('provider-secret');
    secondDb.close();
  });
});
