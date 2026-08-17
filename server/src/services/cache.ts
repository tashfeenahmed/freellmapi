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
import { getDb, getSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
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
    v: 4, // #892: explicit-but-default-valued sampling params dropped from key
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

// defaultableNumber 把「显式传入但等于 API 默认值」的采样参数归一为
// undefined（stableStringify 会丢弃），使「总是序列化完整参数」的客户端
// 与「省略默认参数」的客户端命中同一缓存条目——这是 #892 提高命中率的
// 核心：否则 top_p:1 / presence_penalty:0 / frequency_penalty:0 等显式
// 默认值会让两个内容完全相同的请求哈希出不同的 key。
// 非数字（如 null / 字符串 / 缺失）原样返回，保持既有行为。
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
  /** #892-3 流式重放：完整成功的 SSE chunk 序列（不含 [DONE]）。非流式条目为 undefined。 */
  streamFrames?: unknown[];
}

export interface StoreInput {
  body: unknown;
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
  /** #892-3 流式重放：缓存该请求产出的 SSE chunk 序列（不含 [DONE]）。 */
  streamFrames?: unknown[];
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
  streamFrames?: unknown[];
}

// Insertion-ordered map used as an LRU: the first key is the least-recently
// used, the last is the most-recently used. A read or write re-inserts its key
// at the end (delete + set), so eviction from the front drops the coldest entry.
//
// #892 SQLite persistence: entries also live in the `response_cache` table so
// they survive restarts — free-tier quota resets at UTC midnight, and the same
// tasks re-run after the reset hit again instead of burning quota anew.
// The in-memory LRU is kept as a read/write hot cache; both views are updated
// together and the SQLite table is the source of truth for eviction counts.
const store = new Map<string, CacheEntry>();

// 运行期未命中计数（#892 hit-rate 指标）。miss = getCachedResponse 被调用但
// 无有效条目（不存在或已过期）。与 store 中的 hitCount 累计互不影响；
// 由于缓存默认关闭，只有缓存激活时的查询会计入。
let totalMisses = 0;

// SQLite 表 schema（惰性建表，同一 db 实例只建一次）。
const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS response_cache (
  cache_key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  last_hit_at_ms INTEGER,
  stream_frames TEXT
)`;

let schemaReadyDb: unknown = null;
function ensureSchema(db: Db): void {
  if (schemaReadyDb === db) return;
  db.exec(CACHE_SCHEMA);
  // #892-3 流式重放：旧库可能缺 stream_frames 列（IF NOT EXISTS 不重建），
  // 检测缺失时 ALTER 补上。
  try {
    const cols = db.prepare('PRAGMA table_info(response_cache)').all() as { name: string }[];
    if (!cols.some(c => c.name === 'stream_frames')) {
      db.exec('ALTER TABLE response_cache ADD COLUMN stream_frames TEXT');
    }
  } catch {
    /* best-effort: 查询失败按表不存在处理（后续写入会再建表） */
  }
  schemaReadyDb = db;
}

// Fail-safe DB access（仿 ratelimit.withDb）：DB 未初始化/查询失败时返回
// undefined，调用方按「缓存不可用」处理，绝不在代理热路径上抛异常。
function withDb<T>(fn: (db: Db) => T): T | undefined {
  try {
    return fn(getDb());
  } catch {
    return undefined;
  }
}

interface CacheRow {
  cache_key: string;
  body: string;
  platform: string;
  model_id: string;
  key_id: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  hit_count: number;
  created_at_ms: number;
  last_hit_at_ms: number | null;
  stream_frames: string | null;
}

/**
 * Look up a cached completion. Returns null on a miss or when the entry has aged
 * past the TTL (expired entries are deleted lazily on read). A hit bumps the
 * entry's hit_count and moves it to most-recently-used.
 *
 * #892: entries persist in SQLite, so a cold process (or the daily quota reset)
 * still hits the same answers. The in-memory LRU is a hot cache; a miss there
 * falls through to SQLite and re-warms the LRU.
 */
export function getCachedResponse(cacheKey: string, now = Date.now()): CachedResponse | null {
  let entry = store.get(cacheKey);
  if (!entry) {
    // Cold path: try SQLite (persisted across restarts / evictions).
    const row = withDb(db => {
      ensureSchema(db);
      return db.prepare(
        `SELECT body, platform, model_id, key_id, prompt_tokens, completion_tokens,
                hit_count, created_at_ms, last_hit_at_ms, stream_frames
           FROM response_cache WHERE cache_key = ?`,
      ).get(cacheKey) as CacheRow | undefined;
    });
    if (row) {
      let streamFrames: unknown[] | undefined;
      if (row.stream_frames) {
        try {
          streamFrames = JSON.parse(row.stream_frames);
        } catch {
          streamFrames = undefined;
        }
      }
      entry = {
        body: JSON.parse(row.body),
        platform: row.platform,
        modelId: row.model_id,
        keyId: row.key_id,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        hitCount: row.hit_count,
        createdAtMs: row.created_at_ms,
        lastHitAtMs: row.last_hit_at_ms,
        streamFrames,
      };
      store.set(cacheKey, entry);
    }
  }
  if (!entry) {
    totalMisses += 1;
    return null;
  }

  if (now - entry.createdAtMs > cacheTtlMs()) {
    store.delete(cacheKey);
    withDb(db => db.prepare('DELETE FROM response_cache WHERE cache_key = ?').run(cacheKey));
    totalMisses += 1;
    return null;
  }

  entry.hitCount += 1;
  entry.lastHitAtMs = now;
  // Move to most-recently-used.
  store.delete(cacheKey);
  store.set(cacheKey, entry);
  // Persist the hit bump so stats/eviction stay correct across restarts.
  withDb(db => db.prepare(
    'UPDATE response_cache SET hit_count = ?, last_hit_at_ms = ? WHERE cache_key = ?',
  ).run(entry.hitCount, now, cacheKey));

  return {
    body: entry.body,
    platform: entry.platform,
    modelId: entry.modelId,
    keyId: entry.keyId,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    streamFrames: entry.streamFrames,
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
  let bodyJson = '';
  try {
    bodyJson = JSON.stringify(input.body);
  } catch {
    return;
  }
  // 流式条目：frames 也必须可序列化（命中时逐帧重放）。
  let framesJson: string | null = null;
  if (input.streamFrames) {
    try {
      framesJson = JSON.stringify(input.streamFrames);
    } catch {
      return;
    }
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
    streamFrames: input.streamFrames,
  });

  // Persist (INSERT OR REPLACE keeps the schema row count bounded to the cap).
  withDb(db => {
    ensureSchema(db);
    db.prepare(
      `INSERT OR REPLACE INTO response_cache
         (cache_key, body, platform, model_id, key_id, prompt_tokens, completion_tokens,
          hit_count, created_at_ms, last_hit_at_ms, stream_frames)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
    ).run(
      cacheKey, bodyJson, input.platform, input.modelId,
      input.keyId ?? null, input.promptTokens, input.completionTokens, now, framesJson,
    );
    // Enforce the cap in SQLite too (delete least-recently-used beyond cap).
    const cap = cacheMaxEntries();
    db.prepare(
      `DELETE FROM response_cache WHERE cache_key IN (
         SELECT cache_key FROM response_cache
         ORDER BY COALESCE(last_hit_at_ms, created_at_ms) ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM response_cache) - ?)
       )`,
    ).run(cap);
  });

  // Evict least-recently-used beyond the cap in the in-memory LRU.
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
  misses: number; // 运行期未命中次数（#892 hit-rate 指标）
  hitRate: number; // 0..1，hits/(hits+misses)；无查询时为 0
  savedPromptTokens: number;
  savedCompletionTokens: number;
}

/**
 * Aggregate cache stats for the dashboard. "saved" tokens are the provider
 * tokens that hits avoided spending: hit_count x the entry's token counts,
 * summed, i.e. the free-tier quota the cache gave back.
 *
 * #892: totals are aggregated from SQLite (source of truth), so stats survive
 * restarts and match what a cold process would actually serve.
 */
export function getCacheStats(): CacheStats {
  const agg = withDb(db => {
    ensureSchema(db);
    return db.prepare(
      `SELECT COUNT(*) AS entries,
              COALESCE(SUM(hit_count), 0) AS total_hits,
              COALESCE(SUM(hit_count * prompt_tokens), 0) AS saved_prompt,
              COALESCE(SUM(hit_count * completion_tokens), 0) AS saved_completion
         FROM response_cache`,
    ).get() as {
      entries: number;
      total_hits: number;
      saved_prompt: number;
      saved_completion: number;
    };
  });
  const totalHits = agg?.total_hits ?? 0;
  const savedPromptTokens = agg?.saved_prompt ?? 0;
  const savedCompletionTokens = agg?.saved_completion ?? 0;
  const lookups = totalHits + totalMisses;
  return {
    entries: agg?.entries ?? 0,
    totalHits,
    misses: totalMisses,
    hitRate: lookups > 0 ? totalHits / lookups : 0,
    savedPromptTokens,
    savedCompletionTokens,
  };
}

/** Drop every cached entry (memory + SQLite). Returns the number removed. */
export function clearCache(): number {
  const removed = store.size;
  store.clear();
  withDb(db => {
    ensureSchema(db);
    db.prepare('DELETE FROM response_cache').run();
  });
  return removed;
}
