import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../db/index.js';
// Single shared Retry-After parser (was duplicated here and in providers/base.ts).
import { parseRetryAfterMs } from '../providers/base.js';
import type {
  Platform,
  QuotaMetric,
  QuotaObservationSource,
  QuotaResetStrategy,
  ProviderQuotaObservation,
  ProviderQuotaState,
} from '@freellmapi/shared/types.js';

export interface QuotaObservationContext {
  platform: Platform;
  keyId?: number;
  providerAccountId?: string | null;
  modelId?: string | null;
  quotaPoolKey?: string | null;
  endpoint?: string | null;
  origin?: 'health' | 'proxy' | 'responses' | 'manual' | 'probe';
}

export interface QuotaObservationInput {
  platform?: Platform;
  keyId?: number;
  providerAccountId?: string | null;
  modelId?: string | null;
  quotaPoolKey?: string | null;
  metric?: QuotaMetric;
  limit?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  retryAfterMs?: number | null;
  resetStrategy?: QuotaResetStrategy;
  source?: QuotaObservationSource;
  statusCode?: number | null;
  notes?: string | null;
  rawJson?: string | null;
  endpoint?: string | null;
  confidence?: number;
  observedAt?: string;
}

export interface QuotaObservationView extends ProviderQuotaState {
  providerAccountId: string | null;
  modelId: string | null;
  endpoint: string | null;
  statusCode: number | null;
  retryAfterMs: number | null;
  rawJson: string | null;
  createdAt: string;
}

const contextStore = new AsyncLocalStorage<QuotaObservationContext>();

const DEFAULT_CONFIDENCE: Record<QuotaObservationSource, number> = {
  header: 1,
  quota_api: 1,
  error_body: 0.75,
  local_usage: 0.45,
  documentation: 0.35,
  probe: 0.6,
};

const SOURCE_PRIORITY: Record<QuotaObservationSource, number> = {
  header: 5,
  quota_api: 5,
  error_body: 4,
  probe: 3,
  local_usage: 2,
  documentation: 1,
};

export function runWithQuotaObservationContext<T>(context: QuotaObservationContext, fn: () => T): T {
  return contextStore.run(context, fn);
}

export function getQuotaObservationContext(): QuotaObservationContext | undefined {
  return contextStore.getStore();
}

function isoNow(): string {
  return new Date().toISOString();
}

function toSqliteUtc(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function parseHeaderNumber(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

function parseResetAtFromHeader(raw: string | null, now = Date.now()): string | null {
  const parsed = parseHeaderNumber(raw);
  if (parsed === null) return null;
  if (parsed > 1_000_000_000_000) return new Date(parsed).toISOString();
  if (parsed > 1_000_000_000) return new Date(parsed * 1000).toISOString();
  return new Date(now + parsed * 1000).toISOString();
}

function pickBetterSource(existing: QuotaObservationSource | null | undefined, next: QuotaObservationSource): QuotaObservationSource {
  if (!existing) return next;
  return SOURCE_PRIORITY[next] >= SOURCE_PRIORITY[existing] ? next : existing;
}

function inferPoolForPlatform(platform: Platform, modelId?: string | null): string {
  const normalizedModelId = modelId?.trim() ?? '';
  if (platform === 'openrouter') return normalizedModelId.endsWith(':free') ? 'openrouter::free' : 'openrouter::account';
  if (platform === 'google') return 'google::project';
  if (platform === 'groq') return 'groq::account';
  if (platform === 'cerebras') return 'cerebras::shared';
  if (platform === 'sail') return 'sail::monthly-credit';
  if (platform === 'bai') return 'bai::promo';
  if (platform === 'sambanova') return 'sambanova::shared';
  if (platform === 'nvidia') return 'nvidia::credit-pool';
  if (platform === 'mistral') return 'mistral::experiment-pool';
  if (platform === 'github') return 'github::account';
  if (platform === 'cohere') return 'cohere::trial-pool';
  if (platform === 'cloudflare') return 'cloudflare::account';
  if (platform === 'zhipu') return 'zhipu::account';
  if (platform === 'ollama') return 'ollama::cloud';
  if (platform === 'kilo') return 'kilo::anonymous';
  if (platform === 'pollinations') return 'pollinations::account';
  if (platform === 'llm7') return 'llm7::anonymous';
  // AI Horde: anonymous requests share one queue priority (the 0000000000 key),
  // so they pool together; a registered key has its own kudos priority but we
  // still bucket per-platform here.
  if (platform === 'aihorde') return 'aihorde::anonymous';
  if (platform === 'huggingface') return 'huggingface::router';
  if (platform === 'opencode') return 'opencode::promo';
  // Aggregators with a single shared free pool across all ':free'/'auto:free' models.
  if (platform === 'routeway') return 'routeway::free';
  if (platform === 'bazaarlink') return 'bazaarlink::free';
  if (platform === 'ainative') return 'ainative::account';
  if (platform === 'aion') return 'aion::free';
  if (platform === 'requesty') return 'requesty::free';
  if (platform === 'navy') return 'navy::free';
  if (platform === 'nara') return 'nara::free';
  if (platform === 'sealion') return 'sealion::free';
  // OrcaRouter: one rate-limited free allowance across all `*-free` aliases
  // and the `orcarouter/free` auto route (limits unpublished; 429 on cap).
  if (platform === 'orcarouter') return 'orcarouter::free';
  // UnoRouter: the docs say 1 req/min per free model, but live-probed
  // 2026-08-23 a burst across many `:free` models put the whole account into
  // 429 on every model for several minutes — so one pool, and a 429 on any
  // model backs off the platform as a whole.
  if (platform === 'unorouter') return 'unorouter::free';
  // xkiro: one account-level allowance shared across its free models (the
  // free tier is a per-account grant, not per-model), so one pool.
  if (platform === 'xkiro') return 'xkiro::free';
  // AnyAPI: the free tier is one 100K-tokens/day budget for the whole account,
  // shared across every free/basic model — so one pool, not one per model.
  if (platform === 'anyapi') return 'anyapi::free';
  // ModelScope: one 2000-requests/day quota across the whole account.
  if (platform === 'modelscope') return 'modelscope::account';
  return normalizedModelId ? `${platform}::${normalizedModelId}` : `${platform}::account`;
}

function isSharedPool(platform: Platform): boolean {
  return ['openrouter', 'google', 'groq', 'cerebras', 'sail', 'bai', 'sambanova', 'nvidia', 'mistral', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'routeway', 'bazaarlink', 'ainative', 'aion', 'requesty', 'navy', 'nara', 'sealion', 'orcarouter', 'unorouter', 'xkiro', 'anyapi', 'modelscope', 'aihorde'].includes(platform);
}

type HeaderSpec = { metric: QuotaMetric; limit: string; remaining?: string; reset?: string; strategy?: QuotaResetStrategy };

const HEADER_SPECS: Partial<Record<Platform, HeaderSpec[]>> = {
  groq: [
    { metric: 'requests', limit: 'x-ratelimit-limit-requests', remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests', strategy: 'provider_reported' },
    { metric: 'tokens', limit: 'x-ratelimit-limit-tokens', remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens', strategy: 'provider_reported' },
  ],
  cerebras: [
    { metric: 'requests', limit: 'x-ratelimit-limit-requests-day', remaining: 'x-ratelimit-remaining-requests-day', reset: 'x-ratelimit-reset-requests-day', strategy: 'provider_reported' },
    { metric: 'tokens', limit: 'x-ratelimit-limit-tokens-minute', remaining: 'x-ratelimit-remaining-tokens-minute', reset: 'x-ratelimit-reset-tokens-minute', strategy: 'token_bucket' },
  ],
  openrouter: [
    { metric: 'requests', limit: 'x-ratelimit-limit-requests', remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests', strategy: 'provider_reported' },
    { metric: 'tokens', limit: 'x-ratelimit-limit-tokens', remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens', strategy: 'provider_reported' },
  ],
  // ModelScope reportedly returns `modelscope-ratelimit-*`-style headers on
  // authenticated responses. UNCONFIRMED: no real token exists for this
  // platform yet (auth needs an Alibaba Cloud cn-site binding, #581), and the
  // keyless probes we could run (401s, unauthenticated /v1/models) carry no
  // ratelimit headers at all. Absent headers are a no-op in
  // maybeAddObservation, so a wrong guess here costs nothing; community
  // testers should dump response headers (see the #581 tester guide) and
  // correct these names.
  modelscope: [
    { metric: 'requests', limit: 'modelscope-ratelimit-requests-limit', remaining: 'modelscope-ratelimit-requests-remaining', reset: 'modelscope-ratelimit-requests-reset', strategy: 'provider_reported' },
  ],
};

function extractContext(opts: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'> = {}) {
  const context = getQuotaObservationContext();
  const platform = opts.platform ?? context?.platform;
  if (!platform) return null;
  return {
    platform,
    keyId: opts.keyId ?? context?.keyId ?? 0,
    providerAccountId: opts.providerAccountId ?? context?.providerAccountId ?? null,
    modelId: opts.modelId ?? context?.modelId ?? null,
    quotaPoolKey: opts.quotaPoolKey ?? context?.quotaPoolKey ?? inferPoolForPlatform(platform, opts.modelId ?? context?.modelId),
    endpoint: opts.endpoint ?? context?.endpoint ?? null,
  };
}

function maybeAddObservation(
  observations: QuotaObservationInput[],
  base: NonNullable<ReturnType<typeof extractContext>>,
  metric: QuotaMetric,
  limitRaw: string | null,
  remainingRaw: string | null | undefined,
  resetRaw: string | null | undefined,
  strategy: QuotaResetStrategy,
): void {
  const limit = parseHeaderNumber(limitRaw);
  const remaining = parseHeaderNumber(remainingRaw ?? null);
  const resetAt = parseResetAtFromHeader(resetRaw ?? null);
  if (limit === null && remaining === null && resetAt === null) return;
  observations.push({
    ...base,
    metric,
    limit,
    remaining,
    resetAt,
    resetStrategy: strategy,
    source: 'header',
    confidence: 1,
  });
}

export function inferQuotaPoolKey(platform: Platform, modelId?: string | null): string {
  return inferPoolForPlatform(platform, modelId);
}

export function parseQuotaObservationsFromResponse(
  response: Response,
  opts: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'> = {},
): QuotaObservationInput[] {
  const base = extractContext(opts);
  if (!base) return [];

  const headers = response.headers;
  const get = (name: string) => headers?.get?.(name) ?? null;
  const observations: QuotaObservationInput[] = [];
  const specs = HEADER_SPECS[base.platform];
  if (specs) {
    for (const spec of specs) {
      maybeAddObservation(observations, base, spec.metric, get(spec.limit), spec.remaining ? get(spec.remaining) : null, spec.reset ? get(spec.reset) : null, spec.strategy ?? 'provider_reported');
    }
  }

  const retryAfterMs = parseRetryAfterMs(get('retry-after')) ?? null;
  if (retryAfterMs !== null) {
    observations.push({
      ...base,
      metric: 'requests',
      limit: parseHeaderNumber(get('x-ratelimit-limit-requests')),
      remaining: 0,
      resetAt: new Date(Date.now() + retryAfterMs).toISOString(),
      retryAfterMs,
      resetStrategy: 'provider_reported',
      source: response.status === 429 ? 'header' : 'error_body',
      confidence: response.status === 429 ? 1 : 0.8,
      notes: `retry-after=${retryAfterMs}ms`,
    });
  }

  if (response.status === 429 || response.status === 402) {
    observations.push({
      ...base,
      metric: 'requests',
      limit: parseHeaderNumber(get('x-ratelimit-limit-requests')),
      remaining: 0,
      resetAt: get('x-ratelimit-reset-requests') ? parseResetAtFromHeader(get('x-ratelimit-reset-requests')) : null,
      retryAfterMs,
      resetStrategy: 'unknown',
      source: 'error_body',
      confidence: 0.55,
      notes: response.status === 402 ? 'upstream payment/credit exhaustion' : 'rate limited',
    });
  }

  if (observations.length === 0 && isSharedPool(base.platform) && response.status === 200) {
    observations.push({
      ...base,
      metric: 'requests',
      limit: null,
      remaining: null,
      resetAt: null,
      resetStrategy: 'unknown',
      source: 'probe',
      confidence: 0.1,
      notes: 'no quota headers exposed',
    });
  }

  return observations;
}

export function recordQuotaObservation(input: QuotaObservationInput): ProviderQuotaObservation | null {
  const context = getQuotaObservationContext();
  const platform = input.platform ?? context?.platform;
  if (!platform) return null;

  const keyId = input.keyId ?? context?.keyId ?? 0;
  const quotaPoolKey = input.quotaPoolKey ?? context?.quotaPoolKey ?? inferPoolForPlatform(platform, input.modelId ?? context?.modelId);
  const metric = input.metric ?? 'requests';
  const source = input.source ?? 'probe';
  const resetStrategy = input.resetStrategy ?? 'unknown';
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE[source];
  const observedAt = input.observedAt ?? isoNow();
  const limitValue = input.limit ?? null;
  const remainingValue = input.remaining ?? null;
  const resetAt = input.resetAt ?? null;
  const retryAfterMs = input.retryAfterMs ?? null;
  const notes = input.notes ?? null;
  const providerAccountId = input.providerAccountId ?? context?.providerAccountId ?? null;
  const modelId = input.modelId ?? context?.modelId ?? null;
  const endpoint = input.endpoint ?? context?.endpoint ?? null;
  const statusCode = input.statusCode ?? null;
  const rawJson = input.rawJson ?? null;
  let db;
  try {
    db = getDb();
  } catch {
    return null;
  }
  const id = crypto.randomUUID();
  const nowSql = toSqliteUtc(observedAt);
  const updatedAt = nowSql;

  const prev = db.prepare(`
    SELECT confidence, notes, source
      FROM provider_quota_state
     WHERE platform = ?
       AND key_id = ?
       AND quota_pool_key = ?
       AND metric = ?
  `).get(platform, keyId, quotaPoolKey, metric) as { confidence: number; notes: string | null; source: QuotaObservationSource } | undefined;

  const nextConfidence = Math.max(prev?.confidence ?? 0, confidence);
  const nextNotes = notes ?? prev?.notes ?? null;
  const nextSource = pickBetterSource(prev?.source, source);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_quota_state (
        platform, key_id, quota_pool_key, metric, limit_value, remaining_value,
        reset_at, reset_strategy, source, confidence, notes, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, key_id, quota_pool_key, metric) DO UPDATE SET
        limit_value = COALESCE(excluded.limit_value, provider_quota_state.limit_value),
        remaining_value = COALESCE(excluded.remaining_value, provider_quota_state.remaining_value),
        reset_at = COALESCE(excluded.reset_at, provider_quota_state.reset_at),
        reset_strategy = CASE
          WHEN excluded.reset_strategy != 'unknown' THEN excluded.reset_strategy
          ELSE provider_quota_state.reset_strategy
        END,
        confidence = MAX(provider_quota_state.confidence, excluded.confidence),
        notes = COALESCE(excluded.notes, provider_quota_state.notes),
        observed_at = excluded.observed_at,
        updated_at = datetime('now')
    `).run(
      platform, keyId, quotaPoolKey, metric, limitValue, remainingValue, resetAt, resetStrategy, source, nextConfidence, nextNotes, nowSql, updatedAt,
    );

    db.prepare(`
      UPDATE provider_quota_state
         SET source = ?
       WHERE platform = ?
         AND key_id = ?
         AND quota_pool_key = ?
         AND metric = ?
    `).run(nextSource, platform, keyId, quotaPoolKey, metric);

    db.prepare(`
      INSERT INTO provider_quota_observations (
        id, platform, key_id, provider_account_id, model_id, quota_pool_key, metric,
        status_code, limit_value, remaining_value, reset_at, retry_after_ms,
        reset_strategy, source, confidence, notes, raw_json, endpoint, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, platform, keyId, providerAccountId, modelId, quotaPoolKey, metric,
      statusCode, limitValue, remainingValue, resetAt, retryAfterMs,
      resetStrategy, source, confidence, notes, rawJson, endpoint, nowSql, nowSql,
    );
  })();

  // The row just moved, so the memoised headroom for this platform is wrong —
  // drop it rather than let a 5s window hide a fresh 429 from the router.
  invalidateKeyQuotaHeadroom(platform);

  return {
    id,
    platform,
    keyId,
    providerAccountId,
    modelId,
    quotaPoolKey,
    metric,
    statusCode,
    limit: limitValue,
    remaining: remainingValue,
    resetAt,
    retryAfterMs,
    resetStrategy,
    source,
    confidence: nextConfidence,
    notes: nextNotes,
    observedAt: nowSql,
    updatedAt,
    endpoint,
    rawJson,
    createdAt: nowSql,
  };
}

export function recordQuotaObservationsFromResponse(
  response: Response,
  opts: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'> = {},
): ProviderQuotaObservation[] {
  return parseQuotaObservationsFromResponse(response, opts)
    .map(recordQuotaObservation)
    .filter((row): row is ProviderQuotaObservation => row !== null);
}

// A quota window whose reset_at has passed has replenished at the provider, but
// remaining_value is only ever written on a fresh observation — so a key that hit
// remaining=0 reads as "exhausted" forever on the dashboard health view until the
// next live call (#453). Restore remaining to the known limit (or clear it to
// unknown when the limit isn't known — `= limit_value` yields NULL in that case)
// and drop the stale reset_at so the row stops reading as exhausted and this
// fix-up doesn't recur. Runs on read; a new observation re-populates reset_at.
function normalizeExpiredQuotaState(db: ReturnType<typeof getDb>): void {
  db.prepare(`
    UPDATE provider_quota_state
       SET remaining_value = limit_value,
           reset_at = NULL,
           updated_at = datetime('now')
     WHERE reset_at IS NOT NULL
       AND julianday(reset_at) < julianday('now')
  `).run();
}

// ── Per-key headroom (routing signal) ───────────────────────────────────────
// getQuotaStateForKeys is a panel query: it takes a write (the expiry fix-up)
// and window-functions the whole observation log. The router needs a far
// smaller answer — "how much of its budget does each key of ONE platform have
// left" — on a path that runs per chain entry per request, so it gets its own
// read-only, platform-filtered query behind a short TTL.

/** Confidence floor for letting an observation steer routing. Keeps headers,
 *  quota APIs and 429 bodies in; leaves local estimates and probes out. */
const HEADROOM_MIN_CONFIDENCE = 0.7;
/** Quota moves on the timescale of a rate-limit window, not a request, so a
 *  few seconds of staleness is invisible while the query count drops to ~one
 *  per platform per burst. Writes bust the entry outright (see below). */
const HEADROOM_TTL_MS = 5_000;

// The Db handle is part of the cache identity: reconnecting (tests, a restore)
// hands back a different object, which invalidates every entry at once.
const headroomCache = new Map<string, { db: unknown; at: number; map: Map<number, number> }>();

/**
 * Fraction of the observed budget still available for each key of `platform`,
 * as keyId → 0..1, where 1 is untouched and 0 exhausted. Keys with no usable
 * observation are simply absent — that is not the same as "empty", and callers
 * must treat a miss as unknown rather than as zero headroom.
 *
 * A key metered on several metrics takes the WORST of them: the binding
 * constraint is what 429s, so a key with 90% of its requests but 2% of its
 * tokens left has 2% of headroom, not 90%.
 */
export function getKeyQuotaHeadroom(platform: Platform): Map<number, number> {
  let db;
  try {
    db = getDb();
  } catch {
    return new Map();
  }
  const now = Date.now();
  const cached = headroomCache.get(platform);
  if (cached && cached.db === db && now - cached.at < HEADROOM_TTL_MS) return cached.map;

  const rows = db.prepare(`
    SELECT key_id AS keyId,
           limit_value AS limitValue,
           remaining_value AS remainingValue,
           CASE WHEN reset_at IS NOT NULL AND julianday(reset_at) < julianday('now')
                THEN 1 ELSE 0 END AS expired
      FROM provider_quota_state
     WHERE platform = ?
       AND confidence >= ?
       AND limit_value IS NOT NULL
       AND limit_value > 0
       AND remaining_value IS NOT NULL
  `).all(platform, HEADROOM_MIN_CONFIDENCE) as {
    keyId: number; limitValue: number; remainingValue: number; expired: number;
  }[];

  const map = new Map<number, number>();
  for (const row of rows) {
    // A window that already reset is a full budget again. Same rule as
    // normalizeExpiredQuotaState, minus the write — this path must not take
    // one just to answer a routing question.
    const ratio = row.expired
      ? 1
      : Math.max(0, Math.min(1, row.remainingValue / row.limitValue));
    const prev = map.get(row.keyId);
    if (prev === undefined || ratio < prev) map.set(row.keyId, ratio);
  }
  headroomCache.set(platform, { db, at: now, map });
  return map;
}

/** Drop the memoised headroom for one platform (or all of them). Called on
 *  every write so a fresh observation is visible to the very next route. */
export function invalidateKeyQuotaHeadroom(platform?: Platform): void {
  if (platform) headroomCache.delete(platform);
  else headroomCache.clear();
}

export function getQuotaStateForKeys(): QuotaObservationView[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  normalizeExpiredQuotaState(db);
  // One seek per state row for its newest observation. The log is append-only
  // and grows into the hundreds of thousands of rows, so this must never scan
  // it: the correlated subquery walks idx_provider_quota_observations_latest
  // (platform, key_id, quota_pool_key, metric, observed_at DESC, created_at
  // DESC) and stops at the first entry. The window-function form it replaces
  // ranked the entire table, raw_json included, on every dashboard poll.
  return db.prepare(`
    SELECT
      pqs.platform,
      pqs.key_id AS keyId,
      -- The panel identifies a row by its key. A bare "key #7" says nothing, so
      -- carry the operator's own name for it (#705).
      k.label AS keyLabel,
      pqs.quota_pool_key AS quotaPoolKey,
      pqs.metric,
      pqs.limit_value AS "limit",
      pqs.remaining_value AS remaining,
      pqs.reset_at AS resetAt,
      pqs.reset_strategy AS resetStrategy,
      pqs.source,
      pqs.confidence,
      pqs.notes,
      pqs.observed_at AS observedAt,
      pqs.updated_at AS updatedAt,
      NULL AS providerAccountId,
      latest.model_id AS modelId,
      latest.endpoint AS endpoint,
      latest.status_code AS statusCode,
      latest.retry_after_ms AS retryAfterMs,
      latest.raw_json AS rawJson,
      latest.created_at AS createdAt
    FROM provider_quota_state pqs
    LEFT JOIN api_keys k ON k.id = pqs.key_id
    LEFT JOIN provider_quota_observations latest
      ON latest.id = (
        SELECT o.id
          FROM provider_quota_observations o
         WHERE o.platform = pqs.platform
           AND o.key_id = pqs.key_id
           AND o.quota_pool_key = pqs.quota_pool_key
           AND o.metric = pqs.metric
         ORDER BY o.observed_at DESC, o.created_at DESC
         LIMIT 1
      )
    ORDER BY pqs.platform ASC, pqs.key_id ASC, pqs.quota_pool_key ASC, pqs.metric ASC
  `).all() as QuotaObservationView[];
}
