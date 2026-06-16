/**
 * Export API keys from the SQLite database as plaintext JSON.
 *
 * Usage:
 *   tsx scripts/export-keys.ts > keys-backup.json
 */

import 'dotenv/config';
import { initDb } from '../server/src/db/index.js';
import { initEncryptionKey, decrypt } from '../server/src/lib/crypto.js';

const db = initDb();
initEncryptionKey(db);

const rows = db.prepare(
  'SELECT platform, label, encrypted_key, iv, auth_tag, enabled, created_at FROM api_keys ORDER BY platform, created_at',
).all() as any[];

const keys = rows.map(row => {
  let key = '';
  try {
    key = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    key = '[decrypt failed]';
  }
  return {
    platform: row.platform,
    label: row.label,
    key,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
});

const output = {
  version: 1,
  exportedAt: new Date().toISOString(),
  keys,
};

process.stdout.write(JSON.stringify(output, null, 2) + '\n');
