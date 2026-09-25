import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const tempDirs: string[] = [];

function restoreEnv() {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}

describe('initEncryptionKey — key file (dev fallback)', () => {
  beforeEach(() => {
    restoreEnv();
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    restoreEnv();
  });

  it('generates or loads a dev key file when ENCRYPTION_KEY is unset in test mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-keyfile-'));
    tempDirs.push(dir);

    // Run init
    expect(() => initEncryptionKey()).not.toThrow();

    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('prefers the ENCRYPTION_KEY env over fallback', () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initEncryptionKey();
    const encUnderEnv = encrypt('x');
    expect(decrypt(encUnderEnv.encrypted, encUnderEnv.iv, encUnderEnv.authTag)).toBe('x');
  });
});
