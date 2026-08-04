import type { Db } from '../db/types.js';
import { getSetting, setSetting } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';

// ── Anonymized reliability telemetry (opt-in) ───────────────────────────────
//
// Design B1 of #685: self-hosted instances have no cross-instance quality
// signal, so a brand-new model starts blind until local traffic accumulates.
// This background job lets an operator OPT IN to publishing a tiny, anonymized
// summary of what their gateway has observed — the aggregate that the
// community-reliability prior (services/router.ts, routing_community_prior) is
// meant to be seeded from.
//
// Privacy boundary (the reason this is opt-in and not on by default):
//   - only (platform, model_id) + decay-raw success/failure counts + speed
//     stats are sent. No keys, no request bodies, no client IPs, no base URLs;
//   - custom endpoints are included ONLY as model ids — never their base_url;
//   - the endpoint is a single configured URL; nothing else ever leaves the box.
//
// Failure handling: a failed upload logs once and waits for the next tick. It
// never crashes the scheduler and never retries in a tight loop.

/** Settings keys. */
export const TELEMETRY_OPT_IN_KEY = 'telemetry_opt_in';
export const TELEMETRY_ENDPOINT_KEY = 'telemetry_endpoint';

/** Default aggregation window — matches the bandit's 7-day stats window. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the uploader runs. Daily is enough for a slowly-evolving prior. */
export const TELEMETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Let the server settle before the first upload (catalog-sync convention). */
const BOOT_DELAY_MS = 30 * 1000;
/** Bounded outbound request: this is best-effort background work. */
const UPLOAD_TIMEOUT_MS = 15 * 1000;

/** What one model contributes to the shared prior. */
export interface TelemetryModelStat {
  platform: string;
  modelId: string;
  /** Raw (non-decayed) success count over the window. */
  successes: number;
  /** Raw (non-decayed) failure count over the window. */
  failures: number;
  /** Mean latency of successful requests, ms (null when no successes). */
  avgLatencyMs: number | null;
}

export interface TelemetryPayload {
  v: 1;
  sentAt: string;
  models: TelemetryModelStat[];
}

export function isTelemetryOptIn(): boolean {
  return getSetting(TELEMETRY_OPT_IN_KEY) === '1';
}

export function setTelemetryOptIn(enabled: boolean): void {
  setSetting(TELEMETRY_OPT_IN_KEY, enabled ? '1' : '0');
}

export function getTelemetryEndpoint(): string {
  return getSetting(TELEMETRY_ENDPOINT_KEY) ?? '';
}

export function setTelemetryEndpoint(url: string): void {
  setSetting(TELEMETRY_ENDPOINT_KEY, url.trim());
}

/**
 * Aggregate the last WINDOW_MS of requests into per-model stats. Only
 * (platform, model_id) identity leaves the box — custom base URLs are never
 * included. The rows are the same source the bandit scores from, so the
 * published prior matches what the router actually sees.
 */
export function collectTelemetryStats(db: Db): TelemetryModelStat[] {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const rows = db.prepare(`
    SELECT platform, model_id,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'success' THEN latency_ms ELSE 0 END) AS succ_lat
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform, model_id
    HAVING total > 0
  `).all(since) as Array<{
    platform: string; model_id: string; total: number; successes: number; succ_lat: number;
  }>;

  return rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    successes: Number(r.successes ?? 0),
    failures: Number(r.total - (r.successes ?? 0)),
    avgLatencyMs: (r.successes ?? 0) > 0
      ? Math.round(Number(r.succ_lat ?? 0) / Number(r.successes))
      : null,
  }))
    .filter(s => s.successes + s.failures > 0)
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.modelId.localeCompare(b.modelId));
}

/** POST the anonymized summary to the configured endpoint. Returns false on
 *  any failure so the caller can log once and wait for the next tick. */
export async function uploadTelemetry(db: Db, endpoint?: string): Promise<boolean> {
  if (!isTelemetryOptIn()) return false;
  const target = endpoint ?? getTelemetryEndpoint();
  if (!target) return false;

  const models = collectTelemetryStats(db);
  if (models.length === 0) return true; // nothing observed yet — not an error

  const payload: TelemetryPayload = { v: 1, sentAt: new Date().toISOString(), models };
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Test hook: forget boot timer state between tests. */
let cancelBootTimer: (() => void) | null = null;
export function cancelTelemetryUpload(): void {
  cancelBootTimer?.();
  cancelBootTimer = null;
}

export function startTelemetryUpload(scheduler: Scheduler, db: Db): void {
  if (!isTelemetryOptIn()) {
    console.log('[Telemetry] disabled (telemetry_opt_in not set) — nothing will be uploaded.');
    return;
  }
  const endpoint = getTelemetryEndpoint();
  console.log(`[Telemetry] opt-in enabled — anonymized stats upload to ${endpoint} every ${TELEMETRY_INTERVAL_MS / 1000}s`);

  const run = async (): Promise<void> => {
    const ok = await uploadTelemetry(db);
    if (!ok) console.warn('[Telemetry] upload failed — will retry next tick.');
  };

  cancelBootTimer = scheduler.after(BOOT_DELAY_MS, run);
  scheduler.every(TELEMETRY_INTERVAL_MS, run, { name: 'telemetry-upload' });
}
