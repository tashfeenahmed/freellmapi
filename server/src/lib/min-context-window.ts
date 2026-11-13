import { getSetting } from '../db/index.js';

// Operator-facing context-window floor for the ROUTING POOL (issue #1442):
// a one-switch gate that excludes small-window models entirely, because the
// smallest free tiers (32k and below) fail real agent workloads before any
// rate limit does. Upward-compatible by construction — the floor is a minimum,
// so 128k keeps 512k and 1M models — and distinct from the per-request
// fitsContextWindow check, which only compares THIS request's estimated size.
//
// Stored as a plain settings string ('off' | '32k' | '128k' | '512k' | '1m'),
// parsed on every call: cheap (better-sqlite3 sync read), picks up dashboard
// changes without a restart, and a garbage value disables the gate rather than
// emptying the pool.

export const MIN_CONTEXT_WINDOW_SETTING = 'min_context_window';

// The named presets. '1m' is 1,048,576 (the binary MiB-scale window the
// largest catalog rows actually advertise), not a round 1,000,000 — matching
// the catalog keeps the gate consistent with what /v1/models publishes.
export const MIN_CONTEXT_WINDOW_PRESETS: Record<string, number> = {
  '32k': 32_768,
  '128k': 131_072,
  '512k': 524_288,
  '1m': 1_048_576,
};

/** The configured pool floor in tokens, or null when disabled ('off'/unset).
 *  A null context_window on a model means "unknown" and is NEVER filtered —
 *  the same convention fitsContextWindow uses, so models the catalog has no
 *  window for can't be silently mass-excluded by a typo'd floor. */
export function minContextWindowFloor(): number | null {
  let raw: string | undefined;
  try {
    raw = getSetting(MIN_CONTEXT_WINDOW_SETTING);
  } catch {
    return null; // DB not ready — never throw on the proxy hot path
  }
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (!value || value === 'off' || value === '0') return null;
  const preset = MIN_CONTEXT_WINDOW_PRESETS[value];
  if (preset !== undefined) return preset;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** True when a model with this advertised window may serve at all under the
 *  configured floor. Unknown windows (null/undefined) always pass. */
export function passesContextWindowFloor(contextWindow: number | null | undefined): boolean {
  const floor = minContextWindowFloor();
  if (floor == null) return true;
  if (contextWindow == null) return true;
  return contextWindow >= floor;
}
