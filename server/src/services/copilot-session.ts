/**
 * GitHub Copilot session-token cache + auto-refresh scheduler.
 *
 * Path-A Step 3 produces a ~30-min session token. We hold one per
 * api_keys row in memory and refresh it ~60s before GitHub's
 * `refresh_in` deadline so inference calls never block on the
 * exchange. On refresh we also re-read `sku` (so a plan upgrade gets
 * picked up at the next refresh tick, not just next login) and
 * `endpoints.api` (in case a business/enterprise account is moved).
 *
 * Cache key is `api_keys.id`. The cache holds no secrets long-term —
 * just the short-lived session token; the gho_ OAuth token stays in
 * the encrypted_key column of the DB and is decrypted on demand.
 *
 * Concurrent callers waiting for the same key's exchange are
 * dedup'd via a pending-promise map so we don't fire two
 * `copilot_internal/v2/token` calls back-to-back.
 *
 * Shutdown: clearAllRefreshTimers() should be called from server
 * teardown if/when we add one. The Node process exiting will also
 * cancel the unref'd timers.
 */
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { exchangeToken } from '../lib/copilot-auth.js';
import { applyCopilotTier, mapSkuToTier, type CopilotTier } from './copilot-tiers.js';

interface CacheEntry {
  sessionToken: string;
  endpointBase: string;
  /** Unix-second deadline. We treat `now + 60s > expiresAt` as expired. */
  expiresAt: number;
  /** Active refresh timer so we can cancel it if a forced re-exchange happens. */
  refreshTimer?: NodeJS.Timeout;
}

const cache = new Map<number, CacheEntry>();
const pending = new Map<number, Promise<CacheEntry>>();

const SAFETY_MARGIN_MS = 60_000; // refresh at (refresh_in - 60)s
const MIN_REFRESH_MS = 30_000;   // never schedule sooner than 30s out

/**
 * Get a session token + endpoint base URL for a Copilot api_keys row.
 *
 * If a fresh-enough cached entry exists (>= 60s of life left) it's
 * returned immediately. Otherwise a single in-flight exchange is
 * scheduled and concurrent callers share the same Promise.
 *
 * @param keyId       api_keys.id of the Copilot key
 * @param githubToken decrypted gho_ OAuth token for that key
 */
export async function getSessionToken(keyId: number, githubToken: string): Promise<{ sessionToken: string; endpointBase: string }> {
  const now = Math.floor(Date.now() / 1000);
  const cached = cache.get(keyId);
  if (cached && cached.expiresAt > now + 60) {
    return { sessionToken: cached.sessionToken, endpointBase: cached.endpointBase };
  }

  let inflight = pending.get(keyId);
  if (!inflight) {
    inflight = doExchangeAndCache(keyId, githubToken);
    pending.set(keyId, inflight);
    void inflight.finally(() => pending.delete(keyId));
  }
  const entry = await inflight;
  return { sessionToken: entry.sessionToken, endpointBase: entry.endpointBase };
}

async function doExchangeAndCache(keyId: number, githubToken: string): Promise<CacheEntry> {
  const ex = await exchangeToken(githubToken);

  // Persist any newly-observed tier or endpoint shift to the DB so the
  // dashboard stays current across restarts.
  const db = getDb();
  const tier: CopilotTier = mapSkuToTier(ex.sku, ex.sessionToken);
  db.prepare('UPDATE api_keys SET tier = ?, endpoint_base = ? WHERE id = ?')
    .run(tier, ex.endpointBase, keyId);
  applyCopilotTier(db, tier);

  // Cancel any prior refresh timer before we replace the entry — otherwise
  // a stale timer would fire and stomp the fresh entry.
  const prior = cache.get(keyId);
  if (prior?.refreshTimer) clearTimeout(prior.refreshTimer);

  const refreshAfterMs = Math.max(MIN_REFRESH_MS, ex.refreshIn * 1000 - SAFETY_MARGIN_MS);
  const refreshTimer = setTimeout(() => {
    refreshKey(keyId).catch(err => {
      console.warn(`[copilot-session] refresh failed for keyId=${keyId}: ${err?.message ?? err}`);
    });
  }, refreshAfterMs);
  refreshTimer.unref();

  const entry: CacheEntry = {
    sessionToken: ex.sessionToken,
    endpointBase: ex.endpointBase,
    expiresAt: ex.expiresAt,
    refreshTimer,
  };
  cache.set(keyId, entry);
  return entry;
}

/**
 * Forced refresh — re-reads gho_ from DB, exchanges, updates cache.
 * Called by the scheduled timer or by callers that detect a stale
 * cached token via a 401 on inference (future work).
 */
async function refreshKey(keyId: number): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE id = ? AND enabled = 1
  `).get(keyId) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!row) {
    cache.delete(keyId);
    return;
  }
  const githubToken = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  await doExchangeAndCache(keyId, githubToken);
}

/**
 * Invalidate one entry — used when an inference call gets a 401 and
 * we want the next request to re-exchange instead of replaying the
 * stale token. Cancels the refresh timer too.
 */
export function invalidateSession(keyId: number): void {
  const entry = cache.get(keyId);
  if (entry?.refreshTimer) clearTimeout(entry.refreshTimer);
  cache.delete(keyId);
}

/** Test/teardown helper — drops every entry, cancels every timer. */
export function clearAllRefreshTimers(): void {
  for (const entry of cache.values()) {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
  }
  cache.clear();
  pending.clear();
}
