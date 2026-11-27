#!/usr/bin/env node
/**
 * rotate-encryption-key — re-encrypt every stored secret under a new
 * ENCRYPTION_KEY without losing a single value.
 *
 * Why this exists: AES-256-GCM is authenticated, so a DB carried over to a
 * different ENCRYPTION_KEY fails loudly on the first decrypt — every stored
 * API key, proxy override, client-profile credential and the Fetch Relay
 * token becomes unreadable at once, and there is no recovery path short of
 * re-entering secrets by hand.
 * Rotating keys (compromise, policy expiry, onboarding) therefore has to walk
 * the ciphertext, decrypt each value with the OLD key and re-encrypt it with
 * the NEW one, atomically, before the new key ever becomes active.
 *
 * The cipher parameters deliberately mirror server/src/lib/crypto.ts
 * (aes-256-gcm, 32-byte key hex, 16-byte IV, 16-byte GCM tag) so a value
 * written here decrypts under the running server exactly like one written by
 * `encrypt()`. The script does NOT touch the module-level key cache — it
 * performs every decrypt with `--old-key` and every encrypt with `--new-key`
 * explicitly.
 *
 * The server MUST be stopped. A running server keeps the OLD key cached
 * (lib/crypto.ts): once the rows are rewritten it can decrypt none of them,
 * and any key it encrypts before the restart is written under the old key and
 * becomes unreadable on the new one. So the script takes an exclusive lock on
 * the database and refuses to run while any other process has it open; the
 * read and the write happen inside that one lock, so no row can change between
 * them.
 *
 * Usage:
 *   tsx src/scripts/rotate-encryption-key.ts --old-key <64hex> --new-key <64hex> [--db <path>] [--dry-run]
 *
 *   --old-key  the current key (hex, 64 chars). Falls back to ENCRYPTION_KEY.
 *   --new-key  the key to rotate to (hex, 64 chars). Required.
 *   --db       SQLite path (default: FREEAPI_DB_PATH, else the server's data/freeapi.db).
 *   --dry-run  decrypt + print every affected row WITHOUT writing anything.
 *
 * Exits 0 on success (or a clean dry run), 1 on any decrypt/validation error.
 * Nothing is written unless EVERY row decrypts — a partial rotate would leave
 * the DB in a mixed-key state that is exactly the failure this script exists
 * to prevent.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX_LEN = 64;
const AUTH_TAG_BYTES = 16;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '../../data/freeapi.db');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseHexKey(value: string, source: string): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid key (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

export function encryptWith(key: Buffer, text: string): { encrypted: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { encrypted, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

export function decryptWith(key: Buffer, encrypted: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Ciphertext stored in dedicated columns: the IV and tag live next to their
 * ciphertext in sibling columns, all TEXT.
 */
interface ColumnGroup {
  kind: 'columns';
  table: string;
  idColumn: string;
  encrypted: string;
  iv: string;
  authTag: string;
  label: string;
}

/**
 * Ciphertext stored as a JSON blob in a single `settings` value, in the shape
 * `JSON.stringify(encrypt(plaintext))` — i.e. `{"encrypted","iv","authTag"}`.
 * The Fetch Relay bearer token is written this way by
 * `encodeFetchRelayToken()` (server/src/lib/proxy.ts) and read back by
 * `decodeFetchRelayToken()`, which degrades to '' with a warning when the
 * value will not decrypt. Miss it here and a rotate silently drops the relay
 * credential on the next restart.
 */
interface SettingGroup {
  kind: 'setting';
  table: 'settings';
  settingKey: string;
  label: string;
}

type EncryptionGroup = ColumnGroup | SettingGroup;

// Every place a secret is persisted. Keep this in step with the `encrypt()`
// call sites in server/src/lib/crypto.ts consumers: api_keys (keys.ts,
// custom-endpoint.ts, declarative-config.ts), api_keys proxy columns
// (lib/key-proxy.ts), client_profiles (routes/client-profiles.ts) and the
// settings blob (lib/proxy.ts).
const ENCRYPTION_GROUPS: EncryptionGroup[] = [
  { kind: 'columns', table: 'api_keys', idColumn: 'id', encrypted: 'encrypted_key', iv: 'iv', authTag: 'auth_tag', label: 'api key' },
  { kind: 'columns', table: 'api_keys', idColumn: 'id', encrypted: 'proxy_encrypted', iv: 'proxy_iv', authTag: 'proxy_auth_tag', label: 'per-key proxy override' },
  { kind: 'columns', table: 'client_profiles', idColumn: 'id', encrypted: 'encrypted_key', iv: 'iv', authTag: 'auth_tag', label: 'client-profile credential' },
  { kind: 'setting', table: 'settings', settingKey: 'fetch_relay_token', label: 'fetch relay token' },
];

interface RowToRotate {
  group: EncryptionGroup;
  /** Row id for column groups, the settings key for settings blobs. */
  id: number | string;
  plaintext: string;
  reEncrypted: { encrypted: string; iv: string; authTag: string };
}

/** Result of a rotate attempt: rows re-encrypted, or an error that aborted it. */
export interface RotateResult {
  rows: RowToRotate[];
  error?: string;
}

/** The read surface rotateSecrets needs — better-sqlite3 and the app's Db both satisfy it. */
export interface RotateReadDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
}

/** The write surface applyRotation needs, including better-sqlite3's transaction(). */
export interface RotateWriteDb {
  prepare(sql: string): { run(...args: unknown[]): unknown };
  // Deliberately phrased as "a callable taking the same arguments" rather than
  // "returns F": better-sqlite3 hands back a Transaction<F> (F plus .deferred
  // and friends) while the app's Db type returns F itself, and both satisfy
  // this shape.
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => unknown;
}

/**
 * Core rotate routine, exported so tests can drive it against an in-memory
 * DB. Decrypts every stored secret with `oldKey` and re-encrypts with
 * `newKey`. Returns `{ rows }` on success and `{ rows: [], error }` when ANY
 * value fails to decrypt — the caller must treat the error case as "nothing
 * written".
 */
export function rotateSecrets(
  db: RotateReadDb,
  oldKey: Buffer,
  newKey: Buffer,
): RotateResult {
  const rowsToRotate: RowToRotate[] = [];

  for (const group of ENCRYPTION_GROUPS) {
    const cols = db.prepare(`PRAGMA table_info(${group.table})`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));

    // Ciphertext held as (encrypted, iv, auth_tag) columns.
    if (group.kind === 'columns') {
      if (!names.has(group.encrypted) || !names.has(group.iv) || !names.has(group.authTag)) {
        continue;
      }

      const rows = db.prepare(
        `SELECT ${group.idColumn} AS id, ${group.encrypted} AS enc, ${group.iv} AS iv, ${group.authTag} AS tag ` +
        `FROM ${group.table} WHERE ${group.encrypted} IS NOT NULL`,
      ).all() as Array<{ id: number; enc: string; iv: string; tag: string }>;

      for (const row of rows) {
        let plaintext: string;
        try {
          plaintext = decryptWith(oldKey, row.enc, row.iv, row.tag);
        } catch (err) {
          return {
            rows: [],
            error: `cannot decrypt ${group.label} #${row.id} with --old-key — wrong key or corrupted ciphertext (${(err as Error).message}). Aborting; nothing was written.`,
          };
        }
        rowsToRotate.push({ group, id: row.id, plaintext, reEncrypted: encryptWith(newKey, plaintext) });
      }
      continue;
    }

    // Ciphertext held as a JSON blob in settings.value.
    if (!names.has('key') || !names.has('value')) continue;

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(group.settingKey) as { value: string } | undefined;
    // An unset or cleared setting stores '' rather than a blob — nothing to do.
    if (!row || !row.value) continue;

    let parsed: { encrypted?: string; iv?: string; authTag?: string };
    try {
      parsed = JSON.parse(row.value) as { encrypted?: string; iv?: string; authTag?: string };
    } catch {
      return {
        rows: [],
        error: `${group.label} (settings.${group.settingKey}) is not valid JSON — refusing to guess. Aborting; nothing was written.`,
      };
    }
    if (!parsed.encrypted || !parsed.iv || !parsed.authTag) {
      return {
        rows: [],
        error: `${group.label} (settings.${group.settingKey}) is missing encrypted/iv/authTag. Aborting; nothing was written.`,
      };
    }

    let plaintext: string;
    try {
      plaintext = decryptWith(oldKey, parsed.encrypted, parsed.iv, parsed.authTag);
    } catch (err) {
      return {
        rows: [],
        error: `cannot decrypt ${group.label} (settings.${group.settingKey}) with --old-key — wrong key or corrupted ciphertext (${(err as Error).message}). Aborting; nothing was written.`,
      };
    }
    rowsToRotate.push({ group, id: group.settingKey, plaintext, reEncrypted: encryptWith(newKey, plaintext) });
  }

  return { rows: rowsToRotate };
}

/**
 * Apply a rotate result: write every re-encrypted value back to its row, in
 * one transaction. Exported so main() and tests share the exact write path.
 */
export function applyRotation(
  db: RotateWriteDb,
  rows: RowToRotate[],
): void {
  const write = db.transaction((items: RowToRotate[]) => {
    for (const r of items) {
      if (r.group.kind === 'setting') {
        // Same encoding encodeFetchRelayToken() writes, so the running server
        // reads it back unchanged.
        db.prepare('UPDATE settings SET value = ? WHERE key = ?')
          .run(JSON.stringify(r.reEncrypted), r.group.settingKey);
        continue;
      }
      db.prepare(
        `UPDATE ${r.group.table} SET ${r.group.encrypted} = ?, ${r.group.iv} = ?, ${r.group.authTag} = ? WHERE ${r.group.idColumn} = ?`,
      ).run(r.reEncrypted.encrypted, r.reEncrypted.iv, r.reEncrypted.authTag, r.id);
    }
  });
  write(rows);
}

function main(): void {
  const oldKeyHex = arg('old-key') ?? process.env.ENCRYPTION_KEY;
  const newKeyHex = arg('new-key');
  // Same resolution as the server's getDefaultDbPath(): an install that moved
  // its database with FREEAPI_DB_PATH must not get a stale default rotated.
  const dbPath = arg('db') ?? (process.env.FREEAPI_DB_PATH?.trim() || DEFAULT_DB);
  const dryRun = flag('dry-run');

  if (!oldKeyHex) {
    console.error('error: --old-key is required (or set ENCRYPTION_KEY)');
    process.exit(1);
  }
  if (!newKeyHex) {
    console.error('error: --new-key is required');
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`error: database not found at ${dbPath}`);
    process.exit(1);
  }

  const oldKey = parseHexKey(oldKeyHex, 'old');
  const newKey = parseHexKey(newKeyHex, 'new');
  if (oldKey.equals(newKey)) {
    console.error('error: --old-key and --new-key are identical — nothing to rotate');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: dryRun, timeout: 2000 });
  try {
    if (!dryRun) {
      // An exclusive lock is refused while any other connection has the file
      // open, even an idle WAL reader such as a running server.
      db.pragma('locking_mode = EXCLUSIVE');
      try {
        db.exec('BEGIN EXCLUSIVE');
      } catch (err) {
        if ((err as { code?: string }).code !== 'SQLITE_BUSY') throw err;
        console.error(`error: another process has ${dbPath} open. Stop the FreeLLMAPI server first; nothing was written.`);
        process.exit(1);
      }
    }

    const result = rotateSecrets(db, oldKey, newKey);
    if (result.error) {
      console.error(`error: ${result.error}`);
      process.exit(1);
    }

    const rowsToRotate = result.rows;
    if (rowsToRotate.length === 0) {
      console.log('No encrypted values found — nothing to rotate.');
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] would rotate ${rowsToRotate.length} value(s):`);
      for (const r of rowsToRotate) {
        const where = r.group.kind === 'setting' ? `settings.${r.group.settingKey}` : `#${r.id}`;
        console.log(`  ${r.group.label} ${where} -> ${r.plaintext.slice(0, 3)}*** (${r.plaintext.length} chars)`);
      }
      return;
    }

    applyRotation(db, rowsToRotate);
    db.exec('COMMIT');

    console.log(`Rotated ${rowsToRotate.length} value(s) to the new key.`);
    console.log('Next steps: set ENCRYPTION_KEY to the new key (or overwrite the .encryption-key file next to the DB), then start the server.');
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

// Only run when invoked directly (`tsx src/scripts/rotate-encryption-key.ts`),
// not when the module is imported by tests for `rotateSecrets`/`encryptWith`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
