#!/usr/bin/env node
/**
 * rotate-encryption-key — re-encrypt every stored secret under a new
 * ENCRYPTION_KEY without losing a single value.
 */
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPostgresPool } from '../db/postgres.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX_LEN = 64;
const AUTH_TAG_BYTES = 16;

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

export interface RotateReadDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

export interface RotateWriteDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}

export async function rotateSecretsAsync(
  db: RotateReadDb,
  oldKey: Buffer,
  newKey: Buffer,
) {
  const rowsToRotate: Array<{
    table: string;
    id: number | string;
    plaintext: string;
    reEncrypted: { encrypted: string; iv: string; authTag: string };
  }> = [];

  // 1. Credentials table
  const creds = await db.query(
    'SELECT id, encrypted_value AS enc, iv, auth_tag AS tag FROM credentials WHERE encrypted_value IS NOT NULL'
  );
  for (const row of creds.rows) {
    const enc = row.enc ?? row.encrypted_value;
    const tag = row.tag ?? row.auth_tag;
    if (!enc || !row.iv || !tag) continue;
    try {
      const plaintext = decryptWith(oldKey, enc, row.iv, tag);
      rowsToRotate.push({
        table: 'credentials',
        id: row.id,
        plaintext,
        reEncrypted: encryptWith(newKey, plaintext),
      });
    } catch (err: any) {
      return {
        rows: [],
        error: `cannot decrypt credential #${row.id} with --old-key (${err.message})`,
      };
    }
  }

  return { rows: rowsToRotate };
}

export async function applyRotationAsync(
  db: RotateWriteDb,
  rows: Array<{ table: string; id: number | string; reEncrypted: { encrypted: string; iv: string; authTag: string } }>,
) {
  for (const r of rows) {
    if (r.table === 'credentials') {
      await db.query(
        'UPDATE credentials SET encrypted_value = $1, iv = $2, auth_tag = $3, updated_at = NOW() WHERE id = $4',
        [r.reEncrypted.encrypted, r.reEncrypted.iv, r.reEncrypted.authTag, r.id]
      );
    }
  }
}

async function main(): Promise<void> {
  const oldKeyHex = arg('old-key') ?? process.env.ENCRYPTION_KEY;
  const newKeyHex = arg('new-key');
  const dryRun = flag('dry-run');

  if (!oldKeyHex) {
    console.error('error: --old-key is required (or set ENCRYPTION_KEY)');
    process.exit(1);
  }
  if (!newKeyHex) {
    console.error('error: --new-key is required');
    process.exit(1);
  }

  const oldKey = parseHexKey(oldKeyHex, 'old');
  const newKey = parseHexKey(newKeyHex, 'new');
  if (oldKey.equals(newKey)) {
    console.error('error: --old-key and --new-key are identical — nothing to rotate');
    process.exit(1);
  }

  const pool = getPostgresPool();
  try {
    const result = await rotateSecretsAsync(pool, oldKey, newKey);
    if (result.error) {
      console.error(`error: ${result.error}`);
      process.exit(1);
    }

    if (result.rows.length === 0) {
      console.log('No encrypted values found — nothing to rotate.');
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] would rotate ${result.rows.length} value(s)`);
      return;
    }

    await applyRotationAsync(pool, result.rows);
    console.log(`Rotated ${result.rows.length} value(s) to the new key.`);
  } catch (err: any) {
    console.error('Rotation failed:', err?.message ?? err);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
