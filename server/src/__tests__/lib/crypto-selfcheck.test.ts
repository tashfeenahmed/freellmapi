import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initEncryptionKey, encrypt, probeStoredSecrets } from '../../lib/crypto.js';

// A key file that exists but no longer matches the stored ciphertext used to be
// invisible: every api_keys row failed GCM authentication, so the health checks
// reported one provider after another as broken and nothing named the key file.
// probeStoredSecrets() answers that question once, at boot.
//
// Real file-backed DBs (db.memory === false) so the key-file branch runs.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const openDbs: Database.Database[] = [];
const tempDirs: string[] = [];

function fileDb(withApiKeys = true): { db: Database.Database; keyFile: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-selfcheck-'));
  tempDirs.push(dir);
  const db = new Database(path.join(dir, 'freeapi.db'));
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (withApiKeys) {
    db.exec(`
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL
      )
    `);
  }
  openDbs.push(db);
  return { db, keyFile: path.join(dir, '.encryption-key'), dir };
}

function insertSecret(db: Database.Database, value = 'sk-test'): void {
  const secret = encrypt(value);
  db.prepare('INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?)')
    .run('groq', secret.encrypted, secret.iv, secret.authTag);
}

describe('probeStoredSecrets', () => {
  beforeEach(() => {
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    while (openDbs.length) openDbs.pop()!.close();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  });

  it('returns true when the loaded key opens a stored secret', () => {
    const { db } = fileDb();
    initEncryptionKey(db);
    insertSecret(db);

    expect(probeStoredSecrets(db)).toBe(true);
  });

  it('returns false when the key file no longer matches the stored ciphertext', () => {
    const { db, keyFile } = fileDb();
    initEncryptionKey(db);
    insertSecret(db);
    expect(probeStoredSecrets(db)).toBe(true);

    // Simulate the portable-appdata failure: the database survived, the key file
    // was replaced by the one from another install.
    fs.writeFileSync(keyFile, 'a'.repeat(64));
    initEncryptionKey(db);

    expect(probeStoredSecrets(db)).toBe(false);
  });

  it('returns null when there is nothing to decrypt', () => {
    const { db } = fileDb();
    initEncryptionKey(db);

    expect(probeStoredSecrets(db)).toBeNull();
  });

  it('returns null when the database has no api_keys table yet', () => {
    const { db } = fileDb(false);
    initEncryptionKey(db);

    expect(probeStoredSecrets(db)).toBeNull();
  });
});
