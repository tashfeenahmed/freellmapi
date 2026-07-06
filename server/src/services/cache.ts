// Opt-in exact-match response cache.
//
// A free-tier-stacking proxy lives or dies by how far it stretches scarce
// quota. Re-asking a model the *same* prompt burns a free-tier slot for an
// answer we already have, which is pure waste. This cache stores successful
// completions keyed by a canonical hash of the request and serves an identical
// later request straight from memory, without touching any provider: zero quota
// cost, near-zero latency, and one fewer 429 on the way to the daily reset.
//
// Design choices that keep it SAFE:
//   - Exact match only. No embeddings / fuzzy matching, so a near-miss can never
//     return a different prompt's answer. The key is a SHA-256 over the
//     canonicalized request, so a single token of difference is a miss.
//   - The key is the REQUEST, not the route. Any model's good answer to an
//     identical prompt is a valid hit, which is what maximizes the hit rate for
//     auto-routed traffic. platform/model_id/key_id are stored for attribution
//     and savings accounting only.
//   - Opt-in. Off unless enabled via the RESPONSE_CACHE env var or the
//     response_cache_enabled setting, so existing installs see no behavior
//     change. A per-request header overrides either way.
//   - Temperature-gated. High-temperature requests are asking for variety, so
//     replaying one frozen answer would defeat that. Cached only when the
//     temperature is omitted or at/below RESPONSE_CACHE_MAX_TEMPERATURE.
//   - In-memory and bounded. Entries live in a size-capped LRU map (oldest use
//     evicted first), so the cache can never grow without bound and a restart
//     simply flushes it. No schema, no migration, no persisted response blobs.
//   - Fail-safe reads. The settings lookup that decides the master switch is
//     wrapped, so a not-yet-initialized DB disables the cache rather than
//     throwing in the proxy hot path (mirrors services/ratelimit.ts).

import crypto from 'crypto';
import { getSetting } from '../db/index.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

// ── Config (read on each call so tests and the dashboard can toggle live) ──

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|on|yes)$/i.test(raw.trim());
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// DB-absent-safe settings read: a not-yet-initialized DB (or any read error)
// must not throw on the proxy hot path, so it degrades to "no setting stored".
function readSetting(key: string): string | undefined {
  try {
    return getSetting(key);
  } catch {
    return undefined;
  }
}

// Setting key that lets the dashboard toggle the cache at runtime, no restart.
export const CACHE_ENABLED_SETTING = 'response_cache_enabled';

/**
 * Master switch. Default off so adopting the cache is an explicit choice. The
 * settings-table value wins when present (dashboard toggle, no restart), then
 * the RESPONSE_CACHE env var, then off.
 */
export function isCacheEnabled(): boolean {
  const stored = readSetting(CACHE_ENABLED_SETTING);
  if (stored !== undefined && stored.trim() !== '') {
    return /^(1|true|on|yes)$/i.test(stored.trim());
  }
  return envFlag('RESPONSE_CACHE', false);
}

/** Entry lifetime. Default 1h: long enough to absorb retries and agent re-runs,
 *  short enough that a refreshed catalog or key changes answers soon after. */
export function cacheTtlMs(): number {
  return envNum('RESPONSE_CACHE_TTL_SECONDS', 3600) * 1000;
}

/** Above this temperature a request wants variety, so it is never cached.
 *  Default 1.0 caches everything when enabled (max quota savings); lower it to
 *  restrict caching to (near-)deterministic calls. */
export function cacheMaxTemperature(): number {
  return envNum('RESPONSE_CACHE_MAX_TEMPERATURE', 1.0);
}

/** Hard cap on stored entries; least-recently-used are evicted past this.
 *  Bounds memory use. */
export function cacheMaxEntries(): number {
  return Math.floor(envNum('RESPONSE_CACHE_MAX_ENTRIES', 5000));
}

// A request is cacheable only when its temperature is omitted (caller accepts
// the provider default and is fine with a stable answer) or at/below the cap.
export function isCacheableTemperature(temperature?: number | null): boolean {
  if (temperature === undefined || temperature === null) return true;
  return temperature <= cacheMaxTemperature();
}

// ── Per-request directive ──
// `X-FreeLLM-Cache: off|on` (and the standard `Cache-Control: no-store`) let a
// caller override the global switch for one request, e.g. force a fresh
// generation, or opt a single call into caching on an otherwise cache-off
// install.
export type CacheDirective = 'default' | 'off' | 'on';

export function parseCacheDirective(
  header: string | string[] | undefined,
  cacheControl?: string | string[] | undefined,
): CacheDirective {
  const cc = (Array.isArray(cacheControl) ? cacheControl[0] : cacheControl)?.toLowerCase() ?? '';
  if (cc.includes('no-store') || cc.includes('no-cache')) return 'off';
  const raw = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  if (!raw) return 'default';
  if (/^(off|no|0|false|bypass|skip)$/.test(raw)) return 'off';
  if (/^(on|yes|1|true|force)$/.test(raw)) return 'on';
  return 'default';
}

/** Resolve the global switch + per-request directive into a single yes/no. */
export function cacheActive(directive: CacheDirective): boolean {
  if (directive === 'off') return false;
  if (directive === 'on') return true;
  return isCacheEnabled();
}

// ── Canonical key ──

// Deterministic JSON: object keys sorted recursively and undefined dropped, so
// two requests that differ only in key order or omitted-vs-undefined fields
// hash identically. (JSON.stringify alone preserves insertion order, which
// varies between clients and would scatter otherwise-identical requests.)
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter(k => obj[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export interface CacheKeyInput {
  model: string | undefined; // the client's `model` field ('auto'/pinned/omitted)
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown;
  tool_choice?: unknown;
  // Every remaining sampling/format knob a client can send. All are part of the
  // key so two requests that differ ONLY in one of these can never be served
  // each other's cached answer (worst case otherwise: a response_format
  // json_object request gets a cached plain-text reply). Wrong-answer
  // collisions are worse than missed hits, so these are keyed even when the
  // proxy does not currently forward them upstream. Loosely typed on purpose:
  // several arrive un-validated straight from the request body.
  stop?: unknown;
  response_format?: unknown;
  n?: unknown;
  seed?: unknown;
  presence_penalty?: unknown;
  frequency_penalty?: unknown;
  logit_bias?: unknown;
  logprobs?: unknown;
  top_logprobs?: unknown;
}

function normModel(model: string | undefined): string {
  // Omitted and the explicit "auto" sentinel mean the same thing (let the router
  // decide), so they must share a cache bucket.
  return !model || model === 'auto' ? 'auto' : model;
}

export function computeCacheKey(input: CacheKeyInput): string {
  const canonical = stableStringify({
    v: 2, // bump to invalidate every entry if the cached shape ever changes
    model: normModel(input.model),
    messages: input.messages,
    temperature: input.temperature,
    top_p: input.top_p,
    max_tokens: input.max_tokens,
    // tools/tool_choice are part of the key so a request with a different tool
    // set never collides with (or is served) another's cached answer.
    tools: input.tools,
    tool_choice: input.tool_choice,
    // Remaining knobs (see CacheKeyInput). Absent/undefined fields are dropped
    // by stableStringify, so requests without them keep hashing identically.
    stop: input.stop,
    response_format: input.response_format,
    n: input.n,
    seed: input.seed,
    presence_penalty: input.presence_penalty,
    frequency_penalty: input.frequency_penalty,
    logit_bias: input.logit_bias,
    logprobs: input.logprobs,
    top_logprobs: input.top_logprobs,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ── Store ──

export interface CachedResponse {
  body: unknown; // the full OpenAI-shaped completion JSON, replayed verbatim
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface StoreInput {
  body: unknown;
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
}

interface CacheEntry {
  body: unknown;
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
  hitCount: number;
  createdAtMs: number;
  lastHitAtMs: number | null;
}

// Insertion-ordered map used as an LRU: the first key is the least-recently
// used, the last is the most-recently used. A read or write re-inserts its key
// at the end (delete + set), so eviction from the front drops the coldest entry.
const store = new Map<string, CacheEntry>();

/**
 * Look up a cached completion. Returns null on a miss or when the entry has aged
 * past the TTL (expired entries are deleted lazily on read). A hit bumps the
 * entry's hit_count and moves it to most-recently-used.
 */
export function getCachedResponse(cacheKey: string, now = Date.now()): CachedResponse | null {
  const entry = store.get(cacheKey);
  if (!entry) return null;

  if (now - entry.createdAtMs > cacheTtlMs()) {
    store.delete(cacheKey);
    return null;
  }

  entry.hitCount += 1;
  entry.lastHitAtMs = now;
  // Move to most-recently-used.
  store.delete(cacheKey);
  store.set(cacheKey, entry);

  return {
    body: entry.body,
    platform: entry.platform,
    modelId: entry.modelId,
    keyId: entry.keyId,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
  };
}

/**
 * Store a successful completion. Overwrites any existing entry for the key (a
 * re-generation refreshes the cached answer, its TTL, and its hit count).
 * Enforces the entry cap by evicting the least-recently-used entries. Best-
 * effort: an unserializable body is skipped so caching can never break a
 * request that already succeeded.
 */
export function storeCachedResponse(cacheKey: string, input: StoreInput, now = Date.now()): void {
  // Reject bodies that can't be JSON-serialized; a hit must be replayable.
  try {
    JSON.stringify(input.body);
  } catch {
    return;
  }

  // Delete-then-set so an overwrite also refreshes recency order.
  store.delete(cacheKey);
  store.set(cacheKey, {
    body: input.body,
    platform: input.platform,
    modelId: input.modelId,
    keyId: input.keyId,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    hitCount: 0,
    createdAtMs: now,
    lastHitAtMs: null,
  });

  // Evict least-recently-used beyond the cap. The count only drifts by one per
  // insert, so at most one entry is removed per call in steady state.
  const cap = cacheMaxEntries();
  while (store.size > cap) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// ── Stats / admin ──

export interface CacheStats {
  entries: number;
  totalHits: number;
  savedPromptTokens: number;
  savedCompletionTokens: number;
}

/**
 * Aggregate cache stats for the dashboard. "saved" tokens are the provider
 * tokens that hits avoided spending: hit_count x the entry's token counts,
 * summed, i.e. the free-tier quota the cache gave back.
 */
export function getCacheStats(): CacheStats {
  let totalHits = 0;
  let savedPromptTokens = 0;
  let savedCompletionTokens = 0;
  for (const entry of store.values()) {
    totalHits += entry.hitCount;
    savedPromptTokens += entry.hitCount * entry.promptTokens;
    savedCompletionTokens += entry.hitCount * entry.completionTokens;
  }
  return { entries: store.size, totalHits, savedPromptTokens, savedCompletionTokens };
}

/** Drop every cached entry. Returns the number removed. */
export function clearCache(): number {
  const removed = store.size;
  store.clear();
  return removed;
}
