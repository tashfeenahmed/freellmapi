/**
 * One-shot: sync Alibaba models for the first enabled alibaba key.
 * Usage: npx tsx src/scripts/sync-alibaba-models.ts
 */
import '../env.js';
import { initDb, getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { syncProviderModels } from '../services/provider-model-sync.js';

initDb();
const db = getDb();
const row = db.prepare("SELECT * FROM api_keys WHERE platform = 'alibaba' AND enabled = 1 LIMIT 1").get() as {
  id: number; encrypted_key: string; iv: string; auth_tag: string;
} | undefined;
if (!row) {
  console.error('No enabled alibaba key');
  process.exit(1);
}

const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
console.log('Syncing models for alibaba key', row.id, '…');
const result = await syncProviderModels('alibaba', apiKey, row.id, { probe: true, probeConcurrency: 6 });
console.log(JSON.stringify({
  fetched: result.fetched,
  chatCandidates: result.chatCandidates,
  enabled: result.enabled,
  disabled: result.disabled,
  inserted: result.inserted,
  updated: result.updated,
}, null, 2));
console.log('\nEnabled models:');
for (const m of result.models.filter(m => m.enabled)) console.log(' ', m.modelId);
