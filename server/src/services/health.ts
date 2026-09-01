import { getDb } from '../db/index.js';
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
    getDb().prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
    // providerLog, not console.log: losing a key is the event an operator is
    // most likely to be looking for after the fact, so it goes to the dashboard
    // log viewer (where warn/error survive a restart) as well as to stdout —
    // which providerLog still writes, so nothing here is only visible behind a
    // login. Raised to warn for the same reason.
    providerLog(
      'warn',
      `[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`,
      { provider: platform, event: 'key_auto_disabled' },
    );
  }
}

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    // #590: probe the key from the same exit its traffic uses. A key that is
    // only reachable through its own proxy (the reason to set one) would
    // otherwise be validated direct, fail, and be auto-disabled after three
    // checks while real requests through the proxy were working fine.
    const validation = await withKeyProxy(decryptProxyUrl(row), () => provider.validateKey(apiKey, {
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

    db.prepare("UPDATE api_keys SET status = ?, last_health_error = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, lastError, keyId);

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
    // Transport errors (DNS/timeout/TLS) — provider unreachable, not necessarily
    // a bad key. Mark status='error' but do NOT increment failure counter — auto-
    // disable is reserved for confirmed 401/403 (returned by validateKey as false).
    // Include platform + base_url so a flapping CloudFront edge or DNS failure is
    // attributable to the responsible provider in one log read. The leading
    // "[Health] Key N (" prefix is preserved so the 12-hourly crash watchdog
    // (cron bff5ae167d28) that scrapes /tmp/freellmapi.log for these lines
    // continues to match unchanged.
    const lastError = sanitizeProviderErrorMessage(err?.message ?? err);
    console.error(
      `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) ` +
      `transport error: ${lastError} — status preserved as '${row.status}'`,
    );
    // Do NOT write status='error'. selectKeyForModel only considers keys with
    // status IN ('healthy','unknown'), so demoting here silently removes the
    // key's capacity for up to a full check interval — and a transport error is
    // evidence about the network, not about the key. One flaky DNS lookup, a
    // laptop suspended for thirty seconds, or a provider edge outage would take
    // every key on that provider out of rotation at once. Record the diagnostic
    // and the timestamp; leave the verdict to a probe that actually reached the
    // provider. Confirmed 401/403 (the isValid=false path above) still demotes.
    db.prepare("UPDATE api_keys SET last_health_error = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(lastError, keyId);
    return row.status as KeyStatus;
  }
}

// ── Cooldown-probe validation (side-effect-free) ─────────────────────────────
// The cooldown-probe recovery job (services/cooldown-probe.ts) needs the same
// cheap validateKey call checkKeyHealth makes, WITHOUT any of its bookkeeping:
// no status writes, no last_checked_at, and above all no failureCount — probes
// run far more often than the 5-minute health pass, so letting them feed the
// consecutive-failure counter would auto-disable a genuinely-bad key in a
// fraction of the "3 consecutive checks" the threshold promises. A probe is a
// question, never a verdict.

export type KeyProbeOutcome = 'valid' | 'invalid' | 'error';

export async function probeKeyValidity(keyId: number): Promise<KeyProbeOutcome> {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1').get(keyId) as any;
    if (!row) return 'error';

    const provider = resolveProvider(row.platform as Platform, row.base_url);
    if (!provider) return 'error';

    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    // Same reasoning as checkKeyHealth: probe through the key's own proxy (#590).
    const validation = await withKeyProxy(decryptProxyUrl(row), () => provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'probe',
    }));
    const isValid = typeof validation === 'boolean' ? validation : validation.valid;
    return isValid ? 'valid' : 'invalid';
  } catch {
    // Transport error (DNS/timeout/TLS): inconclusive, same as checkKeyHealth's
    // reasoning — evidence about the network, not the key.
    return 'error';
  }
}

/**
 * Promote a key out of 'error' after it successfully served a live request.
 *
 * Serving traffic is stronger evidence than any probe, so a key stuck at 'error'
 * from an earlier transport blip should not have to wait for the next health pass
 * to become routable again. Deliberately narrow: 'invalid' means a provider
 * confirmed the credential is bad, and only a real validateKey pass clears that.
 */
export function markKeyHealthyFromRequest(keyId: number): void {
  try {
    getDb()
      .prepare("UPDATE api_keys SET status = 'healthy', last_health_error = NULL WHERE id = ? AND status = 'error'")
      .run(keyId);
    failureCount.delete(keyId);
  } catch {
    // Never let health bookkeeping break a request that already succeeded.
  }
}

// Overlap guard: the scheduled 5-minute pass and wake-recovery re-probes can
// coincide (or SIGCONT spam can queue several) — concurrent full passes
// multiply provider validate traffic and let two passes each increment the
// same genuinely-bad key's failureCount, reaching the auto-disable threshold
// in fewer wall-clock checks than "3 consecutive checks" intends. A second
// caller joins the in-flight pass instead of starting another.
let checkAllInFlight: Promise<HealthPassResult> | null = null;

interface HealthKeyRow {
  id: number;
  platform: string;
  base_url: string | null;
  status: string;
  age_ms: number | null;
}

export interface HealthPassOptions {
  /** Probe every enabled key now: no recency skip, no per-provider spacing.
   *  Used by the dashboard's "check all" button and the post-wake re-probe,
   *  where the point is an immediate, complete picture. */
  force?: boolean;
  /** Test seams: injectable clock, sleep, probe and pool size, mirroring the
   *  cooldown-probe pass so a pacing test needs no real timers. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  check?: (keyId: number) => Promise<unknown>;
  concurrency?: number;
  minSpacingMs?: number;
}

export interface HealthPassResult {
  /** Keys probed this pass, in the order the pass started them. */
  checkedKeyIds: number[];
  /** Enabled keys left alone because they were validated recently. */
  skippedKeyIds: number[];
}

/** The provider a probe actually lands on: two openai-compat keys pointed at
 *  different base URLs are different hosts and need no spacing between them. */
function providerBucket(row: HealthKeyRow): string {
  return row.base_url ? `${row.platform}|${row.base_url}` : row.platform;
}

/**
 * Round-robin the queue across providers: one key from each provider, then the
 * next from each, and so on. Raw DB order is provider-clustered (keys are added
 * a provider at a time), which is what turned a fleet with 40 keys on one
 * provider into 40 back-to-back requests from one IP (#553). Exported for tests.
 */
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
  // A caller that arrives mid-pass joins it (including a forced one — the
  // in-flight pass is already probing, and stacking a second set of validates
  // on the same providers is the exact behaviour this guard exists to prevent).
  if (checkAllInFlight) return checkAllInFlight;
  checkAllInFlight = runHealthPass(opts).finally(() => {
    checkAllInFlight = null;
  });
  // Keep the degraded-mode state machine in step with the latest verdicts
  // (#904): a fleet-wide outage should flip the gateway into degraded mode
  // shortly after the pass that observed it, not after the next request.
  void checkAllInFlight.then(() => updateDegradationState());
  return checkAllInFlight;
}

async function runHealthPass(opts: HealthPassOptions): Promise<HealthPassResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const check = opts.check ?? checkKeyHealth;
  const db = getDb();

  // age_ms comes from the DB clock (last_checked_at is written as
  // datetime('now')); the injected `now` above only drives pacing.
  const rows = db.prepare(`
    SELECT id, platform, base_url, status,
           CAST((julianday('now') - julianday(last_checked_at)) * 86400000 AS INTEGER) AS age_ms
    FROM api_keys WHERE enabled = 1
  `).all() as HealthKeyRow[];

  const skippedKeyIds: number[] = [];
  const due = rows.filter(row => {
    if (opts.force) return true;
    // A key parked at 'error' is out of rotation until a probe says otherwise
    // (the router writes that status, and last_checked_at with it), so it is
    // never skipped — it is the one key whose verdict is worth re-asking for.
    if (row.status === 'error') return true;
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
  // Spacing shrinks rather than letting a big fleet run past the budget: the
  // provider with the most keys sets the pass length, so its gaps are what the
  // budget has to divide.
  const requestedSpacing = opts.minSpacingMs ?? getMinSpacingMs();
  const spacingMs = opts.force || largestBucket < 2
    ? 0
    : Math.min(requestedSpacing, Math.floor(HEALTH_PASS_TIME_BUDGET_MS / (largestBucket - 1)));

  console.log(
    `[Health] Checking ${queue.length} keys` +
    (skippedKeyIds.length > 0 ? ` (${skippedKeyIds.length} checked recently, skipped)` : '') +
    (spacingMs > 0 ? ` — ${spacingMs}ms between probes of the same provider` : '') + '...',
  );

  // Bounded worker pool rather than a sequential await. validateKey allows up
  // to 30s per key (some provider /models endpoints are genuinely that slow),
  // so a serial pass over a large key fleet can outlast the 5-minute interval
  // it is scheduled on and leave the dashboard showing stale statuses. The cap
  // keeps us from opening one socket per key against the same provider.
  const concurrency = opts.concurrency ?? getHealthCheckConcurrency();
  const nextAllowedAt = new Map<string, number>();
  const checkedKeyIds: number[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const key = queue[cursor++]!;
      if (spacingMs > 0) {
        // Reserve the slot BEFORE awaiting, so two workers that pick up keys on
        // the same provider queue behind each other instead of both waiting for
        // the same instant and firing together.
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
        // checkKeyHealth handles its own errors; this is a backstop so one
        // rejection cannot abandon the rest of the pass.
        console.error(`[Health] Key ${key.id} check threw:`, err);
      }
    }
  });
  await Promise.all(workers);

  console.log(`[Health] Check complete.`);
  return { checkedKeyIds, skippedKeyIds };
}

/** Delay until the next scheduled pass: the base interval ±20%, so restarts and
 *  co-deployed gateways don't stay phase-locked on the same providers. */
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
  // Self-rescheduling one-shot timers rather than a fixed interval: each pass
  // picks its own jittered delay (see nextHealthCheckDelayMs), and the next one
  // is only armed once the current pass has finished.
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
