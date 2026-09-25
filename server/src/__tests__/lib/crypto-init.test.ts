import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function restoreEnv() {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  }
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
    expect(() => initEncryptionKey()).not.toThrow();
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key (typo guard)', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    expect(() => initEncryptionKey()).toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    expect(() => initEncryptionKey()).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64);
    expect(() => initEncryptionKey()).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('requires ENCRYPTION_KEY in production when placeholder or missing', () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    process.env.NODE_ENV = 'production';
    expect(() => initEncryptionKey()).toThrow(/ENCRYPTION_KEY is required in production/);
  });
});
