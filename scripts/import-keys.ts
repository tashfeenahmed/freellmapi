/**
 * Import API keys from a JSON backup file.
 *
 * Usage:
 *   tsx scripts/import-keys.ts keys-backup.json
 */

import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import { initDb } from '../server/src/db/index.js';
import { initEncryptionKey, encrypt } from '../server/src/lib/crypto.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: tsx scripts/import-keys.ts <backup-file.json>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(filePath, 'utf-8');
let data: { version?: number; keys?: { platform: string; label: string; key: string; enabled?: boolean }[] };
try {
  data = JSON.parse(raw);
} catch {
  console.error('Invalid JSON file.');
  process.exit(1);
}

if (!data.keys || !Array.isArray(data.keys)) {
  console.error('JSON must contain a "keys" array.');
  process.exit(1);
}

const keys = data.keys;

// Show summary and ask for confirmation
console.log(`\nWill import ${keys.length} API key(s):`);
for (const k of keys) {
  console.log(`  ${k.platform.padEnd(14)} ${k.label.padEnd(20)} enabled=${k.enabled !== false}`);
}
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Proceed? [y/N] ', (answer) => {
  rl.close();

  if (answer.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    process.exit(0);
  }

  const db = initDb();
  initEncryptionKey(db);

  let imported = 0;
  let updated = 0;

  const upsert = db.transaction(() => {
    const find = db.prepare(
      'SELECT id FROM api_keys WHERE platform = ? AND label = ? LIMIT 1',
    );
    const insertStmt = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, 'unknown', ?)
    `);
    const updateStmt = db.prepare(
      'UPDATE api_keys SET encrypted_key = ?, iv = ?, auth_tag = ?, enabled = ? WHERE id = ?',
    );

    for (const entry of keys) {
      const { encrypted, iv, authTag } = encrypt(entry.key);
      const existing = find.get(entry.platform, entry.label) as { id: number } | undefined;

      if (existing) {
        updateStmt.run(encrypted, iv, authTag, entry.enabled !== false ? 1 : 0, existing.id);
        updated++;
      } else {
        insertStmt.run(entry.platform, entry.label, encrypted, iv, authTag, entry.enabled !== false ? 1 : 0);
        imported++;
      }
    }
  });

  upsert();

  console.log(`Done. Imported: ${imported}, Updated: ${updated}`);
});
