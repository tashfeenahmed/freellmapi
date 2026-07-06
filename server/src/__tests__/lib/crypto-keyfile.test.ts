import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

// FIX 2: the dev-fallback key is persisted to a file next to the DB, not into
// the `settings` table it protects. These tests use REAL file-backed DBs
// (db.memory === false) so the file branch runs; the in-memory settings-table
// behavior is covered by crypto-init.test.ts.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const openDbs: Database.Database[] = [];
const tempDirs: string[] = [];

function fileDb(): { db: Database.Database; keyFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-keyfile-'));
  tempDirs.push(dir);
  const db = new Database(path.join(dir, 'freeapi.db'));
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  openDbs.push(db);
  return { db, keyFile: path.join(dir, '.encryption-key') };
}

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
    while (openDbs.length) openDbs.pop()!.close();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    restoreEnv();
  });

  it('generates a fresh key into a file next to the DB, not the settings table', () => {
    const { db, keyFile } = fileDb();

    initEncryptionKey(db);

    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.readFileSync(keyFile, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    // The key must NOT be stored in the DB it protects.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get()).toBeUndefined();
    // The generated key actually works.
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');

    if (process.platform !== 'win32') {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }
  });

  it('reuses an existing key file on the next boot', () => {
    const { db, keyFile } = fileDb();
    initEncryptionKey(db);
    const firstKey = fs.readFileSync(keyFile, 'utf8').trim();
    const enc = encrypt('provider-secret');

    // Second boot (fresh module state simulated by calling init again).
    initEncryptionKey(db);
    expect(fs.readFileSync(keyFile, 'utf8').trim()).toBe(firstKey);
    // Ciphertext from the first boot still decrypts under the reused key.
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('provider-secret');
  });

  it('migrates a legacy settings-table key to the file and still decrypts', () => {
    const K = 'd'.repeat(64);
    // Encrypt a secret under K via the env path (how an old install's data was
    // written), then simulate that install: key in settings, no env, no file.
    process.env.ENCRYPTION_KEY = K;
    const { db, keyFile } = fileDb();
    initEncryptionKey(db);
    const secret = 'sk-legacy-secret';
    const ciphertext = encrypt(secret);

    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(K);
    expect(fs.existsSync(keyFile)).toBe(false);

    initEncryptionKey(db);

    // Key moved to the file, with the same bytes.
    expect(fs.readFileSync(keyFile, 'utf8').trim()).toBe(K);
    // And removed from the DB.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get()).toBeUndefined();
    // Existing ciphertext still decrypts seamlessly.
    expect(decrypt(ciphertext.encrypted, ciphertext.iv, ciphertext.authTag)).toBe(secret);
  });

  it('prefers the ENCRYPTION_KEY env over an existing key file', () => {
    const { db, keyFile } = fileDb();
    fs.writeFileSync(keyFile, 'a'.repeat(64));

    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initEncryptionKey(db);
    const encUnderEnv = encrypt('x');

    // The file was not consulted and is left untouched.
    expect(fs.readFileSync(keyFile, 'utf8').trim()).toBe('a'.repeat(64));

    // Prove env != file: re-init without env now loads the (different) file key,
    // so ciphertext produced under the env key can no longer be decrypted.
    delete process.env.ENCRYPTION_KEY;
    initEncryptionKey(db);
    expect(() => decrypt(encUnderEnv.encrypted, encUnderEnv.iv, encUnderEnv.authTag)).toThrow();
  });
});
