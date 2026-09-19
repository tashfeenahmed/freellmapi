// ── Clear model-failure bookkeeping on server shutdown / health pass reset.
// The in-memory window (modelFailureTimestamps) and the per-key penalty map
// both survive across requests but NOT across a restart. This clears both so
// a restart doesn't artificially retain stale failure state for models whose
// upstream has since recovered.

import { modelFailureTimestamps, clearModelFailure, emptyCompletionStreaks } from './fallback-loop.js';
import { resetAllModelHealth } from '../services/model-health.js';

/** Clear every in-flight model-failure streak and the persisted health snapshot
 *  so a restart does not carry forward a stale "failing" verdict for a model
 *  whose upstream has recovered. Returns the number of model rows reset. */
export function clearAllModelFailureWindows(): number {
  modelFailureTimestamps.clear();
  emptyCompletionStreaks.clear();
  try {
    return resetAllModelHealth();
  } catch {
    return 0; // DB not ready — never throw on a best-effort cleanup path
  }
}
