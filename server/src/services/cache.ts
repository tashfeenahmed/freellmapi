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
//     evicted first), so the cache can never grow without bound.
//   - Optionally durable. When the cache is ON, the same entries are written
//     through to the response_cache table so a restart does not throw the day's
//     savings away (the daily quota-reset re-run pattern). This means PLAINTEXT
//     model responses land on disk, which is a privacy posture change, so it is
//     tied to the cache master switch and can be turned off on its own with
//     RESPONSE_CACHE_PERSIST=false (memory-only, the pre-0.9.5 behaviour). The
//     SQLite row is dropped whenever the memory entry goes: TTL expiry, LRU
//     eviction, an explicit flush, or the startup purge.
//   - Fail-safe reads. The settings lookup that decides the master switch is
//     wrapped, so a not-yet-initialized DB disables the cache rather than
//     throwing in the proxy hot path (mirrors services/ratelimit.ts).

import crypto from 'crypto';
import { getSetting, getDb } from '../db/index.js';
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

/**
 * Write-through to SQLite. Only meaningful when the cache itself is on, so an
 * install that never enabled caching persists nothing and the feature is inert.
 * Separately switchable because persisting plaintext model responses to disk is
 * a privacy decision an operator may want to decline while still caching.
 */
export function cachePersistenceEnabled(): boolean {
  return isCacheEnabled() && envFlag('RESPONSE_CACHE_PERSIST', true);
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
  reasoning_effort?: unknown;
  // Request-side compression runs before cache lookup. Include its resolved
  // mode/config fingerprint so a settings change cannot replay an answer
  // produced from a different compressed prompt shape.
  compression?: unknown;
}

function normModel(model: string | undefined): string {
  // Omitted and the explicit "auto" sentinel mean the same thing (let the router
  // decide), so they must share a cache bucket.
  return !model || model === 'auto' ? 'auto' : model;
}

export function computeCacheKey(input: CacheKeyInput): string {
  const canonical = stableStringify({
    v: 4, // explicit-but-default-valued sampling params dropped from the key
    model: normModel(input.model),
    messages: input.messages,
    temperature: input.temperature,
    top_p: defaultableNumber(input.top_p, 1),
    max_tokens: input.max_tokens,
    // tools/tool_choice are part of the key so a request with a different tool
    // set never collides with (or is served) another's cached answer.
    tools: input.tools,
    tool_choice: input.tool_choice,
    // Remaining knobs (see CacheKeyInput). Absent/undefined fields are dropped
    // by stableStringify, so requests without them keep hashing identically.
    stop: input.stop,
    response_format: input.response_format,
    n: defaultableNumber(input.n, 1),
    seed: input.seed,
    presence_penalty: defaultableNumber(input.presence_penalty, 0),
    frequency_penalty: defaultableNumber(input.frequency_penalty, 0),
    logit_bias: input.logit_bias,
    logprobs: input.logprobs,
    top_logprobs: input.top_logprobs,
    // Absent for requests without the knob (stableStringify drops undefined),
    // so pre-existing cache keys are unaffected.
    reasoning_effort: input.reasoning_effort,
    compression: input.compression,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Normalizes a sampling param that was passed explicitly but equals the API
// default down to undefined (stableStringify drops undefined), so a client that
// always serializes the full param set shares a cache entry with one that omits
// the defaults. Without this, top_p:1 / n:1 / presence_penalty:0 /
// frequency_penalty:0 make two otherwise identical requests hash to different
// keys and miss each other. Non-numbers (null, strings, absent) pass through
// unchanged so existing behaviour is preserved.
function defaultableNumber(value: unknown, defaultValue: number): unknown {
  if (typeof value === 'number') {
    if (value === defaultValue) return undefined;
    return value;
  }
  return value;
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

// Streaming entries live in their own LRU: a stream's replayable artifact is
// the exact SSE frame sequence, which is structurally different from a JSON
// completion body, so the two kinds never share a key across stores.
interface StreamCacheEntry {
  frames: string[]; // verbatim `data: {...}\n\n` (and final `[DONE]`) frames
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
  hitCount: number;
  createdAtMs: number;
  lastHitAtMs: number | null;
}
const streamStore = new Map<string, StreamCacheEntry>();

function evictToCap<K, V>(map: Map<K, V>): void {
  const cap = cacheMaxEntries();
  while (map.size > cap) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// Lifetime-of-process lookup tallies, the denominator behind the dashboard's
// hit rate. Entries alone cannot provide it: a cache that is 99% empty is 0%
// useful, and a flushed store would otherwise read as a 100% hit rate.
// Counted only when a request actually consulted the cache (a cacheKey was
// computed), never for requests that bypassed it.
//
// Deliberately NOT seeded from SQLite on load. Hits persist per row
// (response_cache.hit_count) but a miss has no row to live on, so restoring
// only the hits would report a rate biased upward after every restart. A ratio
// is only honest when numerator and denominator cover the same window, and
// that window is this process. The savings figures below are the ones that
// survive a restart, because they ride on the entries themselves.
let lookupHits = 0;
let lookupMisses = 0;

// ── Deferred SQLite write-through ──
// better-sqlite3 is synchronous, so a store/hit write would sit on the request
// path (a large completion body is a multi-KB write with an fsync behind it).
// Every persistence write is therefore queued and drained on the next tick: the
// in-memory map is already correct by then, and a crash in the gap only costs
// a cache entry. Individually wrapped so one bad write cannot take down the
// drain, and skipped entirely when persistence is off.
const pendingWrites: Array<() => void> = [];
let drainScheduled = false;

function schedulePersist(op: () => void): void {
  if (!cachePersistenceEnabled()) return;
  pendingWrites.push(op);
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(drainPendingWrites);
}

function drainPendingWrites(): void {
  drainScheduled = false;
  const ops = pendingWrites.splice(0, pendingWrites.length);
  for (const op of ops) {
    try {
      op();
    } catch {
      // best-effort: a DB failure degrades to memory-only, never to a 500
    }
  }
}

function scheduleRowDelete(cacheKey: string): void {
  schedulePersist(() => {
    getDb().prepare('DELETE FROM response_cache WHERE cache_key = ?').run(cacheKey);
  });
}

/**
 * Test-only: run the queued write-through immediately instead of on the next
 * tick, so a synchronous test can assert on what actually reached SQLite.
 */
export function __flushPersistenceForTests(): void {
  drainPendingWrites();
}

/**
 * Test-only: drop the in-memory LRU while leaving the SQLite table intact, the
 * way a process restart does. (clearCache() is the user-facing flush and wipes
 * both, so it cannot stand in for a restart.) Pending write-through is drained
 * first, since a real restart's writes had already landed. Streaming entries
 * are memory-only (never written through), so a restart drops them too.
 */
export function __resetMemoryForTests(): void {
  drainPendingWrites();
  store.clear();
  streamStore.clear();
  lookupHits = 0;
  lookupMisses = 0;
}

/**
 * Look up a cached completion. Returns null on a miss or when the entry has aged
 * past the TTL (expired entries are deleted lazily on read, in memory and on
 * disk). A hit bumps the entry's hit_count and moves it to most-recently-used.
 */
export function getCachedResponse(cacheKey: string, now = Date.now()): CachedResponse | null {
  const entry = store.get(cacheKey);
  if (!entry) {
    lookupMisses += 1;
    return null;
  }

  if (now - entry.createdAtMs > cacheTtlMs()) {
    store.delete(cacheKey);
    // The row would otherwise outlive its memory entry until the next restart.
    scheduleRowDelete(cacheKey);
    lookupMisses += 1;
    return null;
  }

  lookupHits += 1;
  entry.hitCount += 1;
  entry.lastHitAtMs = now;
  // Move to most-recently-used.
  store.delete(cacheKey);
  store.set(cacheKey, entry);

  // Keep the persisted counters in step so the savings numbers survive a
  // restart instead of resetting to whatever the last store wrote.
  const hitCount = entry.hitCount;
  schedulePersist(() => {
    getDb()
      .prepare('UPDATE response_cache SET hit_count = ?, last_hit_at_ms = ? WHERE cache_key = ?')
      .run(hitCount, now, cacheKey);
  });

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
 *
 * SQLite persistence: when the cache is on, the entry is also written through
 * to the response_cache table so it survives a restart (the daily quota-reset
 * re-run pattern). The write is deferred to the next tick and best-effort, so
 * it never sits on — or throws into — the proxy hot path; a DB failure degrades
 * to in-memory-only, exactly as before.
 */
export function storeCachedResponse(cacheKey: string, input: StoreInput, now = Date.now()): void {
  // Reject bodies that can't be JSON-serialized; a hit must be replayable.
  let bodyJson: string;
  try {
    bodyJson = JSON.stringify(input.body);
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
    // Evicting in memory but not on disk would let the table grow without
    // bound and let a restart resurrect entries the LRU already gave up on.
    scheduleRowDelete(oldest);
  }

  // Write-through to SQLite. hit_count is stored at its current in-memory value
  // (0 for a fresh store, since an overwrite resets the rolling stat with the
  // answer it counts); subsequent hits update the row in getCachedResponse.
  const entry = store.get(cacheKey);
  if (!entry) return; // cap of 0: the entry was evicted by the loop above
  const expiresAtMs = now + cacheTtlMs();
  schedulePersist(() => {
    getDb().prepare(
      `INSERT INTO response_cache
         (cache_key, body_json, platform, model_id, key_id, prompt_tokens, completion_tokens, hit_count, created_at_ms, last_hit_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         body_json = excluded.body_json,
         platform = excluded.platform,
         model_id = excluded.model_id,
         key_id = excluded.key_id,
         prompt_tokens = excluded.prompt_tokens,
         completion_tokens = excluded.completion_tokens,
         hit_count = excluded.hit_count,
         created_at_ms = excluded.created_at_ms,
         last_hit_at_ms = excluded.last_hit_at_ms,
         expires_at_ms = excluded.expires_at_ms`,
    ).run(
      cacheKey,
      bodyJson,
      input.platform,
      input.modelId,
      input.keyId,
      input.promptTokens,
      input.completionTokens,
      entry.hitCount,
      now,
      entry.lastHitAtMs,
      expiresAtMs,
    );
  });
}

/**
 * Reload unexpired entries from SQLite into the in-memory LRU, bounded by
 * RESPONSE_CACHE_MAX_ENTRIES. Called once at startup (after initDb) from both
 * boot paths, server/src/index.ts and desktop/src/server-host.ts; expired rows
 * are purged opportunistically. Best-effort: any DB error leaves the cache
 * empty (memory-only), matching the pre-persistence behavior.
 */
export function loadCacheFromDb(now = Date.now()): void {
  try {
    const db = getDb();
    // Purge expired rows lazily on startup so the table doesn't accumulate
    // dead entries between restarts. Unconditional: rows written while the
    // cache was on must still age out after it is switched off.
    db.prepare('DELETE FROM response_cache WHERE expires_at_ms <= ?').run(now);
    // Hydration only when the operator actually wants the cache (and its
    // on-disk half). Off by default, so this is inert on an untouched install.
    if (!cachePersistenceEnabled()) return;
    const rows = db.prepare(
      `SELECT cache_key, body_json, platform, model_id, key_id, prompt_tokens, completion_tokens, hit_count, created_at_ms, last_hit_at_ms
         FROM response_cache
        ORDER BY created_at_ms ASC`,
    ).all() as Array<{
      cache_key: string;
      body_json: string;
      platform: string;
      model_id: string;
      key_id: number | null;
      prompt_tokens: number;
      completion_tokens: number;
      hit_count: number;
      created_at_ms: number;
      last_hit_at_ms: number | null;
    }>;
    const cap = cacheMaxEntries();
    // Newest wins: drop rows past the cap from the FRONT (oldest first).
    const keep = rows.length > cap ? rows.slice(rows.length - cap) : rows;
    for (const row of keep) {
      if (now - row.created_at_ms > cacheTtlMs()) continue; // aged between purge and read
      try {
        store.set(row.cache_key, {
          body: JSON.parse(row.body_json),
          platform: row.platform,
          modelId: row.model_id,
          keyId: row.key_id,
          promptTokens: row.prompt_tokens,
          completionTokens: row.completion_tokens,
          hitCount: row.hit_count,
          createdAtMs: row.created_at_ms,
          lastHitAtMs: row.last_hit_at_ms,
        });
      } catch {
        // corrupt body — skip; it will be overwritten on the next store
      }
    }
  } catch {
    // best-effort: DB unavailable at startup → memory-only cache
  }
}

// ── Streaming entries ──

export interface CachedStreamResponse {
  frames: string[];
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface StoreStreamInput {
  frames: string[];
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Look up a cached stream. Returns null on a miss or when the entry has aged
 * past the TTL. A hit bumps hit_count and moves the entry to MRU.
 */
export function getCachedStreamResponse(cacheKey: string, now = Date.now()): CachedStreamResponse | null {
  const entry = streamStore.get(cacheKey);
  if (!entry) return null;

  if (now - entry.createdAtMs > cacheTtlMs()) {
    streamStore.delete(cacheKey);
    return null;
  }

  entry.hitCount += 1;
  entry.lastHitAtMs = now;
  streamStore.delete(cacheKey);
  streamStore.set(cacheKey, entry);

  return {
    frames: entry.frames,
    platform: entry.platform,
    modelId: entry.modelId,
    keyId: entry.keyId,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
  };
}

/**
 * Store a completed SSE frame sequence for replay. The frames are the verbatim
 * `data: {...}\n\n` lines (including the final `[DONE]`) the client received,
 * so a hit can reproduce the stream byte-for-byte. Best-effort like the JSON
 * store.
 */
export function storeCachedStreamResponse(cacheKey: string, input: StoreStreamInput, now = Date.now()): void {
  if (!Array.isArray(input.frames) || input.frames.length === 0) return;

  streamStore.delete(cacheKey);
  streamStore.set(cacheKey, {
    frames: input.frames,
    platform: input.platform,
    modelId: input.modelId,
    keyId: input.keyId,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    hitCount: 0,
    createdAtMs: now,
    lastHitAtMs: null,
  });

  evictToCap(streamStore);
}

// ── Stats / admin ──

export interface CacheStats {
  entries: number;
  /** Hits accumulated by the entries currently held, restored from SQLite. */
  totalHits: number;
  /** Hits ARE the savings: each one avoided a full provider round-trip. */
  estimatedRequestsSaved: number;
  savedPromptTokens: number;
  savedCompletionTokens: number;
  /** Lookups since this process started — the two halves of the ratio below. */
  lookupHits: number;
  lookupMisses: number;
  /** 0..1 share of this process's lookups that hit (no lookups yet → 0). */
  hitRate: number;
}

/**
 * Aggregate cache stats for the dashboard. "saved" tokens are the provider
 * tokens that hits avoided spending: hit_count x the entry's token counts,
 * summed, i.e. the free-tier quota the cache gave back. Those ride on the
 * entries, so they survive a restart along with the persisted rows.
 *
 * hitRate is deliberately computed from the process-lifetime lookup tallies
 * instead of totalHits: totalHits only counts the entries still held, so an
 * eviction (or a TTL expiry) would silently retire hits that really happened
 * and drag the reported rate down forever.
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
  for (const entry of streamStore.values()) {
    totalHits += entry.hitCount;
    savedPromptTokens += entry.hitCount * entry.promptTokens;
    savedCompletionTokens += entry.hitCount * entry.completionTokens;
  }
  const lookups = lookupHits + lookupMisses;
  return {
    entries: store.size + streamStore.size,
    totalHits,
    estimatedRequestsSaved: totalHits,
    savedPromptTokens,
    savedCompletionTokens,
    lookupHits,
    lookupMisses,
    hitRate: lookups > 0 ? lookupHits / lookups : 0,
  };
}

/**
 * Drop every cached entry, in memory AND on disk. Returns the number removed.
 * The persisted table has to go too: DELETE /api/cache is how an operator
 * forces fresh answers (changed keys, a bad reply, a privacy request), and a
 * flush that left the rows behind would resurrect all of it on the next
 * restart. Queued write-through is discarded for the same reason. Runs inline
 * rather than deferred: this is an admin route, not the proxy hot path.
 */
export function clearCache(): number {
  const removed = store.size + streamStore.size;
  store.clear();
  streamStore.clear();
  pendingWrites.length = 0;
  // The lookup tallies describe the cache that just went away; keeping them
  // would show a 90% hit rate next to zero entries right after a flush.
  lookupHits = 0;
  lookupMisses = 0;
  try {
    getDb().prepare('DELETE FROM response_cache').run();
  } catch {
    // best-effort: no DB (or no table yet) means there is nothing persisted
  }
  return removed;
}
