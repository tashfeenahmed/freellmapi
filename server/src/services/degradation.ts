import { getDb } from '../db/index.js';
import { isUsableStatus } from './key-state.js';

/**
 * Global degraded-mode state machine (#904).
 *
 * When a large share of enabled providers fails at once, per-request probing
 * and bandit exploration just burn retry budget on dead routes. This module
 * tracks the healthy-provider ratio (driven by the scheduled health pass) and
 * flips the gateway into a degraded state once the ratio stays below a
 * threshold for a sustained period. While degraded, the router skips
 * exploration and sticks to the scored order of remaining healthy providers;
 * the health endpoint reports the state so operators can see it.
 *
 * Recovery is the mirror image: the ratio must stay at or above the threshold
 * for a sustained period before the gateway exits degraded mode, so a single
 * flickering pass doesn't flap the state.
 */

export type DegradationState = 'normal' | 'degraded';

export interface HealthSnapshot {
  /** Enabled providers that still have at least one usable key. */
  healthyProviders: number;
  /** Enabled providers with at least one key, usable or not. */
  totalProviders: number;
  /** healthyProviders / totalProviders, 1 when there are no providers. */
  ratio: number;
}

export interface DegradationStatus extends HealthSnapshot {
  state: DegradationState;
  /** ms since epoch when degraded mode was entered; null while normal. */
  degradedAt: number | null;
}

// Healthy keys are the ones the router can actually use. 'unknown' counts as
// healthy: an unprobed key is treated as usable until a probe says otherwise
// (the router does the same for skip/fallback decisions). The rule lives in
// key-state.ts.

function positiveEnv(raw: string | undefined, fallback: number): number {
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

// Fraction of providers that must remain healthy to stay out of degraded mode.
const DEGRADED_HEALTHY_RATIO = positiveEnv(process.env.DEGRADED_HEALTHY_RATIO, 0.5);
// Only meaningful when there are at least this many enabled providers — a
// single-provider deployment shouldn't flap degraded mode every outage.
const DEGRADED_MIN_PROVIDERS = positiveEnv(process.env.DEGRADED_MIN_PROVIDERS, 3);
// How long the ratio must stay below the threshold before entering degraded
// mode, so a transient bad pass doesn't flip the gateway.
const DEGRADED_ENTRY_GRACE_MS = positiveEnv(process.env.DEGRADED_ENTRY_GRACE_MS, 60_000);
// How long the ratio must stay at/above the threshold before exiting degraded
// mode. Longer than the entry grace: exiting prematurely re-enters quickly.
const DEGRADED_EXIT_GRACE_MS = positiveEnv(process.env.DEGRADED_EXIT_GRACE_MS, 120_000);

interface State {
  state: DegradationState;
  degradedAt: number | null;
  /** ms since epoch the ratio first dropped below the threshold (streak start). */
  belowSince: number | null;
  /** ms since epoch the ratio first recovered to the threshold (streak start). */
  recoveredSince: number | null;
}

const state: State = {
  state: 'normal',
  degradedAt: null,
  belowSince: null,
  recoveredSince: null,
};

let lastSnapshot: HealthSnapshot | null = null;

/** Compute the current healthy-provider ratio from the key table. Exported for
 *  tests to inject a fake DB; callers normally use updateDegradationState. */
export function computeHealthSnapshot(): HealthSnapshot {
  const db = getDb();
  const rows = db.prepare(`
    SELECT platform, status
    FROM api_keys
    WHERE enabled = 1
  `).all() as { platform: string; status: string }[];

  const usable = new Set<string>();
  const present = new Set<string>();
  for (const row of rows) {
    present.add(row.platform);
    if (isUsableStatus(row.status)) usable.add(row.platform);
  }

  const totalProviders = present.size;
  const healthyProviders = usable.size;
  const ratio = totalProviders === 0 ? 1 : healthyProviders / totalProviders;
  const snapshot: HealthSnapshot = { healthyProviders, totalProviders, ratio };
  lastSnapshot = snapshot;
  return snapshot;
}

/** Re-evaluate the degraded state from the current key table. Call this after
 *  every health pass; also callable on demand (dashboard, router entry). */
export function updateDegradationState(now = Date.now()): DegradationStatus {
  const snapshot = computeHealthSnapshot();

  // Degradation is only meaningful with enough providers to judge.
  if (snapshot.totalProviders < DEGRADED_MIN_PROVIDERS) {
    state.state = 'normal';
    state.degradedAt = null;
    state.belowSince = null;
    state.recoveredSince = null;
    return getDegradationStatus();
  }

  const belowThreshold = snapshot.ratio < DEGRADED_HEALTHY_RATIO;

  if (belowThreshold) {
    state.recoveredSince = null;
    if (state.state === 'normal') {
      state.belowSince ??= now;
      if (now - state.belowSince >= DEGRADED_ENTRY_GRACE_MS) {
        state.state = 'degraded';
        state.degradedAt = now;
        console.warn(
          `[Degradation] Entering degraded mode: ${snapshot.healthyProviders}/${snapshot.totalProviders} providers healthy ` +
          `(${(snapshot.ratio * 100).toFixed(0)}% < ${(DEGRADED_HEALTHY_RATIO * 100).toFixed(0)}%)`,
        );
      }
    }
  } else {
    state.belowSince = null;
    if (state.state === 'degraded') {
      state.recoveredSince ??= now;
      if (now - state.recoveredSince >= DEGRADED_EXIT_GRACE_MS) {
        state.state = 'normal';
        state.degradedAt = null;
        console.log(
          `[Degradation] Exiting degraded mode: ${snapshot.healthyProviders}/${snapshot.totalProviders} providers healthy ` +
          `(${(snapshot.ratio * 100).toFixed(0)}% >= ${(DEGRADED_HEALTHY_RATIO * 100).toFixed(0)}%)`,
        );
      }
    } else {
      state.recoveredSince = null;
    }
  }

  return getDegradationStatus();
}

export function isDegraded(): boolean {
  return state.state === 'degraded';
}

export function getDegradationStatus(): DegradationStatus {
  const snapshot = lastSnapshot ?? computeHealthSnapshot();
  return {
    ...snapshot,
    state: state.state,
    degradedAt: state.degradedAt,
  };
}

/** Reset the machine (tests, and the post-start re-probe path). */
export function resetDegradationState(): void {
  state.state = 'normal';
  state.degradedAt = null;
  state.belowSince = null;
  state.recoveredSince = null;
  lastSnapshot = null;
}
