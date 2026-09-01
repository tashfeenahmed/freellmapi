// cooldown-probe — probe-based early recovery for benched keys.
//
// Cooldowns are deliberately pessimistic: a transient 429 benches a model+key
// for 90s, the escalation ladder for up to a day, and an upstream 401 for the
// whole 5-minute health cycle. When the provider recovers sooner (a per-minute
// window rolled over, a provider incident ended, a key was un-revoked), that
// capacity sits idle until the timer runs out. This job periodically issues the
// same cheap validateKey call the health checker uses against keys sitting in a
// HEURISTIC cooldown, and clears those cooldowns early when the probe passes.
//
// What it will never do:
//   - probe a cooldown backed by an authoritative retry time (explicit
//     Retry-After, daily-quota reset) or a credit/tier bench — those are
//     provider-stated facts, filtered out at the query (getProbeableCooldowns);
//   - extend a cooldown: a failed probe only schedules the next probe further
//     out (exponential backoff), the bench itself is untouched;
//   - feed the health checker's consecutive-failure counter (probeKeyValidity
//     is side-effect-free by design);
//   - thundering-herd providers after a restart: a key's first sighting only
//     schedules a jittered probe, and each pass probes at most a handful of
//     keys.
//
// The probe unit is the KEY, not the model: validateKey exercises the
// credential, so one pass/fail is the same evidence for every heuristic
// cooldown that key holds, and probing per key is what keeps probe traffic
// bounded no matter how many models are benched on it.
//
// Kill switch: COOLDOWN_PROBE_DISABLED=1 (same convention as
// CATALOG_SYNC_DISABLED). Per-pass probe budget: COOLDOWN_PROBE_MAX_PER_PASS.

import type { Scheduler } from '../lib/scheduler.js';
import {
  getProbeableCooldowns,
  clearCooldownEarly,
  type ProbeableCooldown,
} from './ratelimit.js';
import { probeKeyValidity, type KeyProbeOutcome } from './health.js';
import { providerLog } from '../lib/server-logs.js';

// How often the scanner wakes up to look at the cooldown table. Scanning is one
// cheap indexed SELECT; actual probes are gated far harder below.
const SCAN_INTERVAL_MS = 60 * 1000;

// A cooldown only becomes probe-ripe after this fraction of its bench has been
// served. Probing a seconds-old cooldown would mostly re-confirm the failure
// that caused it; by half-time a transient condition has had a real chance to
// clear, and long escalated benches still recover hours early.
const MIN_ELAPSED_FRACTION = 0.5;

// Not worth probing a cooldown that is about to expire on its own — the probe
// would cost a validate call to save less than a scan interval of idle time.
const MIN_REMAINING_MS = 60 * 1000;

// Failed-probe backoff per key: 2m, 4m, 8m, capped at 15m. Keys that stay bad
// converge to one validate call per 15 minutes — a third of what the 5-minute
// health pass already sends them.
const PROBE_BACKOFF_BASE_MS = 2 * 60 * 1000;
const PROBE_BACKOFF_MAX_MS = 15 * 60 * 1000;

// Stagger window for a key's FIRST probe after it is sighted (covers the
// restart case, where every persisted cooldown is sighted at once).
const FIRST_PROBE_STAGGER_MS = 45 * 1000;

const DEFAULT_MAX_PROBES_PER_PASS = 3;

/** Per-pass probe budget. Tunable for large key fleets; 0 or a bad value falls
 *  back to the default (mirrors HEALTH_CHECK_CONCURRENCY). */
function getMaxProbesPerPass(): number {
  const raw = process.env.COOLDOWN_PROBE_MAX_PER_PASS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_PROBES_PER_PASS;
}

interface KeyProbeState {
  failures: number;
  nextProbeAtMs: number;
}

// keyId -> probe pacing. In-memory only, like the escalation ladder: a restart
// forgetting the backoff is fine because first-sighting staggering re-spaces
// the probes anyway.
const keyState = new Map<number, KeyProbeState>();

export interface ProbePassOptions {
  now?: number;
  // Test seams: injectable probe + RNG so unit tests need no network or timers.
  probe?: (keyId: number) => Promise<KeyProbeOutcome>;
  jitter?: () => number; // [0, 1), defaults to Math.random
  maxProbes?: number;
}

export interface ProbePassResult {
  probedKeyIds: number[];
  clearedCooldowns: number;
}

/** True when this cooldown has served enough of its bench to be worth probing. */
function isRipe(cooldown: ProbeableCooldown, now: number): boolean {
  if (cooldown.expiresAtMs - now < MIN_REMAINING_MS) return false;
  // Rows persisted before the provenance migration have no start time; treat
  // them as old enough rather than never probing them.
  if (cooldown.setAtMs == null) return true;
  const duration = cooldown.expiresAtMs - cooldown.setAtMs;
  return now - cooldown.setAtMs >= duration * MIN_ELAPSED_FRACTION;
}

/**
 * One probe pass: find ripe heuristic cooldowns, probe up to maxProbes of their
 * keys (respecting per-key backoff), and clear every heuristic cooldown on a
 * key whose probe passed. Exported for tests; production runs it on the
 * scheduler via startCooldownProbe.
 */
export async function runCooldownProbePass(opts: ProbePassOptions = {}): Promise<ProbePassResult> {
  const now = opts.now ?? Date.now();
  const probe = opts.probe ?? probeKeyValidity;
  const jitter = opts.jitter ?? Math.random;
  const maxProbes = opts.maxProbes ?? getMaxProbesPerPass();

  const all = getProbeableCooldowns(now);

  // Drop pacing state for keys with no probeable cooldowns left (expired,
  // cleared, or re-benched as authoritative) so old backoff cannot delay a
  // future, unrelated bench.
  const keysWithCooldowns = new Set(all.map(c => c.keyId));
  for (const keyId of [...keyState.keys()]) {
    if (!keysWithCooldowns.has(keyId)) keyState.delete(keyId);
  }

  const ripeByKey = new Map<number, ProbeableCooldown[]>();
  for (const cooldown of all) {
    if (!isRipe(cooldown, now)) continue;
    const list = ripeByKey.get(cooldown.keyId) ?? [];
    list.push(cooldown);
    ripeByKey.set(cooldown.keyId, list);
  }

  const probedKeyIds: number[] = [];
  let clearedCooldowns = 0;

  for (const [keyId, cooldownsForKey] of ripeByKey) {
    if (probedKeyIds.length >= maxProbes) break;

    let state = keyState.get(keyId);
    if (!state) {
      // First sighting: schedule, don't probe. This is the restart stagger —
      // a boot with dozens of persisted cooldowns spreads its first probes
      // across the jitter window instead of validating everything at once.
      state = { failures: 0, nextProbeAtMs: now + Math.floor(jitter() * FIRST_PROBE_STAGGER_MS) };
      keyState.set(keyId, state);
      continue;
    }
    if (now < state.nextProbeAtMs) continue;

    probedKeyIds.push(keyId);
    const outcome = await probe(keyId);

    if (outcome === 'valid') {
      for (const cooldown of cooldownsForKey) {
        clearCooldownEarly(cooldown.platform, cooldown.modelId, cooldown.keyId);
        clearedCooldowns++;
      }
      keyState.delete(keyId);
      // Structured so the dashboard log viewer can filter recoveries by
      // provider; providerLog still writes the same line to stdout.
      providerLog(
        'info',
        `[CooldownProbe] key ${keyId} validated — cleared ${cooldownsForKey.length} cooldown(s) early ` +
        `(${cooldownsForKey.map(c => `${c.platform}/${c.modelId}`).join(', ')})`,
        { provider: cooldownsForKey[0]?.platform, event: 'cooldown_recovered' },
      );
    } else {
      // Failed or inconclusive: the bench stays EXACTLY as it was — a probe
      // must never extend a cooldown — and this key backs off before the next
      // attempt so probes cannot burn quota against a provider that is down.
      state.failures++;
      const backoff = Math.min(PROBE_BACKOFF_BASE_MS * 2 ** (state.failures - 1), PROBE_BACKOFF_MAX_MS);
      state.nextProbeAtMs = now + backoff;
    }
  }

  return { probedKeyIds, clearedCooldowns };
}

// Overlap guard, same shape as checkAllKeys: a slow provider validate must not
// let the next scheduled pass stack a second set of probes on top.
let passInFlight: Promise<ProbePassResult> | null = null;

function runGuardedPass(): Promise<ProbePassResult> {
  if (passInFlight) return passInFlight;
  passInFlight = runCooldownProbePass().finally(() => {
    passInFlight = null;
  });
  return passInFlight;
}

let cancelProbeJob: (() => void) | null = null;

export function startCooldownProbe(scheduler: Scheduler): void {
  if (cancelProbeJob) return;
  if (process.env.COOLDOWN_PROBE_DISABLED === '1') {
    console.log('[CooldownProbe] disabled via COOLDOWN_PROBE_DISABLED=1');
    return;
  }
  console.log(`[CooldownProbe] starting cooldown-probe recovery (scan every ${SCAN_INTERVAL_MS / 1000}s)`);
  cancelProbeJob = scheduler.every(
    SCAN_INTERVAL_MS,
    async () => {
      await runGuardedPass().catch(err => console.error('[CooldownProbe] pass failed:', err));
    },
    { name: 'cooldown-probe' },
  );
}

export function stopCooldownProbe(): void {
  if (cancelProbeJob) {
    cancelProbeJob();
    cancelProbeJob = null;
  }
}

/** Test seam: drop all per-key probe pacing state. */
export function resetCooldownProbeState(): void {
  keyState.clear();
}
