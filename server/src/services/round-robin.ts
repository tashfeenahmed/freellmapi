/**
 * Round-robin state tracker for combo model rotation.
 *
 * Maintains per-combo rotation counters in memory. When a combo uses
 * round-robin strategy, each request advances the pointer (or sticks to
 * the current model up to sticky_limit requests).
 *
 * Pure functions on a Map — no DB, no Express, trivially testable.
 */

interface RoundRobinState {
  /** Index into the combo's models array that serves the next request. */
  currentIndex: number;
  /** How many consecutive requests have been served by the current model. */
  consecutiveCount: number;
}

const store = new Map<string, RoundRobinState>();

/**
 * Pick the next model index for a combo, advancing the round-robin state.
 *
 * @param comboName   — unique combo identifier
 * @param modelCount  — number of models in the combo (must be > 0)
 * @param stickyLimit — max consecutive requests on the same model before rotating
 * @returns the index into the combo's models array to use for this request
 */
export function nextRoundRobinModel(
  comboName: string,
  modelCount: number,
  stickyLimit: number,
): number {
  if (modelCount <= 0) return 0;

  let state = store.get(comboName);

  // First request for this combo
  if (!state) {
    state = { currentIndex: 0, consecutiveCount: 1 };
    store.set(comboName, state);
    return 0;
  }

  // Check if we should rotate
  if (state.consecutiveCount >= stickyLimit) {
    // Move to next model (wrap around)
    state.currentIndex = (state.currentIndex + 1) % modelCount;
    state.consecutiveCount = 1;
  } else {
    state.consecutiveCount++;
  }

  return state.currentIndex;
}

/**
 * Reset round-robin state for a combo (used when the combo's model list changes).
 */
export function resetRoundRobinState(comboName: string): void {
  store.delete(comboName);
}

/**
 * Get the number of combos currently tracked. For testing/monitoring.
 */
export function trackedComboCount(): number {
  return store.size;
}
