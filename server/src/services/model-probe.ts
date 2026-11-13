// model-probe — proactive per-model probes with explicit labels (#1438 PR 1).
//
// Key-level health says a credential works; it says nothing about whether a
// specific MODEL behind that key actually answers. Free-tier aggregators
// routinely list models that 403 on every real chat (upstream quota drained),
// and the router only learns that after burning a real user turn (#1267 is
// passive: it demotes a model after real traffic has already hit it).
//
// This job sends a minimal real chat request ("Reply with OK") to routable
// model+key pairs that have not been observed recently, and writes an explicit
// status row: 'working' | 'unavailable'. PR 1 is OBSERVATION ONLY — nothing in
// routing, scoring or fallback reads the table yet; a follow-up consumes the
// labels (tool-call variant, chat_only classification, dashboard badges).
//
// What it will never do:
//   - probe a model that just served real traffic successfully (serving is
//     stronger evidence than any probe, and probes cost free-tier quota);
//   - feed the health checker, cooldowns or the failure counters — a probe is
//     a question, never a verdict (same principle as probeKeyValidity);
//   - use the fallback/healing machinery: the probe measures the model as-is,
//     not the pipeline, so a probe never retries and never repairs;
//   - thundering-herd a provider after a restart: first-sighting staggering
//     plus a small per-pass budget keep probe traffic bounded.
//
// Cadence: one pass every 30 minutes, at most MODEL_PROBE_MAX_PER_PASS probes
// per pass (default 3). OFF by default: probes spend the user's free-tier
// quota and nothing consumes the labels yet, so the scheduled job only runs
// with MODEL_PROBE_ENABLED=1. POST /api/health/probe-models always runs a pass.

import type { Scheduler } from '../lib/scheduler.js';
import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';
import { inferQuotaPoolKey } from './provider-quota.js';

// One pass every 30 minutes. Probes are quota-costing real requests; the point
// is freshness on the scale of "an operator glances at the dashboard", not
// second-level liveness (the cooldown/health machinery owns that).
export const MODEL_PROBE_INTERVAL_MS = 30 * 60 * 1000;

// Stale rows are re-probed after this long; fresher evidence is trusted and
// the model is skipped. Well above the pass cadence so a skipped model is not
// re-considered every pass.
export const MODEL_PROBE_STALE_MS = 6 * 60 * 60 * 1000;

// A model+key that served a real request within this window does not need a
// probe: real success is stronger evidence, and the probe would only spend
// free-tier quota to re-learn it. Mirrors the RECENT_CHECK_SKIP_MS idea from
// the health pass.
export const RECENT_SERVE_SKIP_MS = 60 * 60 * 1000;

const DEFAULT_MAX_PROBES_PER_PASS = 3;

// Ceiling for one probe request, mirroring health's transport posture. A probe
// that takes longer than this is treated as an error (inconclusive), not as
// evidence the model is unavailable.
const PROBE_TIMEOUT_MS = 60 * 1000;

// max_tokens floor: some relays reject max_tokens <= 2 (#903). The probe never
// relies on tiny ceilings, so a generous floor avoids that whole failure class.
const PROBE_MAX_TOKENS = 64;

/** Per-pass probe budget. Tunable; 0 or a bad value falls back to the default
 *  (mirrors HEALTH_CHECK_CONCURRENCY / COOLDOWN_PROBE_MAX_PER_PASS). */
function getMaxProbesPerPass(): number {
  const raw = process.env.MODEL_PROBE_MAX_PER_PASS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_PROBES_PER_PASS;
}

export type ModelProbeStatus = 'working' | 'unavailable';

export interface ProbeCandidate {
  keyId: number;
  platform: string;
  modelId: string;
  modelDbId: number;
  endpointScope: string;
}

export interface ProbeOutcome {
  status: ModelProbeStatus | 'error';
  latencyMs?: number;
  error?: string;
}

export interface ProbePassResult {
  probed: ProbeCandidate[];
  outcomes: Array<ProbeCandidate & { outcome: ProbeOutcome }>;
}

// ── Candidate selection ──────────────────────────────────────────────────────
// Routable pairs only: enabled model on an enabled, currently-healthy-or-
// unknown key, with endpoint scope carried through (custom-endpoint identity,
// migration 20260729_000001). Ordered to rotate fairly: stalest evidence
// first, models never probed (NULL last_probed_at) before stale ones.

interface ProbeCandidateRow extends ProbeCandidate {
  lastProbedAt: string | null;
}

export function selectProbeCandidates(db: Db, limit: number, now = Date.now()): ProbeCandidateRow[] {
  const rows = db.prepare(`
    SELECT m.id AS modelDbId, m.platform, m.model_id AS modelId, m.endpoint_scope AS endpointScope,
           k.id AS keyId, COALESCE(p.last_probed_at, '') AS lastProbedAt
      FROM models m
      JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1 AND k.status IN ('healthy', 'unknown')
     LEFT JOIN model_probe_status p
            ON p.platform = m.platform AND p.model_id = m.model_id
           AND p.endpoint_scope = m.endpoint_scope AND p.key_id = k.id
     WHERE m.enabled = 1
     ORDER BY (p.last_probed_at IS NULL) DESC, p.last_probed_at ASC, m.id ASC, k.id ASC
     LIMIT ?
  `).all(limit * 8) as Array<{
    modelDbId: number; platform: string; modelId: string; endpointScope: string;
    keyId: number; lastProbedAt: string;
  }>;

  const out: ProbeCandidateRow[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (row.lastProbedAt) {
      const seen = Date.parse(row.lastProbedAt.includes('T') ? row.lastProbedAt : row.lastProbedAt.replace(' ', 'T') + 'Z');
      if (Number.isFinite(seen) && now - seen < MODEL_PROBE_STALE_MS) continue;
    }
    out.push(row);
  }
  return out;
}

// ── The probe itself ─────────────────────────────────────────────────────────

export interface ModelProbeRequestDeps {
  // Test seam: the chat call the probe makes. Production uses the provider's
  // own chatCompletion through the key's proxy.
  chat?: (candidate: ProbeCandidate) => Promise<unknown>;
}

async function probeChat(candidate: ProbeCandidate): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1').get(candidate.keyId) as any;
  if (!row) throw new Error('key not found or disabled');
  const provider = resolveProvider(candidate.platform as any, row.base_url);
  if (!provider) throw new Error(`no provider adapter for ${candidate.platform}`);

  const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  // Same reasoning as checkKeyHealth (#590): probe through the key's own proxy,
  // or a key only reachable via its proxy would fail the probe while real
  // traffic through the proxy works fine.
  await withKeyProxy(decryptProxyUrl(row), () => provider.chatCompletion(apiKey, [
    { role: 'user', content: 'Reply with OK' },
  ], candidate.modelId, {
    max_tokens: PROBE_MAX_TOKENS,
    timeoutMs: PROBE_TIMEOUT_MS,
  } as any, {
    platform: candidate.platform as any,
    keyId: candidate.keyId,
    quotaPoolKey: inferQuotaPoolKey(candidate.platform as any, null),
    endpoint: 'chat',
    origin: 'probe',
  } as any));
}

/**
 * Run the probe against one candidate: does this model answer at all?
 * A transport error is 'error' (inconclusive — the network, not the model,
 * failed); any provider rejection (quota, 403/404 on the model) is
 * 'unavailable'. A success is 'working'.
 *
 * Capability classification (tool_capable / chat_only) is a follow-up PR; this
 * pass establishes liveness only.
 *
 * Testable: `chat` replaces the wire call.
 */
export async function probeModel(candidate: ProbeCandidate, deps: ModelProbeRequestDeps = {}): Promise<ProbeOutcome> {
  const started = Date.now();
  const chat = deps.chat ?? probeChat;
  try {
    await chat(candidate);
    return { status: 'working', latencyMs: Date.now() - started };
  } catch (err: any) {
    const message = sanitizeProviderErrorMessage(err?.message ?? err);
    const transport = /(?:fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|certificate|TLS|timeout)/i.test(message);
    if (transport || err?.name === 'AbortError') return { status: 'error', error: message };
    return { status: 'unavailable', error: message };
  }
}

// ── Recording ────────────────────────────────────────────────────────────────

export function recordProbeResult(db: Db, candidate: ProbeCandidate, outcome: ProbeOutcome, probedAt = new Date()): void {
  if (outcome.status === 'error') {
    // Inconclusive: do not overwrite the last real verdict, but keep the
    // diagnostic and refresh the timestamp so pacing/backoff can see it.
    db.prepare(`
      UPDATE model_probe_status SET last_error = ?, last_probed_at = datetime('now')
       WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND key_id = ?
    `).run(outcome.error ?? 'probe error', candidate.platform, candidate.modelId, candidate.endpointScope, candidate.keyId);
    return;
  }
  db.prepare(`
    INSERT INTO model_probe_status (platform, model_id, endpoint_scope, key_id, status, last_probed_at, last_error, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(platform, model_id, endpoint_scope, key_id) DO UPDATE SET
      status = excluded.status,
      last_probed_at = excluded.last_probed_at,
      last_error = NULL,
      latency_ms = excluded.latency_ms
  `).run(
    candidate.platform, candidate.modelId, candidate.endpointScope, candidate.keyId,
    outcome.status, probedAt.toISOString(), outcome.latencyMs ?? null,
  );
}

// ── The pass ─────────────────────────────────────────────────────────────────

// Failed-probe backoff per candidate: 30m, 1h, 2h, capped at 6h. A model that
// stays unavailable converges to one probe per staleness window — re-probing
// it harder only burns the free quota the probe is meant to conserve.
const PROBE_BACKOFF_BASE_MS = 30 * 60 * 1000;
const PROBE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

// Stagger window for a candidate's FIRST probe after boot, so a restart with a
// large catalog does not fire every probe at once (mirrors cooldown-probe).
const FIRST_PROBE_STAGGER_MS = 60 * 1000;

interface CandidateProbeState {
  failures: number;
  nextProbeAtMs: number;
}

// keyId -> pacing, in-memory only (same as cooldown-probe: restart forgetting
// backoff is fine because first-sighting staggering re-spaces probes anyway).
const probeState = new Map<string, CandidateProbeState>();

function stateKey(candidate: ProbeCandidate): string {
  return `${candidate.platform}:${candidate.modelId}:${candidate.endpointScope}:${candidate.keyId}`;
}

export interface ProbePassOptions extends ModelProbeRequestDeps {
  now?: number;
  jitter?: () => number; // [0, 1), defaults to Math.random
  maxProbes?: number;
  select?: (limit: number, now: number) => ProbeCandidate[];
}

/** One probe pass: probe up to maxProbes stale candidates, record the outcomes.
 *  Exported for tests; production runs it on the scheduler via startModelProbe. */
export async function runModelProbePass(opts: ProbePassOptions = {}): Promise<ProbePassResult> {
  const now = opts.now ?? Date.now();
  const jitter = opts.jitter ?? Math.random;
  const maxProbes = opts.maxProbes ?? getMaxProbesPerPass();
  const select = opts.select ?? ((limit: number, at: number) => selectProbeCandidates(getDb(), limit, at));

  const candidates = select(maxProbes, now);
  const probed: ProbeCandidate[] = [];
  const outcomes: ProbePassResult['outcomes'] = [];

  for (const candidate of candidates) {
    if (probed.length >= maxProbes) break;
    const key = stateKey(candidate);
    const state = probeState.get(key);
    if (!state) {
      // First sighting after boot: schedule, don't probe (restart stagger).
      probeState.set(key, { failures: 0, nextProbeAtMs: now + Math.floor(jitter() * FIRST_PROBE_STAGGER_MS) });
      continue;
    }
    if (now < state.nextProbeAtMs) continue;

    probed.push(candidate);
    const outcome = await probeModel(candidate, opts);
    outcomes.push({ ...candidate, outcome });

    if (outcome.status === 'unavailable') {
      state.failures++;
      const backoff = Math.min(PROBE_BACKOFF_BASE_MS * 2 ** (state.failures - 1), PROBE_BACKOFF_MAX_MS);
      state.nextProbeAtMs = now + backoff;
      providerLog(
        'warn',
        `[ModelProbe] ${candidate.platform}/${candidate.modelId} (key ${candidate.keyId}) unavailable: ${outcome.error ?? 'unknown error'}`,
        { provider: candidate.platform, event: 'model_probe_unavailable' },
      );
    } else {
      // A model that answered is healthy, so its pacing resets: re-probing a
      // working model harder would only burn the free quota the probe exists
      // to conserve.
      probeState.delete(key);
      providerLog(
        'info',
        `[ModelProbe] ${candidate.platform}/${candidate.modelId} (key ${candidate.keyId}) → ${outcome.status}` +
        (outcome.latencyMs != null ? ` in ${outcome.latencyMs}ms` : ''),
        { provider: candidate.platform, event: 'model_probe_ok' },
      );
    }
    recordProbeResult(getDb(), candidate, outcome);
  }

  return { probed, outcomes };
}

// Overlap guard, same shape as checkAllKeys / runCooldownProbePass.
let passInFlight: Promise<ProbePassResult> | null = null;

function runGuardedPass(): Promise<ProbePassResult> {
  if (passInFlight) return passInFlight;
  passInFlight = runModelProbePass().finally(() => {
    passInFlight = null;
  });
  return passInFlight;
}

let cancelProbeJob: (() => void) | null = null;

export function startModelProbe(scheduler: Scheduler): void {
  if (cancelProbeJob) return;
  if (process.env.MODEL_PROBE_ENABLED !== '1') return;
  console.log(`[ModelProbe] starting proactive model probes (every ${MODEL_PROBE_INTERVAL_MS / 60_000}m, max ${getMaxProbesPerPass()}/pass)`);
  cancelProbeJob = scheduler.every(
    MODEL_PROBE_INTERVAL_MS,
    async () => {
      await runGuardedPass().catch(err => console.error('[ModelProbe] pass failed:', err));
    },
    { name: 'model-probe' },
  );
}

export function stopModelProbe(): void {
  if (cancelProbeJob) {
    cancelProbeJob();
    cancelProbeJob = null;
  }
}

/** Test seam: drop all probe pacing state. */
export function resetModelProbeState(): void {
  probeState.clear();
}
