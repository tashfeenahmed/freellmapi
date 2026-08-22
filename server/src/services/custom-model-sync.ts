import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import { discoverEndpointModels } from './model-discovery.js';
import { registerCustomModels, type CustomModelEntry } from './custom-model-register.js';
import { isCustomModelTombstoned } from './custom-model-tombstone.js';
import { listCustomEndpoints } from './custom-endpoint.js';
import { endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';

// ── Scheduled custom-model sync (#674/#663/#656) ─────────────────────────────
//
// Operators add a custom OpenAI-compatible provider and fetch its model list
// once, but providers change their model availability almost daily. This walks
// every configured custom endpoint on a schedule and registers whatever NEW
// models it now serves, reusing the exact same registration path as the manual
// POST /custom (see custom-model-register.ts) so the two can never drift.
//
// Deliberate bounds:
//  - ADD ONLY. Models that disappear upstream are left alone — an automated
//    pass must never delete a row the operator may have tuned by hand.
//  - One failing endpoint is logged and skipped; the others still sync, so a
//    dead relay cannot hold the whole schedule hostage.
//  - No catalog paywall interplay: these models come from the operator's own
//    endpoint with the operator's own key, not from the published catalog.

/** Default: once a day (#674 asks for daily; #663's 5-minute ask targets the
 *  bundled free catalog, which this pass deliberately never touches). */
const DEFAULT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Interval in ms from `CUSTOM_MODEL_SYNC_INTERVAL_MS`; 0 disables the pass,
 *  anything unset or malformed falls back to the daily default. */
export function customModelSyncIntervalMs(): number {
  const raw = process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SYNC_INTERVAL_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SYNC_INTERVAL_MS;
}

/** Comma-separated glob patterns of model ids that are known-free (#746).
 *  When set, the sync registers ONLY models matching a pattern — anything else
 *  (presumably paid) is skipped, honoring the repo's free-only policy. When
 *  unset, the sync keeps its legacy behavior of registering everything, so
 *  existing operators are unaffected. */
export function customModelSyncFreePatterns(): string[] {
  const raw = process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
}

/** Glob match where `*` matches any run of chars (incl. empty). */
function patternMatches(pattern: string, id: string): boolean {
  const escaped = pattern.split('*').map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(id);
}

export interface CustomModelSyncResult {
  endpoints: number;
  /** Models registered for the first time. */
  added: number;
  /** Models already on this endpoint that were skipped. */
  skipped: number;
  /** Models skipped because they matched no free pattern (#746). */
  paidSkipped: number;
  /** Models skipped because the operator deleted them and they must stay deleted (#926). */
  tombstoned: number;
  failures: Array<{ baseUrl: string; error: string }>;
}

/** Sync every configured custom endpoint once. Exported so tests (and an admin
 *  that wants a manual pass) can run it directly without waiting for the timer. */
export async function runCustomModelSync(db: Db): Promise<CustomModelSyncResult> {
  const endpoints = listCustomEndpoints(db);
  const result: CustomModelSyncResult = { endpoints: endpoints.length, added: 0, skipped: 0, paidSkipped: 0, tombstoned: 0, failures: [] };

  for (const endpoint of endpoints) {
    try {
      // A submitted key wins on the manual route; a scheduled pass can only use
      // what the endpoint already has on record. Keyless local servers keep the
      // 'no-key' sentinel, which the bearer header carries harmlessly.
      const discovered = await discoverEndpointModels(endpoint.baseUrl, endpoint.apiKey ?? 'no-key');

      const scope = endpointScopeForBaseUrl(endpoint.baseUrl);
      const registeredIds = new Set(
        (db.prepare("SELECT model_id FROM models WHERE platform = 'custom' AND endpoint_scope = ?").all(scope) as { model_id: string }[])
          .map(row => row.model_id),
      );

      const freePatterns = customModelSyncFreePatterns();
      const fresh: CustomModelEntry[] = [];
      for (const model of discovered) {
        if (registeredIds.has(model.id)) {
          result.skipped += 1;
          continue;
        }
        // #926: the operator deleted this model (or the key that owned it) and
        // expects it to stay gone. The sync's "add only" contract must not turn
        // a deliberate deletion into the next pass's "new model".
        if (isCustomModelTombstoned(db, scope, model.id)) {
          result.tombstoned += 1;
          continue;
        }
        // Free-only policy (#746): when FREE_PATTERNS is configured, a model
        // that matches none of the known-free patterns is presumably paid and
        // is skipped rather than silently registered.
        if (freePatterns.length > 0 && !freePatterns.some(p => patternMatches(p, model.id))) {
          result.paidSkipped += 1;
          continue;
        }
        // Bare id only, like the dashboard's bulk "Fetch models" submit: no name
        // or capability claims invented here, they resolve in SQL on insert.
        fresh.push({ modelId: model.id, displayName: null });
      }

      if (fresh.length > 0) {
        const registered = registerCustomModels(db, endpoint.baseUrl, undefined, undefined, endpoint.keyId, fresh);
        result.added += registered.registered.filter(m => m.created).length;
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      result.failures.push({ baseUrl: endpoint.baseUrl, error: message });
      console.error(`[custom-model-sync] ${endpoint.baseUrl}: ${message}`);
    }
  }

  return result;
}

/** Register the daily pass on the server's scheduler. Returns null when the
 *  interval is configured to 0 (disabled). */
export function startCustomModelSync(db: Db, scheduler: Scheduler): (() => void) | null {
  const intervalMs = customModelSyncIntervalMs();
  if (intervalMs <= 0) return null;
  return scheduler.every(intervalMs, () => { void runCustomModelSync(db); }, { name: 'custom-model-sync' });
}
