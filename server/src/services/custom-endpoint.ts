import { encrypt, decrypt } from '../lib/crypto.js';
import type { Db } from '../db/types.js';

// ── Custom OpenAI-compatible endpoints: keys per endpoint ────────────────────
// A custom endpoint is identified by its base_url and can hold SEVERAL
// credentials — relay services routinely hand out one key per plan/group, and
// pooling them is the whole point of adding more than one (#619). Registration
// therefore matches on (base_url, secret), never on base_url alone: a new
// secret for a known endpoint INSERTs, it does not overwrite the key already
// stored. Models still bind to one api_keys row via key_id (#212); the router
// treats every key sharing that row's base_url as an alternative for the same
// model, so the binding names the ENDPOINT and the pool rotates underneath it.

// Stored for endpoints that need no credential (llama.cpp / LM Studio / vLLM
// with auth off). It is a placeholder, not a secret, so a real key may replace
// it in place instead of piling up a second row.
const NO_KEY = 'no-key';

interface StoredKeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

export interface ResolvedEndpointKey {
  keyId: number;
  /** Plaintext of the key now bound to this endpoint — for masking in responses. */
  storedKey: string;
  /** True when this call added a credential rather than updating one. */
  created: boolean;
}

function endpointKeyRows(db: Db, baseUrl: string): StoredKeyRow[] {
  return db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = 'custom' AND base_url = ?
     ORDER BY id
  `).all(baseUrl) as StoredKeyRow[];
}

function plaintextOf(row: StoredKeyRow): string | null {
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

function touch(db: Db, id: number, label: string | undefined): void {
  db.prepare("UPDATE api_keys SET label = COALESCE(?, label), status = 'unknown', enabled = 1 WHERE id = ?")
    .run(label ?? null, id);
}

/**
 * The name a custom endpoint takes when the operator did not give it one: its
 * host and port. Every endpoint used to default to the literal 'Custom', so the
 * panels that identify a key by label alone (analytics, cooldowns, quota
 * signals) showed a column of identical rows once you ran more than one relay
 * (#705). The host is what actually tells two endpoints apart.
 */
function defaultCustomEndpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || 'Custom';
  } catch {
    return 'Custom';
  }
}

function insertKey(db: Db, baseUrl: string, secret: string, label: string | undefined): ResolvedEndpointKey {
  const { encrypted, iv, authTag } = encrypt(secret);
  const r = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
  `).run(label ?? defaultCustomEndpointLabel(baseUrl), encrypted, iv, authTag, baseUrl);
  return { keyId: Number(r.lastInsertRowid), storedKey: secret, created: true };
}

/**
 * Resolve the api_keys row a custom-endpoint registration should bind to,
 * creating or updating it as needed. Never destroys a stored credential:
 *  - no key submitted        → reuse the endpoint's first key (label refresh only)
 *  - a key already on record  → update that row (label / re-enable)
 *  - a new key, placeholder-only endpoint → replace the placeholder in place
 *  - a new key, endpoint already has one → INSERT a second credential (#619)
 *
 * `pinnedKeyId` lets a caller that already knows WHICH credential of the pool
 * it is acting for name it — the bulk registration of discovered models (#488)
 * comes back holding the key row the user fetched the list with. It only
 * applies when that row really serves this base_url and no new secret was
 * submitted; a new secret still goes through the rules above.
 */
export function resolveCustomEndpointKey(
  db: Db,
  baseUrl: string,
  providedKey: string | undefined,
  label: string | undefined,
  pinnedKeyId?: number,
): ResolvedEndpointKey {
  const rows = endpointKeyRows(db, baseUrl);
  const stored = rows.map(row => ({ row, secret: plaintextOf(row) }));

  if (!providedKey) {
    const pinned = pinnedKeyId === undefined
      ? undefined
      : stored.find(s => s.row.id === pinnedKeyId);
    const first = pinned ?? stored[0];
    if (!first) return insertKey(db, baseUrl, NO_KEY, label);
    touch(db, first.row.id, label);
    return { keyId: first.row.id, storedKey: first.secret ?? NO_KEY, created: false };
  }

  const same = stored.find(s => s.secret === providedKey);
  if (same) {
    touch(db, same.row.id, label);
    return { keyId: same.row.id, storedKey: providedKey, created: false };
  }

  // Only placeholders on record: the endpoint was registered without auth and
  // is being given a key now, so upgrade rather than leave a dead sentinel row.
  if (stored.length > 0 && stored.every(s => s.secret === NO_KEY)) {
    const target = stored[0]!.row;
    const { encrypted, iv, authTag } = encrypt(providedKey);
    db.prepare(`
      UPDATE api_keys
         SET label = COALESCE(?, label), encrypted_key = ?, iv = ?, auth_tag = ?,
             status = 'unknown', enabled = 1
       WHERE id = ?
    `).run(label ?? null, encrypted, iv, authTag, target.id);
    return { keyId: target.id, storedKey: providedKey, created: false };
  }

  return insertKey(db, baseUrl, providedKey, label);
}

/** True when this endpoint already stores this exact secret. Lets a caller tell
 *  a genuinely new credential from a re-submit of one already in the pool, which
 *  `resolveCustomEndpointKey` deliberately treats the same way. */
export function endpointHasCredential(db: Db, baseUrl: string, secret: string): boolean {
  return endpointKeyRows(db, baseUrl).some(row => plaintextOf(row) === secret);
}

/**
 * Every api_keys id that serves the SAME custom endpoint as `keyId` — i.e. the
 * credential pool a model bound to `keyId` may rotate across. Falls back to the
 * key itself when the row is gone or carries no base_url.
 */
export function customEndpointKeyIds(db: Db, keyId: number): Set<number> {
  const row = db.prepare("SELECT base_url FROM api_keys WHERE id = ?").get(keyId) as
    { base_url: string | null } | undefined;
  if (!row?.base_url) return new Set([keyId]);
  const siblings = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ?")
    .all(row.base_url) as { id: number }[];
  return new Set(siblings.map(s => s.id));
}

/**
 * The other key still serving this endpoint once `keyId` is gone, or null when
 * it was the last one. Used to re-home an endpoint's models instead of deleting
 * them with the key.
 */
export function siblingEndpointKeyId(db: Db, keyId: number, baseUrl: string | null): number | null {
  if (!baseUrl) return null;
  const row = db.prepare(`
    SELECT id FROM api_keys
     WHERE platform = 'custom' AND base_url = ? AND id != ?
     ORDER BY id LIMIT 1
  `).get(baseUrl, keyId) as { id: number } | undefined;
  return row?.id ?? null;
}

export interface CustomEndpointCredential {
  keyId: number;
  baseUrl: string;
  /** Decrypted secret, or null when the row's ciphertext cannot be decrypted. */
  apiKey: string | null;
}

/**
 * Every configured custom endpoint, one entry per distinct base_url, carrying
 * its first stored credential. Used by the scheduled model sync
 * (#674/#663/#656) to refresh model lists unattended: the manual route asks
 * the operator for a key mid-typing, but a scheduled pass can only use what
 * the endpoint already has on record.
 */
export function listCustomEndpoints(db: Db): CustomEndpointCredential[] {
  const rows = db.prepare(`
    SELECT base_url, id, encrypted_key, iv, auth_tag
      FROM api_keys
     WHERE platform = 'custom' AND base_url IS NOT NULL
     ORDER BY base_url, id
  `).all() as Array<{
    base_url: string;
    id: number;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
  }>;

  const seen = new Set<string>();
  const out: CustomEndpointCredential[] = [];
  for (const row of rows) {
    if (seen.has(row.base_url)) continue;
    seen.add(row.base_url);
    out.push({ keyId: row.id, baseUrl: row.base_url, apiKey: plaintextOf(row) });
  }
  return out;
}
