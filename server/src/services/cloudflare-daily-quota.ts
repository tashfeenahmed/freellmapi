import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { setCooldown, type CooldownSource } from './ratelimit.js';

// Cloudflare Workers AI meters its free 10K neurons/day per ACCOUNT: every
// @cf/* model and every API token of one account draw on the same pool. The
// normal daily-quota bench only parks the one model+key that hit the 429, so
// the router kept walking the account's sibling models and tokens into the
// same "daily free allocation" wall all day.
//
// When that 429 arrives we bench every enabled Cloudflare model on every key
// of the same account, with the same duration and provenance the failing route
// just got (cooldownDecisionForError: next UTC midnight, an explicit
// Retry-After, the operator's ceiling). They are ordinary cooldown rows, so
// they show on the Keys page, "Clear cooldowns" lifts them, and keys of a
// different Cloudflare account stay available for fallback.

/** Account id of a Cloudflare key ("account_id:api_token"), or null. */
export function cloudflareAccountId(apiKey: string): string | null {
  const colon = apiKey.indexOf(':');
  if (colon <= 0 || colon === apiKey.length - 1) return null;
  return apiKey.slice(0, colon).toLowerCase();
}

/** Only a Workers AI daily *neurons* 429 means the whole account is spent. */
export function isCloudflareNeuronsExhausted(err: { status?: number; message?: string } | null | undefined): boolean {
  const msg = err?.message ?? '';
  return err?.status === 429 && /daily free allocation/i.test(msg) && /neurons/i.test(msg);
}

/**
 * Bench the whole Cloudflare account behind `apiKey` after a daily neurons
 * 429. Returns the number of model+key cooldowns written (0 when the error is
 * not a neurons exhaustion or the key has no account id).
 */
export function benchCloudflareAccount(
  apiKey: string,
  err: { status?: number; message?: string } | null | undefined,
  durationMs: number,
  source: CooldownSource,
): number {
  if (!isCloudflareNeuronsExhausted(err)) return 0;
  const account = cloudflareAccountId(apiKey);
  if (!account) return 0;

  const db = getDb();
  const keys = db.prepare(
    "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'cloudflare' AND enabled = 1",
  ).all() as { id: number; encrypted_key: string; iv: string; auth_tag: string }[];
  const keyIds = keys.filter(k => {
    try {
      return cloudflareAccountId(decrypt(k.encrypted_key, k.iv, k.auth_tag)) === account;
    } catch {
      return false; // undecryptable row: not ours to bench
    }
  }).map(k => k.id);
  if (keyIds.length === 0) return 0;

  const models = db.prepare(
    "SELECT model_id FROM models WHERE platform = 'cloudflare' AND enabled = 1",
  ).all() as { model_id: string }[];

  let benched = 0;
  for (const keyId of keyIds) {
    for (const { model_id } of models) {
      setCooldown('cloudflare', model_id, keyId, durationMs, source);
      benched++;
    }
  }
  return benched;
}
