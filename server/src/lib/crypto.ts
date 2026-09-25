import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { restrictToOwner } from './file-permissions.js';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';
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

function isDevFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function missingKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required in production for API key encryption. ' +
    `Set a ${KEY_HEX_LEN}-char hex key (generate one with: ` +
    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"). ` +
    'Outside production a local key is auto-generated.',
  );
}

export function initEncryptionKey(): void {
  // 1. Explicit env key always wins.
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) {
    cachedKey = parseHexKey(envKey, 'env');
    return;
  }

  if (!isDevFallbackAllowed()) {
    throw missingKeyError();
  }

  const keyFile = path.resolve(process.cwd(), KEY_FILE_NAME);

  // 2. An existing key file
  if (fs.existsSync(keyFile)) {
    try {
      const value = fs.readFileSync(keyFile, 'utf8').trim();
      cachedKey = parseHexKey(value, 'file');
      console.warn(`[crypto] No ENCRYPTION_KEY set — using the key at ${keyFile} (dev only). Set ENCRYPTION_KEY for production.`);
      return;
    } catch {
      // Fall through to generate fresh key
    }
  }

  // 3. Generate a fresh key
  cachedKey = crypto.randomBytes(KEY_BYTES);
  try {
    fs.writeFileSync(keyFile, cachedKey.toString('hex'), { mode: 0o600 });
    restrictToOwner(keyFile);
    console.warn(`[crypto] No ENCRYPTION_KEY set — generated a local dev key at ${keyFile}. Set ENCRYPTION_KEY for production.`);
  } catch {
    console.warn('[crypto] No ENCRYPTION_KEY set — using ephemeral in-memory dev key.');
  }
}

export function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    initEncryptionKey();
  }
  return cachedKey!;
}

export function encryptionKeyFingerprint(): string | null {
  if (!cachedKey) return null;
  return `sha256:${crypto.createHash('sha256').update(cachedKey).digest('hex').slice(0, 16)}`;
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
  if (!key || key.length < 5) return '****';
  if (key.length <= 8) return '****' + key.slice(-2);

  const prefixMatch = key.match(/^([a-zA-Z0-9_-]+-)/);
  if (prefixMatch) {
    const prefix = prefixMatch[1];
    const suffix = key.slice(-4);
    return `${prefix}••••••••${suffix}`;
  }

  const prefix = key.slice(0, 4);
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}
