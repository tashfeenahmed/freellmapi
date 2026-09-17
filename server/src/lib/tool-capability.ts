// Observed tool-calling rejections (#1230).
//
// `models.supports_tools` is a declaration, and for custom endpoints it defaults
// to 1 (migration 20260706_000002): a relay model that actually rejects every
// request carrying `tools` with a 400 stays a first-class candidate for tool
// requests, because the only memory of the rejection is the 90s transient
// cooldown. Auto mode then walks the same dead chain on every tool request
// until the operator disables the models by hand.
//
// This module remembers those rejections in memory and lets the router DEFER
// such a model for tool-carrying requests only. It is a soft preference, never
// a filter: a deferred model is still tried once everything else is exhausted,
// plain chat requests are untouched, and nothing is written to the DB (the
// `supports_tools` toggle stays the operator's). A client that sends a broken
// tool schema gets a 400 from every model alike, which defers them all equally
// and so changes nothing about their order.
//
// Keyed per model and per endpoint (`modelStatsKey`), not per key: tool support
// is a property of the model behind one relay, and sibling keys share it.
import { modelStatsKey } from './endpoint-scope.js';

// Distinct REQUESTS (not hops) that must see the rejection before the model is
// deferred: one odd request must not condemn a model.
export const TOOL_REJECTION_LIMIT = 3;
export const TOOL_REJECTION_WINDOW_MS = 60 * 60 * 1000;
// Long enough to stop the per-request re-walk, short enough that a relay which
// fixes its tool support comes back the same day without a restart.
export const TOOL_BENCH_MS = 6 * 60 * 60 * 1000;

const rejections = new Map<string, number[]>(); // statsKey -> rejection timestamps
const benchedUntil = new Map<string, number>(); // statsKey -> expiry (ms)

export function toolCapabilityKey(platform: string, modelId: string, endpointScope: string | null | undefined): string {
  return modelStatsKey(platform, modelId, endpointScope);
}

/** Defer this model for tool requests right now (evidence is already conclusive). */
export function benchForTools(key: string, now: number = Date.now()): void {
  const already = (benchedUntil.get(key) ?? 0) > now;
  benchedUntil.set(key, now + TOOL_BENCH_MS);
  rejections.delete(key);
  if (!already) {
    console.warn(`[ToolCapability] ${key} keeps rejecting tool-calling requests; trying it last for tool requests for ${Math.round(TOOL_BENCH_MS / 3_600_000)}h`);
  }
}

/** One tool-carrying request was rejected as a bad request by this model. */
export function noteToolRejection(key: string, now: number = Date.now()): void {
  const recent = (rejections.get(key) ?? []).filter(t => now - t < TOOL_REJECTION_WINDOW_MS);
  recent.push(now);
  if (recent.length >= TOOL_REJECTION_LIMIT) benchForTools(key, now);
  else rejections.set(key, recent);
}

/** The model just served a tool-carrying request: it supports tools after all. */
export function clearToolRejections(key: string): void {
  rejections.delete(key);
  benchedUntil.delete(key);
}

export function isToolBenched(platform: string, modelId: string, endpointScope: string | null | undefined, now: number = Date.now()): boolean {
  const key = toolCapabilityKey(platform, modelId, endpointScope);
  const until = benchedUntil.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  benchedUntil.delete(key);
  return false;
}

export function resetToolCapability(): void {
  rejections.clear();
  benchedUntil.clear();
}
