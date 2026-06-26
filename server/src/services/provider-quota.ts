import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../db/index.js';
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

function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const asDate = new Date(raw);
  const ms = asDate.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, ms - Date.now());
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
  if (platform === 'sambanova') return 'sambanova::shared';
  if (platform === 'nvidia') return 'nvidia::credit-pool';
  if (platform === 'mistral') return 'mistral::experiment-pool';
  if (platform === 'github') return 'github::account';
  if (platform === 'cohere') return 'cohere::trial-pool';
  if (platform === 'cloudflare') return 'cloudflare::account';
  if (platform === 'zhipu') return 'zhipu::account';
  if (platform === 'ollama') return 'ollama::cloud';
  if (platform === 'kilo') return 'kilo::anonymous';
  if (platform === 'pollinations') return 'pollinations::anonymous';
  if (platform === 'llm7') return 'llm7::anonymous';
  if (platform === 'huggingface') return 'huggingface::router';
  if (platform === 'opencode') return 'opencode::promo';
  // Aggregators with a single shared free pool across all ':free'/'auto:free' models.
  if (platform === 'routeway') return 'routeway::free';
  if (platform === 'bazaarlink') return 'bazaarlink::free';
  if (platform === 'ainative') return 'ainative::account';
  return normalizedModelId ? `${platform}::${normalizedModelId}` : `${platform}::account`;
}

function isSharedPool(platform: Platform): boolean {
  return ['openrouter', 'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama', 'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'routeway', 'bazaarlink', 'ainative'].includes(platform);
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

  const retryAfterMs = parseRetryAfterMs(get('retry-after'));
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

export function getQuotaStateForKeys(): QuotaObservationView[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  return db.prepare(`
    WITH latest AS (
      SELECT
        oq.*,
        ROW_NUMBER() OVER (
          PARTITION BY oq.platform, oq.key_id, oq.quota_pool_key, oq.metric
          ORDER BY oq.observed_at DESC, oq.created_at DESC
        ) AS rn
      FROM provider_quota_observations oq
    )
    SELECT
      pqs.platform,
      pqs.key_id AS keyId,
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
    LEFT JOIN latest
      ON latest.platform = pqs.platform
     AND latest.key_id = pqs.key_id
     AND latest.quota_pool_key = pqs.quota_pool_key
     AND latest.metric = pqs.metric
     AND latest.rn = 1
    ORDER BY pqs.platform ASC, pqs.key_id ASC, pqs.quota_pool_key ASC, pqs.metric ASC
  `).all() as QuotaObservationView[];
}
