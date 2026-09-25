import { getPostgresPool } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import { updateDegradationState } from './degradation.js';
import type { Scheduler } from '../lib/scheduler.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';

const pool = () => getPostgresPool();

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;
const DEFAULT_HEALTH_CHECK_CONCURRENCY = 8;
const DEFAULT_MIN_SPACING_MS = 1000;

/** Base cadence of the scheduled pass (jittered per run, see
 *  nextHealthCheckDelayMs). Exported for tests. */
export const HEALTH_CHECK_INTERVAL_MS = CHECK_INTERVAL_MS;

// Jitter applied to every scheduled interval, ±20% (4–6 minutes). Two gateways
// started by the same deploy — or one gateway restarted on a cron — otherwise
// probe the same provider on the same phase forever; a per-run offset breaks
// that lock-step and keeps the average cadence at 5 minutes.
const CHECK_INTERVAL_JITTER = 0.2;

// A key validated more recently than this is skipped by the scheduled pass:
// re-asking a provider about a credential it just answered for is exactly the
// traffic #553 is about. Below the jittered minimum interval (4 minutes) so a
// short interval can never skip a whole pass' worth of keys.
export const RECENT_CHECK_SKIP_MS = 3.5 * 60 * 1000;

// Wall-clock ceiling for one pass. Per-provider spacing is compressed rather
// than allowed to push a pass past this, so a large fleet still finishes well
// inside the interval it is scheduled on and the dashboard never shows
// statuses from two passes ago.
export const HEALTH_PASS_TIME_BUDGET_MS = CHECK_INTERVAL_MS / 2;

/** Parallel key probes per health pass. Tunable because the right number depends
 *  on how many keys share one provider; 0 or a bad value falls back to the default. */
function getHealthCheckConcurrency(): number {
  return positiveIntEnv(process.env.HEALTH_CHECK_CONCURRENCY, DEFAULT_HEALTH_CHECK_CONCURRENCY);
}

/** Minimum gap between two probes aimed at the SAME provider (per platform +
 *  base_url). Tunable for operators who know their provider tolerates more or
 *  want to be gentler still; 0 or a bad value falls back to the default. */
function getMinSpacingMs(): number {
  return positiveIntEnv(process.env.HEALTH_CHECK_MIN_SPACING_MS, DEFAULT_MIN_SPACING_MS);
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return fallback;
}

// Track consecutive failures per key
const failureCount = new Map<number, number>();

function recordInvalidFailure(keyId: number, platform?: string): void {
  const count = (failureCount.get(keyId) ?? 0) + 1;
  failureCount.set(keyId, count);

  if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
    pool().query('UPDATE credentials SET enabled = false, updated_at = NOW() WHERE id = $1', [keyId]);
    providerLog(
      'warn',
      `[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`,
      { provider: platform, event: 'key_auto_disabled' },
    );
  }
}

/** Shared query row shape for health checks and probes. */
interface CredentialRow {
  id: number;
  platform: string;
  base_url: string | null;
  credential_name: string;
  encrypted_value: string;
  iv: string;
  auth_tag: string;
  enabled: boolean;
  status: string;
  last_health_error: string | null;
  model_scope: any;
}

const CREDENTIAL_SELECT = `
  SELECT c.id, p.provider_key AS platform, p.base_url,
         c.credential_name, c.encrypted_value, c.iv, c.auth_tag,
         c.enabled, c.last_health_error, c.model_scope
  FROM credentials c
  JOIN providers p ON p.id = c.provider_id
  WHERE c.id = $1
`;

const CREDENTIAL_SELECT_ENABLED = `
  SELECT c.id, p.provider_key AS platform, p.base_url,
         c.credential_name, c.encrypted_value, c.iv, c.auth_tag,
         c.enabled, c.last_health_error, c.model_scope
  FROM credentials c
  JOIN providers p ON p.id = c.provider_id
  WHERE c.id = $1 AND c.enabled = true
`;

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const { rows } = await pool().query<CredentialRow>(CREDENTIAL_SELECT, [keyId]);
  const row = rows[0];
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_value, row.iv, row.auth_tag);
    const validation = await withKeyProxy(decryptProxyUrl(undefined), () => provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'health',
    }));
    const isValid = typeof validation === 'boolean' ? validation : validation.valid;
    const lastError = isValid
      ? null
      : sanitizeProviderErrorMessage(
          typeof validation === 'boolean'
            ? `${provider.name} rejected the API key`
            : validation.error,
        );

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    await pool().query(
      `UPDATE credentials
       SET last_health_error = $1, last_checked_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [lastError, keyId],
    );

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      providerLog(
        'warn',
        `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) invalid: ${lastError}`,
        { provider: row.platform, event: 'key_invalid' },
      );
      recordInvalidFailure(keyId, row.platform);
    }

    return status;
  } catch (err: any) {
    const lastError = sanitizeProviderErrorMessage(err?.message ?? err);
    console.error(
      `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) ` +
      `transport error: ${lastError} — status preserved as 'error'`,
    );
    // Do NOT write status='error'. selectKeyForModel only considers keys with
    // status IN ('healthy','unknown'), so demoting here silently removes the
    // key's capacity for up to a full check interval — and a transport error is
    // evidence about the network, not about the key. Record the diagnostic
    // and the timestamp; leave the verdict to a probe that actually reached the
    // provider.
    await pool().query(
      `UPDATE credentials
       SET last_health_error = $1, last_checked_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [lastError, keyId],
    );
    return 'error';
  }
}

// ── Cooldown-probe validation (side-effect-free) ─────────────────────────────
export type KeyProbeOutcome = 'valid' | 'invalid' | 'error';

export async function probeKeyValidity(keyId: number): Promise<KeyProbeOutcome> {
  try {
    const { rows } = await pool().query<CredentialRow>(CREDENTIAL_SELECT_ENABLED, [keyId]);
    const row = rows[0];
    if (!row) return 'error';

    const provider = resolveProvider(row.platform as Platform, row.base_url);
    if (!provider) return 'error';

    const apiKey = decrypt(row.encrypted_value, row.iv, row.auth_tag);
    const validation = await withKeyProxy(decryptProxyUrl(undefined), () => provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'probe',
    }));
    const isValid = typeof validation === 'boolean' ? validation : validation.valid;
    return isValid ? 'valid' : 'invalid';
  } catch {
    return 'error';
  }
}

/**
 * Promote a key out of 'error' after it successfully served a live request.
 */
export function markKeyHealthyFromRequest(keyId: number): void {
  pool().query(
    `UPDATE credentials
     SET last_health_error = NULL, updated_at = NOW()
     WHERE id = $1 AND last_health_error IS NOT NULL`,
    [keyId],
  ).catch(() => {});
  failureCount.delete(keyId);
}

// Overlap guard
let checkAllInFlight: Promise<HealthPassResult> | null = null;

interface HealthKeyRow {
  id: number;
  platform: string;
  base_url: string | null;
  enabled: boolean;
  last_health_error: string | null;
  cooldown_until: Date | null;
  age_ms: number | null;
}

export interface HealthPassOptions {
  force?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  check?: (keyId: number) => Promise<unknown>;
  concurrency?: number;
  minSpacingMs?: number;
}

export interface HealthPassResult {
  checkedKeyIds: number[];
  skippedKeyIds: number[];
}

function providerBucket(row: HealthKeyRow): string {
  return row.base_url ? `${row.platform}|${row.base_url}` : row.platform;
}

export function interleaveByProvider<T>(rows: T[], bucketOf: (row: T) => string): T[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = bucketOf(row);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  const lists = [...buckets.values()];
  const out: T[] = [];
  for (let i = 0; out.length < rows.length; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]!);
    }
  }
  return out;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function checkAllKeys(opts: HealthPassOptions = {}): Promise<HealthPassResult> {
  if (checkAllInFlight) return checkAllInFlight;
  checkAllInFlight = runHealthPass(opts).finally(() => {
    checkAllInFlight = null;
  });
  void checkAllInFlight.then(() => updateDegradationState());
  return checkAllInFlight;
}

async function runHealthPass(opts: HealthPassOptions): Promise<HealthPassResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const check = opts.check ?? checkKeyHealth;

  const { rows } = await pool().query<HealthKeyRow>(`
    SELECT c.id, p.provider_key AS platform, p.base_url,
           c.enabled, c.last_health_error, c.cooldown_until,
           EXTRACT(EPOCH FROM (NOW() - c.last_checked_at)) * 1000 AS age_ms
    FROM credentials c
    JOIN providers p ON p.id = c.provider_id
    WHERE c.enabled = true
  `);

  const skippedKeyIds: number[] = [];
  const due = rows.filter(row => {
    if (opts.force) return true;
    if (row.last_health_error) return true;
    if (row.age_ms !== null && row.age_ms < RECENT_CHECK_SKIP_MS) {
      skippedKeyIds.push(row.id);
      return false;
    }
    return true;
  });

  const queue = interleaveByProvider(due, providerBucket);
  const perBucket = new Map<string, number>();
  for (const row of queue) {
    const bucket = providerBucket(row);
    perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
  }
  const largestBucket = Math.max(0, ...perBucket.values());
  const requestedSpacing = opts.minSpacingMs ?? getMinSpacingMs();
  const spacingMs = opts.force || largestBucket < 2
    ? 0
    : Math.min(requestedSpacing, Math.floor(HEALTH_PASS_TIME_BUDGET_MS / (largestBucket - 1)));

  console.log(
    `[Health] Checking ${queue.length} keys` +
    (skippedKeyIds.length > 0 ? ` (${skippedKeyIds.length} checked recently, skipped)` : '') +
    (spacingMs > 0 ? ` — ${spacingMs}ms between probes of the same provider` : '') + '...',
  );

  const concurrency = opts.concurrency ?? getHealthCheckConcurrency();
  const nextAllowedAt = new Map<string, number>();
  const checkedKeyIds: number[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const key = queue[cursor++]!;
      if (spacingMs > 0) {
        const bucket = providerBucket(key);
        const slot = Math.max(nextAllowedAt.get(bucket) ?? 0, now());
        nextAllowedAt.set(bucket, slot + spacingMs);
        const wait = slot - now();
        if (wait > 0) await sleep(wait);
      }
      checkedKeyIds.push(key.id);
      try {
        await check(key.id);
      } catch (err) {
        console.error(`[Health] Key ${key.id} check threw:`, err);
      }
    }
  });
  await Promise.all(workers);

  console.log(`[Health] Check complete.`);
  return { checkedKeyIds, skippedKeyIds };
}

export function nextHealthCheckDelayMs(jitter: () => number = Math.random): number {
  return Math.round(CHECK_INTERVAL_MS * (1 + (jitter() * 2 - 1) * CHECK_INTERVAL_JITTER));
}

let cancelHealthCheck: (() => void) | null = null;
let healthCheckerRunning = false;

export function startHealthChecker(scheduler: Scheduler): void {
  if (healthCheckerRunning) return;
  healthCheckerRunning = true;
  console.log(
    `[Health] Starting health checker (every ~${CHECK_INTERVAL_MS / 1000}s ±${CHECK_INTERVAL_JITTER * 100}%)`,
  );
  const scheduleNext = (): void => {
    cancelHealthCheck = scheduler.after(nextHealthCheckDelayMs(), async () => {
      try {
        await checkAllKeys();
      } catch (err) {
        console.error('[Health] Check failed:', err);
      }
      if (healthCheckerRunning) scheduleNext();
    });
  };
  scheduleNext();
}

export function stopHealthChecker(): void {
  healthCheckerRunning = false;
  if (cancelHealthCheck) {
    cancelHealthCheck();
    cancelHealthCheck = null;
  }
}
