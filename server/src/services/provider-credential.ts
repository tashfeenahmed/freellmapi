import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { reserveMonthlyBudget } from './key-budget.js';

export interface ReservedProviderCredential {
  id: number;
  key: string;
  baseUrl: string | null;
  release: () => void;
}

interface KeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
}

/** Select and reserve a credential for the independent embeddings/media routers.
 * Bound custom models stay on their own key; ordinary providers may use any
 * healthy key with room in its budget. Callers release after logging the result.
 */
export function reserveProviderCredential(
  row: { platform: string; key_id: number | null },
  estimatedTokens: number,
  skip: (keyId: number) => boolean = () => false,
): { credential: ReservedProviderCredential | null; budgetBlocked: boolean } {
  if (row.platform === 'custom' && row.key_id == null) return { credential: null, budgetBlocked: false };
  const bound = row.key_id != null;
  const keys = getDb().prepare(`
    SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys
    WHERE ${bound ? 'id' : 'platform'} = ? AND enabled = 1
      AND status IN ('healthy', 'unknown') ORDER BY RANDOM()
  `).all(bound ? row.key_id : row.platform) as KeyRow[];
  let budgetBlocked = false;
  for (const keyRow of keys) {
    if (skip(keyRow.id)) continue;
    let key: string;
    try {
      key = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    } catch {
      continue;
    }
    const reservation = reserveMonthlyBudget(keyRow.id, estimatedTokens);
    if (!reservation.allowed) { budgetBlocked = true; continue; }
    return {
      credential: {
        id: keyRow.id, key,
        baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null,
        release: reservation.release,
      },
      budgetBlocked,
    };
  }
  return { credential: null, budgetBlocked };
}
