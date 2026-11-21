import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from '../../db/index.js';
import { encryptWith, decryptWith } from '../../scripts/rotate-encryption-key.js';

// End-to-end coverage for the CLI itself, not just the exported helpers. The
// script is an ESM module (server/package.json is "type": "module"), so a
// stray `require()` in main() throws "require is not defined in ES module
// scope" the moment `npm run rotate-encryption-key` is invoked — a failure the
// unit tests cannot see, because they import rotateSecrets() directly. Only
// actually running the script catches it.

const require_ = createRequire(import.meta.url);
const TSX_CLI = path.join(path.dirname(require_.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const SCRIPT = fileURLToPath(new URL('../../scripts/rotate-encryption-key.ts', import.meta.url));

const OLD_HEX = 'a'.repeat(64);
const NEW_HEX = 'b'.repeat(64);
const OLD_KEY = Buffer.from(OLD_HEX, 'hex');
const NEW_KEY = Buffer.from(NEW_HEX, 'hex');

const API_KEY_SECRET = 'sk-live-rotate-me';
const PROFILE_SECRET = 'cp-live-rotate-me';
const RELAY_TOKEN = 'relay-bearer-rotate-me';

let tmpDir: string;
let dbPath: string;

/** A real on-disk DB with the production schema, seeded under the OLD key. */
function seedTempDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-cli-'));
  dbPath = path.join(tmpDir, 'freeapi.db');

  // Set before initDb so crypto.ts takes the env key and never writes a
  // .encryption-key file next to the temp DB.
  process.env.ENCRYPTION_KEY = OLD_HEX;
  const db = initDb(dbPath);

  const keyEnc = encryptWith(OLD_KEY, API_KEY_SECRET);
  db.prepare('INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES (?,?,?,?,?,?)')
    .run('openai', keyEnc.encrypted, keyEnc.iv, keyEnc.authTag, 'unknown', 1);

  const profileEnc = encryptWith(OLD_KEY, PROFILE_SECRET);
  db.prepare('INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled) VALUES (?,?,?,?,?,?)')
    .run('claude', 'hash-cli', profileEnc.encrypted, profileEnc.iv, profileEnc.authTag, 1);

  // Same encoding encodeFetchRelayToken() writes: JSON.stringify(encrypt(v)).
  const relayEnc = encryptWith(OLD_KEY, RELAY_TOKEN);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('fetch_relay_token', JSON.stringify(relayEnc));

  db.close?.();
}

/** Read every seeded ciphertext straight out of the file, no server involved. */
function readSecrets(): { key: [string, string, string]; profile: [string, string, string]; relay: [string, string, string] } {
  process.env.ENCRYPTION_KEY = OLD_HEX;
  const db = initDb(dbPath);
  const k = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').get() as { encrypted_key: string; iv: string; auth_tag: string };
  const p = db.prepare('SELECT encrypted_key, iv, auth_tag FROM client_profiles').get() as { encrypted_key: string; iv: string; auth_tag: string };
  const s = db.prepare("SELECT value FROM settings WHERE key = 'fetch_relay_token'").get() as { value: string };
  const relay = JSON.parse(s.value) as { encrypted: string; iv: string; authTag: string };
  db.close?.();
  return {
    key: [k.encrypted_key, k.iv, k.auth_tag],
    profile: [p.encrypted_key, p.iv, p.auth_tag],
    relay: [relay.encrypted, relay.iv, relay.authTag],
  };
}

function runScript(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  // The script must not silently inherit the harness's own ENCRYPTION_KEY:
  // --old-key has to carry the whole story.
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.ENCRYPTION_KEY;
  if (!('FREEAPI_DB_PATH' in extraEnv)) delete env.FREEAPI_DB_PATH;
  const res = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('rotate-encryption-key CLI (end to end)', () => {
  beforeEach(() => {
    seedTempDb();
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ENCRYPTION_KEY;
  });

  it('rotates every stored secret to the new key and leaves the old key unable to read them', () => {
    const before = readSecrets();

    const run = runScript(['--old-key', OLD_HEX, '--new-key', NEW_HEX, '--db', dbPath]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    // api key + client profile + relay token.
    expect(run.stdout).toContain('Rotated 3 value(s)');

    const after = readSecrets();

    expect(decryptWith(NEW_KEY, ...after.key)).toBe(API_KEY_SECRET);
    expect(decryptWith(NEW_KEY, ...after.profile)).toBe(PROFILE_SECRET);
    expect(decryptWith(NEW_KEY, ...after.relay)).toBe(RELAY_TOKEN);

    // The old key must no longer open any of them (GCM fails the auth tag).
    expect(() => decryptWith(OLD_KEY, ...after.key)).toThrow();
    expect(() => decryptWith(OLD_KEY, ...after.profile)).toThrow();
    expect(() => decryptWith(OLD_KEY, ...after.relay)).toThrow();

    // Every ciphertext actually changed.
    expect(after.key[0]).not.toBe(before.key[0]);
    expect(after.profile[0]).not.toBe(before.profile[0]);
    expect(after.relay[0]).not.toBe(before.relay[0]);
  }, 60_000);

  it('--dry-run reports the work without changing a single row', () => {
    const before = readSecrets();

    const run = runScript(['--old-key', OLD_HEX, '--new-key', NEW_HEX, '--db', dbPath, '--dry-run']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[dry-run] would rotate 3 value(s)');
    expect(run.stdout).toContain('settings.fetch_relay_token');
    // Plaintext is never printed in full.
    expect(run.stdout).not.toContain(API_KEY_SECRET);

    const after = readSecrets();
    expect(after).toEqual(before);
    // And the old key still opens everything.
    expect(decryptWith(OLD_KEY, ...after.key)).toBe(API_KEY_SECRET);
    expect(decryptWith(OLD_KEY, ...after.relay)).toBe(RELAY_TOKEN);
  }, 60_000);

  it('refuses to rotate while a server still has the database open', () => {
    // A live server caches the OLD key: rotating under it breaks every decrypt
    // until restart, and a key it writes meanwhile is lost on the new key.
    const before = readSecrets();
    process.env.ENCRYPTION_KEY = OLD_HEX;
    const live = initDb(dbPath);
    live.prepare('SELECT COUNT(*) FROM api_keys').get(); // idle, like a running server between requests
    try {
      const run = runScript(['--old-key', OLD_HEX, '--new-key', NEW_HEX, '--db', dbPath]);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/Stop the FreeLLMAPI server first/);
    } finally {
      live.close?.();
    }
    expect(readSecrets()).toEqual(before);
  }, 60_000);

  it('rotates the database FREEAPI_DB_PATH points at when --db is omitted', () => {
    const run = runScript(['--old-key', OLD_HEX, '--new-key', NEW_HEX], { FREEAPI_DB_PATH: dbPath });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(decryptWith(NEW_KEY, ...readSecrets().key)).toBe(API_KEY_SECRET);
  }, 60_000);

  it('exits non-zero and writes nothing when the old key is wrong', () => {
    const before = readSecrets();

    const run = runScript(['--old-key', 'c'.repeat(64), '--new-key', NEW_HEX, '--db', dbPath]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/cannot decrypt/);

    expect(readSecrets()).toEqual(before);
  }, 60_000);
});
