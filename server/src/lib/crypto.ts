import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Db } from '../db/types.js';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * A typo'd ENCRYPTION_KEY (e.g. "abc") would historically fall through
 * the placeholder check, get truncated to 1.5 bytes, and only fail at
 * the first encrypt() call with a cryptic node:crypto error. Validate
 * the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

// The dev-fallback key lives in a file next to the DB, NOT in the DB itself.
// Storing it beside the ciphertext it protects (the old `settings` row) meant
// encryption-at-rest protected nothing for a default install: whoever copied
// the DB also copied the key. The file sits in the same directory but is a
// separate artifact, and is chmod 0600 so it isn't world-readable.
const KEY_FILE_NAME = '.encryption-key';

function parseHexKey(value: string, source: 'env' | 'db' | 'file'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

// Outside production we auto-generate and persist a key so a fresh clone
// (`npm run dev`) boots without manual setup — the placeholder ENCRYPTION_KEY
// in .env.example would otherwise crash the server on boot, which surfaces in
// the client as "Can't reach the server". Production still requires an explicit
// env key: a generated key lives only on the local disk and silently losing it
// would make every stored API key undecryptable.
function isDevFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function missingKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required in production for API key encryption. ' +
    `Set a ${KEY_HEX_LEN}-char hex key (generate one with: ` +
    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"). ` +
    'Outside production a local key file is auto-generated next to the database.',
  );
}

// The directory that holds the DB is the only place we can keep the key file
// next to (but not inside) the database. In-memory and anonymous databases have
// no such directory (db.memory is true, db.name is ":memory:" or ""), and Db
// backings without file metadata (memory undefined) have none either, so those
// callers fall back to the legacy settings-table behavior.
function keyFilePathFor(db: Db): string | null {
  if (db.memory !== false) return null;
  const dbPath = db.name;
  if (!dbPath || dbPath === ':memory:') return null;
  return path.join(path.dirname(dbPath), KEY_FILE_NAME);
}

// Write the hex key with a temp-file-and-rename so a crash never leaves a
// half-written key, and chmod 0600 so it isn't readable by other local users.
function writeKeyFileAtomic(keyFile: string, hex: string): void {
  const dir = path.dirname(keyFile);
  const tmp = path.join(dir, `${KEY_FILE_NAME}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, hex, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort — e.g. filesystems without POSIX modes */ }
  fs.renameSync(tmp, keyFile);
  try { fs.chmodSync(keyFile, 0o600); } catch { /* best effort */ }
}

/**
 * Initialize encryption key from env or an explicit local-dev fallback.
 * Must be called after DB is initialized.
 *
 * Precedence (dev fallback): ENCRYPTION_KEY env > existing key file next to the
 * DB > legacy `settings` table row (migrated to the file, then deleted) >
 * freshly generated key written to the file.
 */
export function initEncryptionKey(db: Db): void {
  // 1. Explicit env key always wins.
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) {
    cachedKey = parseHexKey(envKey, 'env');
    return;
  }

  if (!isDevFallbackAllowed()) {
    throw missingKeyError();
  }

  const keyFile = keyFilePathFor(db);

  // In-memory / anonymous DBs have no directory to hold a key file, so keep the
  // legacy settings-table behavior for them (ephemeral runs, most tests).
  if (!keyFile) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
    if (row) {
      cachedKey = parseHexKey(row.value, 'db');
      console.warn('[crypto] No ENCRYPTION_KEY set — using an auto-generated in-memory key (dev only).');
      return;
    }
    cachedKey = crypto.randomBytes(KEY_BYTES);
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(cachedKey.toString('hex'));
    console.warn('[crypto] No ENCRYPTION_KEY set — generated an in-memory dev key. Set ENCRYPTION_KEY for production.');
    return;
  }

  // 2. An existing key file next to the DB.
  if (fs.existsSync(keyFile)) {
    const value = fs.readFileSync(keyFile, 'utf8').trim();
    cachedKey = parseHexKey(value, 'file');
    console.warn(`[crypto] No ENCRYPTION_KEY set — using the auto-generated key at ${keyFile} (dev only). Set ENCRYPTION_KEY for production.`);
    return;
  }

  // 3. A legacy key still sitting in the settings table (older dev installs).
  //    Migrate it to the key file so the DB stops storing the key that protects
  //    it, confirm a decrypt round-trip with the migrated key, then drop the row.
  const legacy = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  if (legacy) {
    const migrated = parseHexKey(legacy.value, 'db');
    writeKeyFileAtomic(keyFile, migrated.toString('hex'));
    cachedKey = migrated;
    const probe = encrypt('roundtrip');
    if (decrypt(probe.encrypted, probe.iv, probe.authTag) !== 'roundtrip') {
      cachedKey = null;
      throw new Error('[crypto] Failed to migrate the DB-stored key to a key file: round-trip check failed.');
    }
    db.prepare("DELETE FROM settings WHERE key = 'encryption_key'").run();
    console.warn(`[crypto] Migrated the legacy DB-stored key to ${keyFile} and removed it from the database (dev only). Set ENCRYPTION_KEY for production.`);
    return;
  }

  // 4. Generate a fresh key and persist it to the file.
  cachedKey = crypto.randomBytes(KEY_BYTES);
  writeKeyFileAtomic(keyFile, cachedKey.toString('hex'));
  console.warn(`[crypto] No ENCRYPTION_KEY set — generated a local dev key at ${keyFile}. Set ENCRYPTION_KEY for production.`);
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

export function isEncryptionKeyInitialized(): boolean {
  return cachedKey !== null;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

// AUTH_TAG_BYTES pins the GCM tag length to 16 bytes. Without this option Node
// will accept any tag of length 4–16 bytes (RFC 5116 §3.2), which lets anyone
// who can rewrite a row in `api_keys` swap in a 4-byte tag and start brute-
// forcing forgeries at 2^32 attempts. Pinning closes that truncation path.
const AUTH_TAG_BYTES = 16;

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}
