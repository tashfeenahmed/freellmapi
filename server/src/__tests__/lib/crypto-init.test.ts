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

  it('auto-generates and persists a key outside production when ENCRYPTION_KEY is unset', () => {
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loads an existing DB-stored fallback key outside production', () => {
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).not.toThrow();
    // The existing key is reused, not overwritten.
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toBe('b'.repeat(64));
  });

  it('requires ENCRYPTION_KEY in production and never persists a fallback key', () => {
    process.env.NODE_ENV = 'production';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/ENCRYPTION_KEY is required/);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get();
    expect(row).toBeUndefined();
  });

  it('does not load a DB-stored fallback key in production', () => {
    process.env.NODE_ENV = 'production';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).toThrow(/ENCRYPTION_KEY is required/);
  });

  it('treats the placeholder as "not set" and auto-generates outside production', () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key', () => {
    process.env.NODE_ENV = 'test';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('not-hex');
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });
});
