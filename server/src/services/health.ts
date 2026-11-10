import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { BaseProvider } from '../providers/base.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import { updateDegradationState } from './degradation.js';
import type { Scheduler } from '../lib/scheduler.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';
import { triggerBuiltinModelDiscovery } from './builtin-model-discovery.js';

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Floor of 60s: a misconfigured tiny interval turns the health pass into a
// self-inflicted abuse-shaped flood, which is the exact traffic #553/#1599 are
// about. Anything below the floor falls back to the default.
const MIN_CHECK_INTERVAL_MS = 60 * 1000;
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;
const DEFAULT_HEALTH_CHECK_CONCURRENCY = 8;
const DEFAULT_MIN_SPACING_MS = 1000;

/** Base cadence of the scheduled pass (jittered per run, see
 *  nextHealthCheckDelayMs), tunable via HEALTH_CHECK_INTERVAL_MS (#1593):
 *  fleets on providers that dislike frequent key checks
 *  want a slower pass; a fresh install being shaken out wants a faster one.
 *  Read once at module load — the scheduler re-arms from the same constant. */
function getCheckIntervalMs(): number {
  const n = positiveIntEnv(process.env.HEALTH_CHECK_INTERVAL_MS, DEFAULT_CHECK_INTERVAL_MS);
  return n < MIN_CHECK_INTERVAL_MS ? DEFAULT_CHECK_INTERVAL_MS : n;
}
const CHECK_INTERVAL_MS = getCheckIntervalMs();

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
// traffic #553 is about. Capped at 70% of the configured interval so a faster
// HEALTH_CHECK_INTERVAL_MS can never skip a whole pass' worth of keys (the
// invariant nextHealthCheckDelayMs asserts).
export const RECENT_CHECK_SKIP_MS = Math.min(3.5 * 60 * 1000, CHECK_INTERVAL_MS * 0.7);

// #1599: how often the scheduled pass re-asks about a key parked at 'error' on
// a provider that must not be polled (supportsKeyPolling === false). Healthy
// and invalid keys on those providers are never re-validated on a schedule.
export const NO_POLL_ERROR_REPROBE_MS = 60 * 60 * 1000;

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

// #1510: consecutive transport errors per key. A key whose provider has been
// unreachable (DNS, connection refused, TCP timeout) for this many probes in a
// row is parked at status='error'. Unlike 'invalid' this is NOT an auto-disable:
// 'error' keys are re-probed on every pass (never recency-skipped — see the
// checkAllKeys due filter) and any live request that serves restores them
// (markKeyHealthyFromRequest), so a provider outage that heals needs no
// operator action. At the 5-minute cadence the threshold is ~30 minutes of
// total unreachability — far past any single blip, and the point where a key
// still marked 'healthy' is provably worse than no key: the router keeps
// handing it traffic, every attempt dies, and failover costs the request its
// latency budget (#1510 measured 264 failures vs 8 successes in a day on a
// 39-key install with zero keys ever showing 'error').
//
// Opt-in: HEALTH_TRANSPORT_PARK_AFTER sets the streak length (6 is the
// suggested value, ~30 minutes at the default cadence). Unset or 0 keeps the
// default "keep trying" behaviour: a transport error never takes a key out of
// rotation, because a key the router stops using can only come back through a
// probe, and a provider whose validation endpoint is down while chat still
// works would otherwise lose every key at once.
export const SUGGESTED_TRANSPORT_PARK_AFTER = 6;

/** Streak length that parks a key, or 0 when parking is off (the default). */
export function getTransportParkAfter(): number {
  return positiveIntEnv(process.env.HEALTH_TRANSPORT_PARK_AFTER, 0);
}

const transportFailures = new Map<number, number>();

/** Test seam: drop transport-parking state. */
export function clearTransportFailureState(): void {
  transportFailures.clear();
}

/** Increment and apply the park rule. A 429 never reaches here — the caller
 *  treats it as proof the provider is reachable. Returns true when this call
 *  parked the key (status written to 'error'). */
function recordTransportFailure(keyId: number, platform: string | undefined): boolean {
  const parkAfter = getTransportParkAfter();
  if (parkAfter === 0) return false;
  const count = (transportFailures.get(keyId) ?? 0) + 1;
  transportFailures.set(keyId, count);
  if (count < parkAfter) return false;

  // Park: 'error' is out of rotation (the router only routes healthy/unknown)
  // but stays eligible for re-probing and self-heals. Never touch 'invalid' —
  // a confirmed-bad credential verdict outranks network evidence in both
  // directions, and only a successful validateKey clears it.
  const db = getDb();
  const res = db
    .prepare("UPDATE api_keys SET status = 'error' WHERE id = ? AND enabled = 1 AND status IN ('healthy', 'unknown')")
    .run(keyId);
  if (res.changes > 0) {
    providerLog(
      'warn',
      `[Health] Key ${keyId} (${platform}) parked as 'error' after ${count} consecutive transport failures`,
      { provider: platform, event: 'key_transport_park' },
    );
  }
  return res.changes > 0;
}

// A key whose last validation was rate-limited (429) is skipped by the
// scheduled pass until the skip window passes: re-asking a provider that just
// told us to slow down is how validation traffic becomes a ban. LLMTR's
// validator is a POST to /chat/completions with a nonexistent model —
// shaped exactly like the bot traffic their abuse system hunts — so an
// unpaced re-ask every 5 minutes per key kept accounts flagged (#1369).
// Forced passes (dashboard check-all, wake re-probe) still probe: explicit
// operator intent wins over pacing. A later successful validation clears the
// mark; validation that never ran leaves no mark.
const validationRateLimitedAt = new Map<number, number>();

const DEFAULT_VALIDATION_RATE_LIMIT_SKIP_MS = 60 * 60 * 1000;

/** How long a 429ed key stays out of the scheduled pass. Tunable like the
 *  other pacing knobs; 0 or a bad value falls back to the default. */
function getValidationRateLimitSkipMs(): number {
  return positiveIntEnv(process.env.HEALTH_CHECK_RATE_LIMIT_SKIP_MS, DEFAULT_VALIDATION_RATE_LIMIT_SKIP_MS);
}

/** Record that validating this key was just rate-limited. Exported for tests;
 *  production calls it from checkKeyHealth's 429 path. */
export function recordValidationRateLimited(keyId: number, atMs = Date.now()): void {
  validationRateLimitedAt.set(keyId, atMs);
}

/** Test seam: drop all validation-429 pacing state. */
export function clearValidationRateLimitState(): void {
  validationRateLimitedAt.clear();
}

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

/**
 * Provider-reported quota polling (#1403 phase 1). Providers with a key-info
 * endpoint (see BaseProvider.fetchQuota) get polled right after a health pass
 * confirms the key works, so the dashboard shows the provider's own balance
 * instead of a regex guess over catalog text. Throttled per key: a poll is
 * only worth taking when the last quota_api observation is older than
 * QUOTA_POLL_INTERVAL_MS (or none exists). Fire-and-forget and failure-silent:
 * a quota probe says nothing about key validity and must never bend a health
 * verdict or the pass budget.
 */
export const QUOTA_POLL_INTERVAL_MS = 15 * 60 * 1000;

function quotaPollDue(keyId: number, now = Date.now()): boolean {
  const row = getDb().prepare(`
    SELECT created_at AS seenAt FROM provider_quota_observations
     WHERE key_id = ? AND source = 'quota_api'
     ORDER BY created_at DESC LIMIT 1
  `).get(keyId) as { seenAt: string | null } | undefined;
  if (!row?.seenAt) return true;
  const seen = Date.parse(row.seenAt.includes('T') ? row.seenAt : row.seenAt.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(seen)) return true;
  return now - seen >= QUOTA_POLL_INTERVAL_MS;
}

export async function pollKeyQuota(
  keyId: number,
  // The api_keys row as stored (encrypted key columns + the proxy columns
  // decryptProxyUrl reads). `any` mirrors how checkKeyHealth carries it.
  row: any,
  provider: BaseProvider,
): Promise<boolean> {
  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    return await withKeyProxy(decryptProxyUrl(row), () => provider.fetchQuota(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'quota_api',
      origin: 'health',
    }));
  } catch {
    // Inconclusive by construction: never throws into the health pass.
    return false;
  }
}

/** True when this provider actually has a quota endpoint to probe (#1403).
 *  Uses the provider's own hasQuotaProbe getter: OpenAICompatProvider
 *  overrides fetchQuota for every instance, spec or not, so a method-identity
 *  check would claim quota support for specless platforms. */
export function supportsQuotaPolling(provider: BaseProvider): boolean {
  return provider.hasQuotaProbe;
}

/** Throttled, self-contained quota poll for one key — the entry point other
 *  services (or a future scheduler) can use without duplicating the gate. */
export async function maybePollKeyQuota(keyId: number): Promise<boolean> {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1').get(keyId) as any;
    if (!row) return false;
    const provider = resolveProvider(row.platform as Platform, row.base_url);
    if (!provider || !supportsQuotaPolling(provider)) return false;
    if (!quotaPollDue(keyId)) return false;
    return await pollKeyQuota(keyId, row, provider);
  } catch {
    return false;
  }
}

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  // #1459: a provider that forbids automated key checks gets no probe. Its
  // status is left to real traffic (markKeyHealthyFromRequest), and any reason
  // an older probe stored is cleared so the dashboard stops showing it.
  if (provider.supportsKeyValidation === false) {
    if (row.last_health_error != null) {
      db.prepare('UPDATE api_keys SET last_health_error = NULL WHERE id = ?').run(keyId);
    }
    return row.status as KeyStatus;
  }

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

    // #1493: stamp last_healthy_at only on a VALID verdict. A transport error
    // (the catch below) refreshes last_checked_at but records no success, so
    // "checked recently" and "worked recently" stay distinguishable.
    // #1516 (display-only): a valid probe only ever proves /models answered,
    // so it records verification_basis = 'models_only' — but only when the
    // key has no basis yet, so a probe never downgrades a key a real request
    // already proved ('inference_verified'). An invalid verdict clears the
    // basis: whatever was proved no longer holds. A transport error (catch
    // below) leaves the basis alone.
    db.prepare(isValid
      ? "UPDATE api_keys SET status = ?, last_health_error = ?, last_checked_at = datetime('now'), last_healthy_at = datetime('now'), verification_basis = COALESCE(verification_basis, 'models_only') WHERE id = ?"
      : "UPDATE api_keys SET status = ?, last_health_error = ?, last_checked_at = datetime('now'), verification_basis = NULL WHERE id = ?")
      .run(status, lastError, keyId);

    if (isValid) {
      failureCount.delete(keyId);
      // #1510: the provider answered — whatever unreachable streak this key had
      // is over, so the transport counter starts from zero again.
      transportFailures.delete(keyId);
      // The provider answered again: whatever rate-limit told us to back off
      // is over, so the key rejoins the normal cadence.
      validationRateLimitedAt.delete(keyId);
      // #1348: a healthy key on a built-in platform the catalog does not carry
      // serves nothing until its models are discovered. Fire-and-forget; the
      // trigger is a no-op for every other platform, and throttled.
      triggerBuiltinModelDiscovery(db, row.platform, 'healthy');
      // #1403: piggyback provider-reported quota polling on the healthy
      // verdict — but only for providers with a quota endpoint, and at most
      // once per QUOTA_POLL_INTERVAL_MS per key. Fire-and-forget, silent.
      if (supportsQuotaPolling(provider) && quotaPollDue(keyId)) {
        void pollKeyQuota(keyId, row, provider).catch(() => {});
      }
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
    // A 429 here means the provider rate-limited the validation itself:
    // remember it so the scheduled pass backs off instead of re-asking every
    // 5 minutes (#1369). Other transport errors carry no such instruction.
    if (err?.status === 429) recordValidationRateLimited(keyId);
    const lastError = sanitizeProviderErrorMessage(err?.message ?? err);
    console.error(
      `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) ` +
      `transport error: ${lastError} — status preserved as '${row.status}'`,
    );
    // Do NOT write status='error' on the first transport failure. selectKeyForModel
    // only considers keys with status IN ('healthy','unknown'), so demoting here
    // silently removes the key's capacity for up to a full check interval — and a
    // transport error is evidence about the network, not about the key. One flaky
    // DNS lookup, a laptop suspended for thirty seconds, or a provider edge outage
    // would take every key on that provider out of rotation at once. Record the
    // diagnostic and the timestamp; leave the verdict to a probe that actually
    // reached the provider. Confirmed 401/403 (the isValid=false path above) still
    // demotes.
    //
    // #1510 adds the accumulation this path was missing (opt-in via
    // HEALTH_TRANSPORT_PARK_AFTER): a key that has been unreachable that many
    // probes in a row is parked at 'error' — still re-probed every pass, self-healing on the first answer
    // or served request, but no longer first-class routing capacity. A 429 is
    // proof the provider is reachable, so it counts as a break in the streak,
    // not an increment.
    let parked = false;
    if (err?.status === 429) transportFailures.delete(keyId);
    else parked = recordTransportFailure(keyId, row.platform);
    db.prepare("UPDATE api_keys SET last_health_error = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(lastError, keyId);
    return (parked ? 'error' : row.status) as KeyStatus;
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
    // #1459: no probe for a provider that forbids them; the cooldown simply
    // runs out, as it would after an inconclusive probe.
    if (provider.supportsKeyValidation === false) return 'error';
    // #1599: the probe would be the same empty search the health pass no
    // longer sends on a schedule; let the cooldown run out instead.
    if (provider.supportsKeyPolling === false) return 'error';

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
 * #1493: throttle for the last_healthy_at write from live traffic. The probe
 * path already writes the column at most once per health pass, but this
 * function runs on every successful proxied request, and an unthrottled UPDATE
 * would put a DB write on the hot path. One stamp per key per minute is plenty
 * for "last worked N ago".
 */
const lastHealthyStampedAt = new Map<number, number>();
const LAST_HEALTHY_STAMP_INTERVAL_MS = 60_000;

/** Test seam: drop the stamp throttle so a test can observe consecutive writes. */
export function clearLastHealthyStampState(): void {
  lastHealthyStampedAt.clear();
}

/**
 * Promote a key out of 'error' or 'unknown' after it successfully served a live
 * request.
 *
 * Serving traffic is stronger evidence than any probe, so a key stuck at 'error'
 * from an earlier transport blip should not have to wait for the next health pass
 * to become routable again, and a key never probed yet (or one whose provider
 * forbids probes, #1459) has just proved itself. Deliberately narrow: 'invalid'
 * means a provider confirmed the credential is bad, and only a real validateKey
 * pass clears that.
 */
export function markKeyHealthyFromRequest(keyId: number): void {
  try {
    // #1493: a served request is the strongest "this key works" evidence there
    // is — stamp last_healthy_at regardless of current status. This is the only
    // success signal for providers with supportsKeyValidation === false (#1459),
    // which never get a probe. Throttled in memory, not per request.
    const now = Date.now();
    const lastStamp = lastHealthyStampedAt.get(keyId);
    if (lastStamp === undefined || now - lastStamp >= LAST_HEALTHY_STAMP_INTERVAL_MS) {
      lastHealthyStampedAt.set(keyId, now);
      getDb()
        // #1516 (display-only): a served request is real inference, so it
        // upgrades the basis to 'inference_verified' — the strongest
        // evidence a key can carry, and no probe may downgrade it later.
        .prepare("UPDATE api_keys SET last_healthy_at = datetime('now'), verification_basis = 'inference_verified' WHERE id = ?")
        .run(keyId);
    }
    getDb()
      .prepare("UPDATE api_keys SET status = 'healthy', last_health_error = NULL WHERE id = ? AND status IN ('error', 'unknown')")
      .run(keyId);
    failureCount.delete(keyId);
    // #1510: a served request is the strongest reachability evidence there is —
    // it also ends any transport-error streak, parked or not.
    transportFailures.delete(keyId);
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
  /** Someone pressed "Check all": also validate keys on providers that must
   *  not be polled (#1599). The post-wake re-probe is forced but automatic, so
   *  it leaves them alone. */
  manual?: boolean;
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
  const skipMs = opts.force ? 0 : getValidationRateLimitSkipMs();
  const due = rows.filter(row => {
    // #1599: a provider whose key check is an empty search gets one check per
    // new key, not one every pass. Applies to forced automatic passes too.
    if (!opts.manual && resolveProvider(row.platform as Platform, row.base_url)?.supportsKeyPolling === false) {
      const floorMs = row.status === 'error' ? NO_POLL_ERROR_REPROBE_MS : Infinity;
      if (row.age_ms !== null && row.age_ms < floorMs) {
        skippedKeyIds.push(row.id);
        return false;
      }
      return true;
    }
    if (opts.force) return true;
    // A key the provider just rate-limited stays out until the skip window
    // passes — even one parked at 'error'. A 429 is fresher, more specific
    // evidence than the eagerness to re-ask an errored key (#1369).
    const limitedAt = validationRateLimitedAt.get(row.id);
    if (limitedAt !== undefined && now() - limitedAt < skipMs) {
      skippedKeyIds.push(row.id);
      return false;
    }
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
