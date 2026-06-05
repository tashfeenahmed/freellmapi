/**
 * Live provider sweep — probes every enabled platform through the local
 * FreeLLMAPI proxy to verify connectivity and key validity.
 *
 * Replaces the standalone glass-vault/provider_sweep.py script.
 *
 * Usage: npx tsx src/scripts/provider-sweep.ts
 */
import { initDb, getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';

initDb();
const db = getDb();

interface KeyRow {
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

const platforms = db.prepare(`
  SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 ORDER BY platform
`).all() as { platform: string }[];

const keyStmt = db.prepare(`
  SELECT platform, encrypted_key, iv, auth_tag FROM api_keys
   WHERE platform = ? AND enabled = 1 ORDER BY id LIMIT 1
`);

const pad = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);

console.log('\n=== FreeLLMAPI Provider Sweep ===\n');

for (const { platform } of platforms) {
  const keyRow = keyStmt.get(platform) as KeyRow | undefined;
  if (!keyRow) {
    console.log(`✗ ${pad(platform, 14)} no key configured`);
    continue;
  }

  const provider = getProvider(platform as any);
  if (!provider) {
    console.log(`✗ ${pad(platform, 14)} no provider registered`);
    continue;
  }

  let apiKey: string;
  try {
    apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch {
    console.log(`✗ ${pad(platform, 14)} decrypt failed`);
    continue;
  }

  const start = Date.now();
  try {
    const valid = await provider.validateKey(apiKey);
    const ms = Date.now() - start;
    if (valid) {
      console.log(`✓ ${pad(platform, 14)} key valid  ${String(ms).padStart(5)}ms`);
    } else {
      console.log(`✗ ${pad(platform, 14)} key rejected (401/403)  ${String(ms).padStart(5)}ms`);
    }
  } catch (err: any) {
    const ms = Date.now() - start;
    console.log(`✗ ${pad(platform, 14)} error: ${String(err?.message ?? err).slice(0, 100)}  ${String(ms).padStart(5)}ms`);
  }
}

console.log(`\nSwept ${platforms.length} platforms.\n`);
process.exit(0);
