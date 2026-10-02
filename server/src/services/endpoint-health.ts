// endpoint-health — endpoint-level health state machine (#1254).
//
// The cooldown ladder benches (platform, model, key) tuples for 90s-to-minutes
// and re-admits them by TIMER expiry, not by evidence. For a relay that
// removed a model or a host with broken TLS that means: bench 90s → re-hit
// with a REAL user request → fail again → bench again, forever, at ~7s of
// wall-clock per user request (measured on a production install: 26 of 34
// requests for one model walked the same dead-relay ladder before reaching a
// live endpoint).
//
// This module adds a persistent memory at the (platform, endpoint_scope)
// granularity — the identity a custom relay is already known by (#651):
//
//   healthy     — no opinion (default; zero cost on the hot path)
//   suspect     — recent structural failures; the endpoint is deprioritized
//                 (skipped when a healthier candidate for the SAME model exists)
//   quarantined — structural failures persisted past the suspect threshold;
//                 the endpoint is skipped in chain construction entirely and
//                 recovers only through a background probe, never by timer
//
// What counts as STRUCTURAL (endpoint is broken, not merely busy):
//   model_not_found    — relay removed the model (404)
//   upstream_error     — 5xx / degraded / transport ("fetch failed", TLS)
//   provider_bad_request — relay-side 400s naming upstream unavailability
//   timeout            — the endpoint hangs
// What does NOT (periodic by nature, already handled by the cooldown ladder):
//   rate_limited / out_of_credits / daily_quota_exhausted / auth / forbidden /
//   context_too_large / empty_completion / format_ignored / invalid_tool_arguments
//
// Design mirrors cooldown-probe.ts: a scanner wakes on the shared scheduler,
// probes at most a handful of quarantined endpoints per pass with exponential
// backoff and first-sighting jitter (no thundering herd), and a failed probe
// only schedules the next probe further out — it never extends the
// quarantine's evidence requirements.
//
// Hot-path contract: isEndpointSuspect()/isEndpointQuarantined() are one
// Map lookup each; counters are bumped off the response path (same place the
// cooldown ladder already runs). Kill switch: ENDPOINT_HEALTH_DISABLED=1
// (same convention as COOLDOWN_PROBE_DISABLED).

import type { Scheduler } from '../lib/scheduler.js';
import { providerLog } from '../lib/server-logs.js';
import { modelRetirementSignal } from '../lib/error-classify.js';
import type { AttemptErrorClass } from '../lib/fallback-loop.js';

// Structural failures inside SUSPECT_WINDOW_MS escalate to suspect at N=2.
const SUSPECT_THRESHOLD = 2;
const SUSPECT_WINDOW_MS = 10 * 60 * 1000;
// Suspect endpoints with this many structural failures in the window quarantine.
const QUARANTINE_THRESHOLD = 4;
// A quarantined endpoint's counters age out after this long with no new
// failures — the state machine cannot be a life sentence if evidence stops.
const QUARANTINE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Suspect state self-expires: without fresh failures the endpoint is healthy
// again (probes only exist for quarantined endpoints).
const SUSPECT_TTL_MS = 15 * 60 * 1000;

const SCAN_INTERVAL_MS = 60 * 1000;
const PROBE_BACKOFF_BASE_MS = 2 * 60 * 1000;
const PROBE_BACKOFF_MAX_MS = 15 * 60 * 1000;
const FIRST_PROBE_STAGGER_MS = 45 * 1000;
const DEFAULT_MAX_PROBES_PER_PASS = 2;

export type EndpointHealthState = 'healthy' | 'suspect' | 'quarantined';

interface EndpointFailure {
  atMs: number;
  errorClass: AttemptErrorClass;
}

interface EndpointRecord {
  failures: EndpointFailure[];
  // Set on the first failure sighting; staggered probe scheduling covers the
  // restart case exactly like cooldown-probe.ts.
  firstSeenMs: number;
  quarantinedAtMs: number | null;
  nextProbeAtMs: number;
  probeFailures: number;
}

const endpoints = new Map<string, EndpointRecord>();
let cancelProbeJob: (() => void) | null = null;

export function endpointHealthKey(platform: string, endpointScope: string): string {
  return `${platform}::${endpointScope}`;
}

function disabled(): boolean {
  return process.env.ENDPOINT_HEALTH_DISABLED === '1';
}

function getRecord(key: string): EndpointRecord {
  let rec = endpoints.get(key);
  if (!rec) {
    rec = { failures: [], firstSeenMs: Date.now(), quarantinedAtMs: null, nextProbeAtMs: 0, probeFailures: 0 };
    endpoints.set(key, rec);
  }
  return rec;
}

// Structural = endpoint broken. Periodic failures (quota/rate/auth) and
// request-shape failures (context, format, tools) say nothing about the
// ENDPOINT and never feed this state machine.
const STRUCTURAL_CLASSES: ReadonlySet<AttemptErrorClass> = new Set([
  'model_not_found',
  'upstream_error',
  'provider_bad_request',
  'timeout',
] as AttemptErrorClass[]);

function pruneFailures(rec: EndpointRecord, now: number): void {
  rec.failures = rec.failures.filter(f => now - f.atMs < SUSPECT_WINDOW_MS);
}

/** Record one failed attempt against an endpoint. Called from the fallback
 *  loop's failure bookkeeping — off the response path, same as the ladder.
 *
 *  Escalation is confidence-weighted (#1254 PR 3): a definitive model-gone
 *  signal (410 Gone / end-of-life wording, the same classifier
 *  model-retirement.ts trusts for model disabling) counts as TWO structural
 *  failures — one request's worth of evidence is enough to prefer away from
 *  the endpoint, because the relay told us in so many words the model is not
 *  coming back. Plain 5xx/timeouts stay at the base thresholds: one flaky
 *  blip must never quarantine a healthy endpoint.
 *
 *  Periodic failures (quota/rate/auth) and request-shape failures were
 *  already filtered by STRUCTURAL_CLASSES above. */
export function noteEndpointFailure(
  platform: string,
  endpointScope: string,
  errorClass: AttemptErrorClass,
  now: number = Date.now(),
  err?: any,
): void {
  if (disabled()) return;
  if (!STRUCTURAL_CLASSES.has(errorClass)) return;
  const weight = errorClass === 'model_not_found' && modelRetirementSignal(err) === 'definitive' ? 2 : 1;
  const key = endpointHealthKey(platform, endpointScope);
  const rec = getRecord(key);
  for (let i = 0; i < weight; i++) {
    rec.failures.push({ atMs: now, errorClass });
  }
  pruneFailures(rec, now);
  if (rec.failures.length >= QUARANTINE_THRESHOLD) {
    if (rec.quarantinedAtMs == null) {
      rec.quarantinedAtMs = now;
      rec.nextProbeAtMs = now + FIRST_PROBE_STAGGER_MS;
      providerLog('warn', `endpoint quarantined (${errorClass}${weight > 1 ? ' definitive' : ''} w${weight}): ${key} — probe recovery in ~${Math.round(FIRST_PROBE_STAGGER_MS / 1000)}s`);
    }
  } else if (rec.failures.length >= SUSPECT_THRESHOLD) {
    providerLog('info', `endpoint suspect (${errorClass}${weight > 1 ? ' definitive' : ''} w${weight}): ${key}`);
  }
}

/** A served request is the strongest evidence an endpoint is alive — reset. */
export function noteEndpointSuccess(platform: string, endpointScope: string, _now: number = Date.now()): void {
  if (disabled()) return;
  const key = endpointHealthKey(platform, endpointScope);
  const rec = endpoints.get(key);
  if (!rec) return;
  if (rec.quarantinedAtMs != null) {
    providerLog('info', `endpoint recovered via live traffic: ${key}`);
  }
  endpoints.delete(key);
}

function effectiveState(key: string, rec: EndpointRecord, now: number): EndpointHealthState {
  if (rec.quarantinedAtMs != null) {
    if (now - rec.quarantinedAtMs > QUARANTINE_MAX_AGE_MS) {
      endpoints.delete(key);
      return 'healthy';
    }
    return 'quarantined';
  }
  pruneFailures(rec, now);
  if (rec.failures.length >= SUSPECT_THRESHOLD) return 'suspect';
  if (now - rec.firstSeenMs > SUSPECT_TTL_MS && rec.failures.length === 0) {
    endpoints.delete(key);
  }
  return 'healthy';
}

/** Hot-path gate: should this endpoint be deprioritized/skipped? */
export function isEndpointSuspect(platform: string, endpointScope: string): boolean {
  if (disabled()) return false;
  const rec = endpoints.get(endpointHealthKey(platform, endpointScope));
  if (!rec) return false;
  return effectiveState(endpointHealthKey(platform, endpointScope), rec, Date.now()) !== 'healthy';
}

export function isEndpointQuarantined(platform: string, endpointScope: string): boolean {
  if (disabled()) return false;
  const rec = endpoints.get(endpointHealthKey(platform, endpointScope));
  if (!rec) return false;
  return effectiveState(endpointHealthKey(platform, endpointScope), rec, Date.now()) === 'quarantined';
}

// ── Probe recovery (background only; never a user request) ───────────────────

function getMaxProbesPerPass(): number {
  const raw = process.env.ENDPOINT_PROBE_MAX_PER_PASS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_PROBES_PER_PASS;
}

export function getProbeableEndpoints(now: number = Date.now()): Array<{ platform: string; endpointScope: string; keyId: number | null }> {
  const out: Array<{ platform: string; endpointScope: string; keyId: number | null }> = [];
  for (const [key, rec] of endpoints) {
    if (rec.quarantinedAtMs == null) continue;
    if (now < rec.nextProbeAtMs) continue;
    const idx = key.indexOf('::');
    out.push({ platform: key.slice(0, idx), endpointScope: key.slice(idx + 2), keyId: probeKeyIdFor(platformScopeKeyOf(key)) });
  }
  return out;
}

function platformScopeKeyOf(key: string): { platform: string; endpointScope: string } {
  const idx = key.indexOf('::');
  return { platform: key.slice(0, idx), endpointScope: key.slice(idx + 2) };
}

// probeKeyIdFor is resolved lazily to avoid an import cycle with
// custom-endpoint.ts at module load; the indirection is set at start time.
let probeKeyResolver: ((scope: { platform: string; endpointScope: string }) => number | null) | null = null;

/** Called by startEndpointHealth to inject the key-lookup without a cycle. */
export function setProbeKeyResolver(fn: (scope: { platform: string; endpointScope: string }) => number | null): void {
  probeKeyResolver = fn;
}

function probeKeyIdFor(scope: { platform: string; endpointScope: string }): number | null {
  return probeKeyResolver ? probeKeyResolver(scope) : null;
}

/** One probe pass: validate one credential per quarantined endpoint. A valid
 *  probe clears the quarantine (all of it, like cooldown-probe); a failed one
 *  only backs off the NEXT probe. The probe is a question, never a verdict —
 *  it never feeds the key health checker's failure counter. */
export async function runEndpointProbePass(now: number = Date.now()): Promise<number> {
  if (disabled()) return 0;
  const candidates = getProbeableEndpoints(now).slice(0, getMaxProbesPerPass());
  for (const cand of candidates) {
    const key = endpointHealthKey(cand.platform, cand.endpointScope);
    const rec = endpoints.get(key);
    if (!rec) continue;
    rec.nextProbeAtMs = now + Math.min(PROBE_BACKOFF_BASE_MS * 2 ** rec.probeFailures, PROBE_BACKOFF_MAX_MS);
    if (cand.keyId == null) {
      // No credential to probe with (legacy unscoped row, or all keys disabled).
      // Keep quarantined; backoff already scheduled the next attempt.
      rec.probeFailures += 1;
      continue;
    }
    rec.probeFailures += 1;
    const { probeEndpointValidity } = await import('./health.js');
    const outcome = await probeEndpointValidity(cand.platform, cand.endpointScope, cand.keyId);
    if (outcome === 'valid') {
      endpoints.delete(key);
      providerLog('info', `endpoint probe recovered: ${key}`);
    }
  }
  return candidates.length;
}

export function startEndpointHealth(scheduler: Scheduler): void {
  if (disabled()) return;
  if (cancelProbeJob) return;
  cancelProbeJob = scheduler.every(SCAN_INTERVAL_MS, () => {
    void runEndpointProbePass();
  });
}

export function stopEndpointHealth(): void {
  if (cancelProbeJob) {
    cancelProbeJob();
    cancelProbeJob = null;
  }
}

/** Dashboard/health surface. */
export function getEndpointHealthStatus(now: number = Date.now()): Array<{ endpoint: string; state: EndpointHealthState; failures: number; quarantinedAt: string | null }> {
  const out: Array<{ endpoint: string; state: EndpointHealthState; failures: number; quarantinedAt: string | null }> = [];
  for (const [key, rec] of endpoints) {
    const state = effectiveState(key, rec, now);
    if (state === 'healthy') continue;
    out.push({
      endpoint: key,
      state,
      failures: rec.failures.length,
      quarantinedAt: rec.quarantinedAtMs != null ? new Date(rec.quarantinedAtMs).toISOString() : null,
    });
  }
  return out;
}

/** Tests only. */
export function resetEndpointHealthForTest(): void {
  endpoints.clear();
}
