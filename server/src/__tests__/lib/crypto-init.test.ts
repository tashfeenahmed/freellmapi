import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return db;
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.DEV_MODE;
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

describe('initEncryptionKey — input validation', () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('accepts a valid 64-char hex env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    // Round-trip a value to confirm the key actually works.
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key (typo guard)', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64); // g is not hex
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('requires ENCRYPTION_KEY when dev fallback is not explicitly enabled', () => {
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/ENCRYPTION_KEY is required/);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get();
    expect(row).toBeUndefined();
  });

  it('does not load a DB-stored fallback key when dev fallback is disabled', () => {
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).toThrow(/ENCRYPTION_KEY is required/);
  });

  it('requires ENCRYPTION_KEY in production even when DEV_MODE is set', () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'production';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/ENCRYPTION_KEY is required/);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get();
    expect(row).toBeUndefined();
  });

  it('still treats the placeholder as "not set" and allows explicit dev fallback generation', () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key', () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('not-hex');
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });

  it('generates a fresh key on a virgin DB and persists it only in explicit dev fallback mode', () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    initEncryptionKey(db);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });
});
