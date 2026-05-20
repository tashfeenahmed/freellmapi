import type Database from 'better-sqlite3';
import { z } from 'zod';
import { PLATFORMS } from '../lib/platforms.js';
import { decrypt, encrypt, maskKey } from '../lib/crypto.js';

const KEY_STATUSES = ['healthy', 'rate_limited', 'invalid', 'error', 'unknown'] as const;

export const importModeSchema = z.enum(['append', 'replace']);

const importKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().trim().min(1),
  label: z.string().optional().transform(value => value?.trim() ?? ''),
  enabled: z.boolean().optional().default(true),
  status: z.enum(KEY_STATUSES).optional().default('unknown'),
  createdAt: z.string().optional(),
  lastCheckedAt: z.string().nullable().optional(),
});

export type ImportMode = z.infer<typeof importModeSchema>;

export type ImportProviderKeysOptions = {
  mode?: ImportMode;
  dedupe?: boolean;
};

export type ImportProviderKeysResult = {
  inserted: number;
  skipped: number;
  replaced: number;
  errors: Array<{ index: number; message: string }>;
  keys: Array<{
    id: number;
    platform: string;
    label: string;
    maskedKey: string;
    enabled: boolean;
  }>;
};

function normalizeRawKey(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const raw = value as Record<string, unknown>;
  return {
    platform: raw.platform,
    key: raw.key ?? raw.apiKey ?? raw.api_key,
    label: raw.label ?? raw.name ?? '',
    enabled: raw.enabled,
    status: raw.status,
    createdAt: raw.createdAt ?? raw.created_at,
    lastCheckedAt: raw.lastCheckedAt ?? raw.last_checked_at,
  };
}

function fingerprint(platform: string, key: string): string {
  return `${platform}\u0000${key}`;
}

function collectExistingFingerprints(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT platform, encrypted_key, iv, auth_tag FROM api_keys').all() as Array<{
    platform: string;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
  }>;

  const seen = new Set<string>();
  for (const row of rows) {
    try {
      seen.add(fingerprint(row.platform, decrypt(row.encrypted_key, row.iv, row.auth_tag)));
    } catch {
      // Keep importing even if an old row cannot be decrypted.
    }
  }
  return seen;
}

export function importProviderKeys(
  db: Database.Database,
  rawKeys: unknown[],
  options: ImportProviderKeysOptions = {},
): ImportProviderKeysResult {
  const mode = options.mode ?? 'append';
  const dedupe = options.dedupe !== false;
  const errors: ImportProviderKeysResult['errors'] = [];

  const keys = rawKeys.flatMap((rawKey, index) => {
    const parsed = importKeySchema.safeParse(normalizeRawKey(rawKey));
    if (!parsed.success) {
      errors.push({
        index,
        message: parsed.error.errors.map(error => error.message).join(', '),
      });
      return [];
    }
    return [parsed.data];
  });

  const result: ImportProviderKeysResult = {
    inserted: 0,
    skipped: 0,
    replaced: 0,
    errors,
    keys: [],
  };

  if (keys.length === 0) {
    result.skipped = rawKeys.length;
    return result;
  }

  const insert = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, created_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    if (mode === 'replace') {
      result.replaced = (db.prepare('DELETE FROM api_keys').run().changes as number) ?? 0;
    }

    const seen = dedupe && mode === 'append' ? collectExistingFingerprints(db) : new Set<string>();
    const importedAt = new Date().toISOString();

    for (const item of keys) {
      const keyFingerprint = fingerprint(item.platform, item.key);
      if (dedupe && seen.has(keyFingerprint)) {
        result.skipped += 1;
        continue;
      }
      if (dedupe) seen.add(keyFingerprint);

      const encrypted = encrypt(item.key);
      const createdAt = item.createdAt ?? importedAt;
      const inserted = insert.run(
        item.platform,
        item.label,
        encrypted.encrypted,
        encrypted.iv,
        encrypted.authTag,
        item.status,
        item.enabled ? 1 : 0,
        createdAt,
        item.lastCheckedAt ?? null,
      );

      result.inserted += 1;
      result.keys.push({
        id: Number(inserted.lastInsertRowid),
        platform: item.platform,
        label: item.label,
        maskedKey: maskKey(item.key),
        enabled: item.enabled,
      });
    }
  });

  run();
  result.skipped += errors.length;
  return result;
}
