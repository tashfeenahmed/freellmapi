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
  if (!raw?.trim()) return null;
  const value = raw.trim();
  let milliseconds: number;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    milliseconds = parsed > 1_000_000_000_000 ? parsed
      : parsed > 1_000_000_000 ? parsed * 1000 : now + parsed * 1000;
  } else if (/^(?:\d+(?:\.\d+)?(?:ms|[dhms]))+$/.test(value)) {
    // Groq reports durations such as 2m59.56s, not numeric seconds.
    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
    milliseconds = now;
    for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g)) {
      milliseconds += Number(part[1]) * units[part[2]];
    }
  } else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    milliseconds = Date.parse(value);
  } else return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function inferPoolForPlatform(platform: Platform, modelId?: string | null): string {
  const normalizedModelId = modelId?.trim() ?? '';
  if (platform === 'openrouter') return normalizedModelId.endsWith(':free') ? 'openrouter::free' : 'openrouter::account';
  if (platform === 'google') return 'google::project';
  if (platform === 'groq') return 'groq::account';
  if (platform === 'cerebras') return 'cerebras::shared';
  if (platform === 'sail') return 'sail::monthly-credit';
  if (platform === 'aclide') return 'aclide::monthly-credit';
  if (platform === 'electronhub') return normalizedModelId.endsWith(':free') ? 'electronhub::daily-free' : 'electronhub::weekly-credit';
  if (platform === 'experiential') return 'experiential::monthly-credit';
  if (platform === 'router9') return 'router9::monthly-credit';
  if (platform === 'septor') return 'septor::daily-free';
  if (platform === 'clod') return 'clod::daily-free';
  if (platform === 'speechify') return 'speechify::monthly-characters';
  if (platform === 'blaze') return 'blaze::daily-free';
  if (platform === 'lucidity') return 'lucidity::daily-free';
  if (platform === 'airforce') return 'airforce::daily-free';
  if (platform === 'dreamprompting') return 'dreamprompting::daily-free';
  if (platform === 'waterfall') return 'waterfall::community-free';
  if (platform === 'logfare') return 'logfare::fair-use';
  if (platform === 'bai') return 'bai::promo';
  if (platform === 'radeon') return 'radeon::daily-free';
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
  if (platform === 'aclide') return true;
  if (['electronhub', 'experiential', 'router9', 'septor', 'clod', 'speechify', 'blaze', 'lucidity', 'airforce', 'dreamprompting', 'waterfall', 'logfare'].includes(platform)) return true;
  return ['openrouter', 'google', 'groq', 'cerebras', 'sail', 'bai', 'radeon', 'sambanova', 'nvidia', 'mistral', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'routeway', 'bazaarlink', 'ainative', 'aion', 'requesty', 'navy', 'nara', 'sealion', 'orcarouter', 'unorouter', 'xkiro', 'anyapi', 'modelscope', 'aihorde'].includes(platform);
}

type HeaderSpec = { metric: QuotaMetric; limit: string; remaining?: string; reset?: string; strategy?: QuotaResetStrategy };

const HEADER_SPECS: Partial<Record<Platform, HeaderSpec[]>> = {
  // Observe upstream limits without inventing per-model budgets. CLōD's
  // rate window is distinct from its daily grant; Speechify bills characters,
  // not tokens, and does not publish token headers.
  clod: [
    { metric: 'requests', limit: 'x-ratelimit-limit', remaining: 'x-ratelimit-remaining', reset: 'x-ratelimit-reset', strategy: 'provider_reported' },
  ],
  blaze: [
    { metric: 'tokens', limit: 'x-ratelimit-limit-tokens', remaining: 'x-ratelimit-remaining-tokens', strategy: 'provider_reported' },
  ],
  // Observe actual headers only: Router9's documented request windows differ
  // from live headers. No invented per-model quotas or credit-to-token math.
  router9: [
    { metric: 'credits', limit: 'x-credits-limit', remaining: 'x-credits-remaining', reset: 'x-credits-reset', strategy: 'provider_reported' },
  ],
  septor: [
    { metric: 'requests', limit: 'x-ratelimit-limit', remaining: 'x-ratelimit-remaining', reset: 'x-ratelimit-reset', strategy: 'provider_reported' },
  ],
  // Live-observed account-wide rolling-minute headers; no invented limits or
  // conversion of credit grants into token budgets.
  electronhub: [
    { metric: 'requests', limit: 'x-ratelimit-limit', remaining: 'x-ratelimit-remaining', reset: 'x-ratelimit-reset', strategy: 'provider_reported' },
  ],
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
  radeon: [
    { metric: 'requests', limit: 'x-ratelimit-limit-user-rpm', remaining: 'x-ratelimit-remaining-user-rpm', reset: 'x-ratelimit-reset', strategy: 'provider_reported' },
    { metric: 'credits', limit: 'x-ratelimit-limit-user-daily-usd', remaining: 'x-ratelimit-remaining-user-daily-usd', reset: 'x-ratelimit-reset-user-daily-usd', strategy: 'provider_reported' },
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

  // Other compatible providers can expose these explicit request/token headers.
  // Only use the fallback when the provider-specific mapping found no such metric.
  for (const metric of ['requests', 'tokens'] as const) {
    if (!observations.some(row => row.metric === metric)) {
      maybeAddObservation(observations, base, metric, get(`x-ratelimit-limit-${metric}`),
        get(`x-ratelimit-remaining-${metric}`), get(`x-ratelimit-reset-${metric}`), 'provider_reported');
    }
  }

  const retryAfterMs = parseRetryAfterMs(get('retry-after')) ?? null;
  if ((response.status === 429 || response.status === 402)
      && !observations.some(row => row.metric === 'requests' && row.remaining != null)) {
    // A cooldown alone is not proof of an exhausted daily request allowance.
    // Keep it as lower-confidence error evidence; do not overwrite quota headers.
    observations.push({
      ...base,
      metric: 'requests',
      limit: null,
      remaining: 0,
      resetAt: retryAfterMs == null ? null : new Date(Date.now() + retryAfterMs).toISOString(),
      retryAfterMs,
      resetStrategy: 'unknown',
      source: 'error_body',
      confidence: 0.55,
      notes: response.status === 402 ? 'upstream payment/credit exhaustion' : 'rate limited',
    });
  }
  for (const observation of observations) {
    observation.statusCode = response.status;
    observation.retryAfterMs = retryAfterMs;
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

  db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_quota_state (
        platform, key_id, quota_pool_key, metric, limit_value, remaining_value,
        reset_at, reset_strategy, source, confidence, notes, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, key_id, quota_pool_key, metric) DO UPDATE SET
        limit_value = excluded.limit_value,
        remaining_value = excluded.remaining_value,
        reset_at = excluded.reset_at,
        reset_strategy = excluded.reset_strategy,
        source = excluded.source,
        confidence = excluded.confidence,
        notes = excluded.notes,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
      -- Keep a coherent balance snapshot. Empty/limit-only probes must not
      -- make an older balance, reset or confidence appear freshly measured.
      WHERE excluded.remaining_value IS NOT NULL
        AND (provider_quota_state.remaining_value IS NULL
          OR julianday(excluded.observed_at) >= julianday(provider_quota_state.observed_at))
    `).run(
      platform, keyId, quotaPoolKey, metric, limitValue, remainingValue, resetAt, resetStrategy, source, confidence, notes, nowSql, updatedAt,
    );

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
    confidence,
    notes,
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

// The router needs a smaller view than the panel's joined observation rows:
// a read-only, platform-filtered headroom query behind a short TTL. Expired
// windows replenish the routing estimate, while the original balance remains
// stored for presentation as a last reported observation.

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
    // the panel headroom view, without writes — this path must not take
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

export function getQuotaStateForKeys(options: { normalizeExpired?: boolean } = {}): QuotaObservationView[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  // One seek per state row for its newest observation. The log is append-only
  // and grows into the hundreds of thousands of rows, so this must never scan
  // it: the correlated subquery walks idx_provider_quota_observations_latest
  // (platform, key_id, quota_pool_key, metric, observed_at DESC, created_at
  // DESC) and stops at the first entry. The window-function form it replaces
  // ranked the entire table, raw_json included, on every dashboard poll.
  const rows = db.prepare(`
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
  if (options.normalizeExpired === false) return rows;
  // Legacy callers can still display replenished headroom, but never overwrite
  // the actual observation: the outlook must retain its age and reported value.
  const now = Date.now();
  return rows.map(row => {
    const resetAt = row.resetAt?.includes('T') ? row.resetAt : row.resetAt?.replace(' ', 'T') + 'Z';
    return row.resetAt && Date.parse(resetAt) < now
      ? { ...row, remaining: row.limit, resetAt: null } : row;
  });
}
