// Auto-retirement of models the upstream provider has permanently removed.
//
// Issue #634: NVIDIA answered every request for `minimaxai/minimax-m2.7` with
// "410 … has reached its end of life … and is no longer available". The failure
// classifies as a model-level skip, which rules the model out for ONE request —
// so the next request tried it again, and the next, forever, each one paying a
// round trip and a fallback slot for a model that is never coming back.
//
// The fix persists the verdict: a definitive end-of-life response disables the
// model right away, and a merely-probable one waits for corroboration from a
// second distinct request first, so a single flaky 404 from a load balancer can
// never kill a healthy model. The disable is reversible in both directions —
// the user can switch the model back on, and a catalog refresh that still lists
// it lifts the retirement (services/catalog-sync.ts).

import { getDb } from '../db/index.js';
import { modelRetirementSignal } from '../lib/error-classify.js';
import { summarizeAttemptError } from '../lib/error-redaction.js';
import { isCatalogManagedModel, retireCatalogModelUpstream } from './model-state.js';
import { modelStatsKey } from '../lib/endpoint-scope.js';
import { providerLog } from '../lib/server-logs.js';

/** How many DISTINCT requests must report a 'probable' signal before acting. */
export const RETIREMENT_CONFIRMATIONS_REQUIRED = 2;

/**
 * Corroboration has to be recent. Two "no longer available" 404s a week apart
 * are two outages; two within the hour are a retirement.
 */
export const RETIREMENT_OBSERVATION_WINDOW_MS = 60 * 60 * 1000;

interface Observation {
  count: number;
  firstSeenAt: number;
  // Identity of the request that last counted, so the same request failing over
  // across sibling keys cannot corroborate itself.
  lastRequest: unknown;
}

const observations = new Map<string, Observation>();

/** Test seam: the counters are process-local and deliberately not persisted. */
export function resetModelRetirementObservations(): void {
  observations.clear();
}

export interface RetirementRoute {
  modelDbId: number;
  platform: string;
  modelId: string;
  /**
   * The endpoint this route belongs to, for custom relays (#651). Two relays
   * can serve the same model id; a 410 from one says nothing about the other,
   * so their corroboration counters must not share a bucket. Absent/'' for
   * catalog platforms, which keeps their key exactly what it always was.
   */
  endpointScope?: string;
}

/**
 * Record one upstream failure against the retirement heuristic and, when the
 * evidence is strong enough, auto-disable the model. Returns true iff this call
 * retired it. Never throws: it runs on the proxy's failure path, where a DB
 * hiccup must not turn a failover into a crash.
 */
export function noteModelRetirementSignal(
  route: RetirementRoute,
  err: unknown,
  requestToken?: unknown,
): boolean {
  const confidence = modelRetirementSignal(err);
  if (!confidence) return false;

  const key = modelStatsKey(route.platform, route.modelId, route.endpointScope);
  if (confidence === 'probable' && !confirmObservation(key, requestToken)) return false;

  const reason = summarizeAttemptError((err as { message?: unknown })?.message);
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT id, platform, model_id, key_id, source FROM models WHERE id = ?')
      .get(route.modelDbId) as
      | { id: number; platform: string; model_id: string; key_id: number | null; source: string }
      | undefined;
    // Only catalog-managed rows: a model the user added by hand is their state,
    // not the catalog's, and the tombstone table has no meaning for it.
    if (!row || !isCatalogManagedModel(row)) return false;
    if (!retireCatalogModelUpstream(db, row.id, row.platform, row.model_id, reason)) return false;
    observations.delete(key);
    // Retiring a model changes routing permanently, so it is a warn (which the
    // dashboard viewer persists across restarts) carrying the platform/model it
    // acted on. Still printed to stdout by providerLog.
    providerLog(
      'warn',
      `[ModelRetirement] ${row.platform}/${row.model_id} disabled — upstream reports it retired: ${reason}`,
      { provider: row.platform, model: row.model_id, event: 'model_retired' },
    );
    return true;
  } catch (dbErr: any) {
    console.warn(`[ModelRetirement] could not record retirement for ${key}: ${dbErr?.message ?? dbErr}`);
    return false;
  }
}

/** True once this model has been reported gone by enough distinct requests. */
function confirmObservation(key: string, requestToken: unknown): boolean {
  const now = Date.now();
  const existing = observations.get(key);
  if (!existing || now - existing.firstSeenAt > RETIREMENT_OBSERVATION_WINDOW_MS) {
    observations.set(key, { count: 1, firstSeenAt: now, lastRequest: requestToken });
    return RETIREMENT_CONFIRMATIONS_REQUIRED <= 1;
  }
  // Same request failing over across this model's sibling keys: one request's
  // worth of evidence, however many keys it burned.
  if (requestToken !== undefined && existing.lastRequest === requestToken) return false;
  existing.count++;
  existing.lastRequest = requestToken;
  return existing.count >= RETIREMENT_CONFIRMATIONS_REQUIRED;
}
