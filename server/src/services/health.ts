import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between full checks
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

// Circuit breaker: pause provider after consecutive failures
const CIRCUIT_BREAKER_FAILURES = 3;
const CIRCUIT_BREAKER_PAUSE_MS = 5 * 60 * 1000; // 5 min cooldown

// Track consecutive failures and circuit breaker state per platform
const failureCount = new Map<number, number>();
const platformCircuitBreaker = new Map<string, { failures: number; pauseUntil: number }>();

/**
 * Check if a platform is currently in circuit-breaker pause.
 */
function isPlatformCircuitOpen(platform: string): boolean {
  const cb = platformCircuitBreaker.get(platform);
  if (!cb) return false;
  if (Date.now() > cb.pauseUntil) {
    // Circuit half-open: reset failure count, allow one probe
    cb.failures = 0;
    return false;
  }
  return true;
}

/**
 * Record a failure for circuit breaker.
 */
function recordPlatformFailure(platform: string): void {
  const existing = platformCircuitBreaker.get(platform) ?? { failures: 0, pauseUntil: 0 };
  existing.failures++;

  if (existing.failures >= CIRCUIT_BREAKER_FAILURES) {
    existing.pauseUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
    console.log(`[Health] Circuit breaker OPEN for ${platform} (pausing checks for 5 min)`);
  }

  platformCircuitBreaker.set(platform, existing);
}

/**
 * Record a success for circuit breaker (resets failure count).
 */
function recordPlatformSuccess(platform: string): void {
  platformCircuitBreaker.delete(platform);
}

/**
 * Check health of a single key.
 * Returns cached status if platform is in circuit-breaker pause.
 */
export async function checkKeyHealth(keyId: number, skipPlatformCheck = false): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  // Check circuit breaker for this platform (skip on first check during startup)
  if (!skipPlatformCheck && isPlatformCircuitOpen(row.platform)) {
    return row.status as KeyStatus ?? 'unknown';
  }

  const provider = getProvider(row.platform as Platform);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey);

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);

    if (isValid) {
      failureCount.delete(keyId);
      recordPlatformSuccess(row.platform);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }

      recordPlatformFailure(row.platform);
    }

    return status;
  } catch (err: any) {
    console.error(`[Health] Key ${keyId} transport error:`, err.message);
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run('error', keyId);
    return 'error';
  }
}

/**
 * Check all keys with staggered delays between batches.
 * Batch size and delay tuned to avoid triggering provider rate limits.
 */
export async function checkAllKeys(): Promise<void> {
  const db = getDb();
  const keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];

  if (keys.length === 0) {
    console.log('[Health] No enabled keys to check');
    return;
  }

  console.log(`[Health] Checking ${keys.length} keys (staggered)...`);

  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 2000; // 2 seconds between batches

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);

    // Process batch in parallel
    await Promise.all(batch.map(key => checkKeyHealth(key.id)));

    // Wait between batches (except for last batch)
    if (i + BATCH_SIZE < keys.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log('[Health] Check complete.');
}

/**
 * Lightweight health check that updates timestamps without full validation.
 * Used for the dashboard health endpoint.
 */
export function getQuickHealthSummary(): { total: number; healthy: number; unhealthy: number } {
  const db = getDb();
  const keys = db.prepare('SELECT status FROM api_keys').all() as { status: string }[];

  return {
    total: keys.length,
    healthy: keys.filter(k => k.status === 'healthy').length,
    unhealthy: keys.filter(k => k.status !== 'healthy' && k.status !== 'unknown').length,
  };
}

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the health checker. Non-blocking — runs first check after initial delay.
 */
export function startHealthChecker(): void {
  if (intervalId) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);

  // Run first check after 30s delay (not immediately on startup)
  setTimeout(() => {
    checkAllKeys().catch(err => console.error('[Health] Initial check failed:', err));
  }, 30_000);

  // Subsequent checks at regular interval
  intervalId = setInterval(() => {
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err));
  }, CHECK_INTERVAL_MS);
}

export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}