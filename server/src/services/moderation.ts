/**
 * Moderation service — proxy /v1/moderations requests to providers that
 * expose OpenAI-compatible moderation endpoints.
 *
 * Supported platforms (first key per platform wins):
 *   - openai        → https://api.openai.com/v1/moderations
 *   - openrouter    → https://openrouter.ai/api/v1/moderations
 *   - nvidia        → https://integrate.api.nvidia.com/v1/moderations
 *
 * The failover walks the first available key for each platform in order.
 * No separate `moderation_models` table is needed for v1 — the set of
 * platforms is small and the endpoint is always /v1/moderations.
 */
import { getDb } from '../db/index.js';
import { logRequest } from '../lib/request-log.js';
import { decrypt } from '../lib/crypto.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { proxyFetch } from '../lib/proxy.js';
import { USABLE_KEY_SQL } from './key-state.js';
import { runFailoverChain } from '../lib/failover-chain.js';
import { checkMonthlyBudget, secondsUntilNextMonth } from './key-budget.js';
import { markKeyHealthyFromRequest } from './health.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ModerationModelRow {
  platform: string;
  modelId: string;
  baseUrl: string;
  keyId: number;
  encryptedKey: string;
  iv: string;
  authTag: string;
}

export interface ModerationResult {
  provider: string;
  model: string;
  result: Record<string, unknown>;
}

export class ModerationError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  /** Seconds the caller should wait before retrying (429 exhaustion). */
  retryAfterSec?: number;
  // Same shape as the other failover-chain errors (lib/failover-chain.ts).
  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.retryAfterSec = retryAfterMs === undefined ? undefined : retryAfterMs / 1000;
  }
}

/* ------------------------------------------------------------------ */
/*  Provider registry (hardcoded for v1)                               */
/* ------------------------------------------------------------------ */

interface ModerationEndpoint {
  baseUrl: string;
  modelId: string;
}

const MODERATION_MODELS: Record<string, ModerationEndpoint> = {
  openai:     { baseUrl: 'https://api.openai.com',     modelId: 'omni-moderation-latest' },
  openrouter: { baseUrl: 'https://openrouter.ai/api',  modelId: 'openai/omni-moderation-latest' },
  nvidia:     { baseUrl: 'https://integrate.api.nvidia.com', modelId: 'nvidia/llama-3.1-nemoguard-8b-content-safety' },
};

const PLATFORM_ORDER = ['openai', 'openrouter', 'nvidia'] as const;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function listModerationModels(): ModerationModelRow[] {
  const db = getDb();
  const rows: ModerationModelRow[] = [];
  for (const platform of PLATFORM_ORDER) {
    const ep = MODERATION_MODELS[platform];
    const keys = db.prepare(`
      SELECT id, encrypted_key, iv, auth_tag, model_scope_json
        FROM api_keys
       WHERE platform = ?
         AND ${USABLE_KEY_SQL}
       ORDER BY id
    `).all(platform) as { id: number; encrypted_key: string; iv: string; auth_tag: string; model_scope_json: string | null }[];
    // Per-key model scope (#657): a relay key scoped to a chat model group must
    // never be picked to serve the moderation model — the same wall the chat
    // router and search pools honour. Walk the platform's keys in the old
    // first-key order and take the first one the scope admits.
    const key = keys.find(k => scopeAllows(parseModelScope(k.model_scope_json), ep.modelId));
    if (key) {
      rows.push({
        platform,
        modelId: ep.modelId,
        baseUrl: ep.baseUrl,
        keyId: key.id,
        encryptedKey: key.encrypted_key,
        iv: key.iv,
        authTag: key.auth_tag,
      });
    }
  }
  return rows;
}

function getDefaultModel(): string | null {
  const models = listModerationModels();
  return models.length > 0 ? models[0].modelId : null;
}

export function resolveModel(requestedModel: string | undefined): string | null {
  if (!requestedModel || requestedModel === 'text-moderation-stable' || requestedModel === 'text-moderation-latest') {
    return getDefaultModel();
  }
  const models = listModerationModels();
  const match = models.find(m => m.modelId === requestedModel);
  return match ? match.modelId : getDefaultModel();
}

/* ------------------------------------------------------------------ */
/*  Provider call                                                      */
/* ------------------------------------------------------------------ */

async function callProvider(
  row: ModerationModelRow,
  apiKey: string,
  inputs: string[],
  clientSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(30_000);
  const url = `${row.baseUrl}/v1/moderations`;
  const res = await proxyFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: row.modelId, input: inputs.length === 1 ? inputs[0] : inputs }),
    signal: clientSignal ? AbortSignal.any([timeout, clientSignal]) : timeout,
  }, row.platform, 'moderation');

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ModerationError(`moderation provider ${row.platform} returned ${res.status}: ${body.slice(0, 200)}`, res.status);
  }

  const json = await res.json() as Record<string, unknown>;
  if (!json.results || !Array.isArray(json.results)) {
    throw new ModerationError('upstream returned malformed moderation response', 502);
  }
  return json;
}

/* ------------------------------------------------------------------ */
/*  Logging                                                            */
/* ------------------------------------------------------------------ */

function logModerationRequest(
  row: ModerationModelRow,
  status: 'success' | 'error' | 'canceled',
  latencyMs: number,
  error: string | null,
): void {
  // Through logRequest so the row also reaches request_hourly and the lifetime
  // totals; it swallows its own DB errors.
  logRequest(row.platform, row.modelId, row.keyId, status, 0, 0, latencyMs, error,
    null, null, null, null, null, 'moderation');
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

export async function runModerations(
  model: string | undefined,
  inputs: string[],
  clientSignal?: AbortSignal,
): Promise<ModerationResult> {
  const resolved = resolveModel(model);
  if (!resolved) {
    throw new ModerationError(
      'No moderation providers available. Add an OpenAI, OpenRouter, or NVIDIA API key.',
      503,
    );
  }

  const models = listModerationModels();
  // A default/legacy request walks EVERY available platform in order — each
  // provider calls its own catalog model, which is what makes the cross-
  // platform failover below real (OpenRouter's omni-moderation id carries an
  // `openai/` prefix, so an exact-modelId filter would silently drop it).
  // An explicit model narrows the chain to the platform(s) exposing it.
  const isDefaultRequest = !model
    || model === 'text-moderation-stable'
    || model === 'text-moderation-latest';
  const chain = isDefaultRequest
    ? models
    : models.filter(m => m.modelId === resolved);
  if (chain.length === 0) {
    throw new ModerationError(`No enabled providers for moderation model '${resolved}'.`, 503);
  }

  // #1158: a moderation call spends real provider quota, so a key at its
  // monthly cap must not serve one. Every other inference surface checks the
  // caps before dispatch (router, embeddings, media, search). A capped key is
  // reported after the chain with the month-reset Retry-After.
  let budgetBlocked = false;
  const res = await runFailoverChain({
    rows: chain,
    signal: clientSignal,
    ErrorClass: ModerationError,
    route: row => ({ platform: row.platform, modelId: row.modelId }),
    reserve: (row, skip) => {
      if (skip(row.keyId)) return { credential: null, budgetBlocked: false };
      let key: string;
      try {
        key = decrypt(row.encryptedKey, row.iv, row.authTag);
      } catch {
        return { credential: null, budgetBlocked: false };
      }
      if (!checkMonthlyBudget(row.keyId, 0).allowed) {
        budgetBlocked = true;
        return { credential: null, budgetBlocked: false };
      }
      return { credential: { id: row.keyId, key }, budgetBlocked: false };
    },
    attempt: (row, credential) => callProvider(row, credential.key, inputs, clientSignal),
    log: (row, _keyId, o) => {
      // A served moderation is the evidence the key works, the same as a
      // served chat request (#1493): it stamps last_healthy_at and lifts an
      // 'unknown' or 'error' key.
      if (o.kind === 'success') markKeyHealthyFromRequest(row.keyId);
      logModerationRequest(row, o.kind, o.latencyMs, o.kind === 'error' ? o.error.message.slice(0, 300) : null);
    },
  });
  if (res.ok) {
    return {
      provider: res.row.platform,
      model: (res.out.model as string) ?? res.row.modelId,
      result: res.out,
    };
  }

  const { lastError } = res;
  // A monthly-cap exhaustion outranks a transport failure in the reply: the
  // caller needs the month-reset Retry-After, not a "try another provider" 502.
  if (budgetBlocked && (!lastError || lastError.status === 429)) {
    const exhausted = new ModerationError(
      'Monthly key budget exhausted.',
      429,
      'quota_exceeded',
      secondsUntilNextMonth() * 1000,
    );
    throw exhausted;
  }

  throw new ModerationError(
    `All moderation providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && lastError.status === 429 ? 429 : 502,
    lastError?.code,
    lastError?.retryAfterMs,
  );
}
