/**
 * Bootstrap helpers for the GitHub Copilot provider.
 *
 * `backfillCopilotTiers` runs once on server start to populate
 * api_keys.tier / api_keys.endpoint_base for any Copilot key that
 * pre-dates V18 (or any key whose previous exchange attempt failed).
 * It iterates all enabled github-copilot rows with tier IS NULL,
 * decrypts each token, calls Path-A Step 3, and writes back the
 * result. After populating, calls `applyCopilotTier` to write the
 * tier-appropriate budgets and disable/enable flags.
 *
 * Soft-failure semantics — if the exchange errors for any individual
 * key (network blip, GitHub 5xx, etc.) the key keeps tier=NULL and we
 * move on. The user can re-login from the dashboard to retry; the
 * provider will fall back to api.githubcopilot.com hardcoded for any
 * key without an endpoint_base.
 */
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { exchangeToken } from '../lib/copilot-auth.js';
import { applyCopilotTier, mapSkuToTier, type CopilotTier } from './copilot-tiers.js';

interface KeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

export async function backfillCopilotTiers(): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag FROM api_keys
     WHERE platform = 'github-copilot'
       AND enabled = 1
       AND (tier IS NULL OR endpoint_base IS NULL)
  `).all() as KeyRow[];

  if (rows.length === 0) return;

  // Sequential — one HTTP per key, no parallel storm.
  for (const row of rows) {
    let token: string;
    try {
      token = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    } catch (err) {
      console.warn(`[copilot-bootstrap] decrypt failed for api_keys.id=${row.id}: ${(err as Error).message}`);
      continue;
    }

    let tier: CopilotTier;
    let endpointBase: string;
    try {
      const ex = await exchangeToken(token);
      tier = mapSkuToTier(ex.sku, ex.rawToken);
      endpointBase = ex.endpointBase;
    } catch (err) {
      console.warn(`[copilot-bootstrap] exchange failed for api_keys.id=${row.id}: ${(err as Error).message}`);
      continue;
    }

    db.prepare('UPDATE api_keys SET tier = ?, endpoint_base = ? WHERE id = ?')
      .run(tier, endpointBase, row.id);
    applyCopilotTier(db, tier);
    console.log(`[copilot-bootstrap] api_keys.id=${row.id} → tier=${tier} endpoint=${endpointBase}`);
  }
}
