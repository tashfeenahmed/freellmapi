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
import { getClientContext } from '../lib/client-context.js';
import { decrypt } from '../lib/crypto.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { proxyFetch } from '../lib/proxy.js';
import { checkMonthlyBudget, secondsUntilNextMonth } from './key-budget.js';
import { noteBudgetAlerts } from './budget-alerts.js';
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
  /** Seconds the caller should wait before retrying (429 exhaustion). */
  retryAfterSec?: number;
  constructor(message: string, status: number, retryAfterSec?: number) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
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
         AND enabled = 1
         AND status IN ('healthy', 'unknown')
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
): Promise<Record<string, unknown>> {
  const url = `${row.baseUrl}/v1/moderations`;
  const res = await proxyFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: row.modelId, input: inputs.length === 1 ? inputs[0] : inputs }),
    signal: AbortSignal.timeout(30_000),
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
  status: 'success' | 'error',
  latencyMs: number,
  error: string | null,
): void {
  try {
    const client = getClientContext();
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, client_ip, client_user_agent, client_agent)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'moderation', ?, ?, ?)
    `).run(row.platform, row.modelId, row.keyId, status, latencyMs, error, client.ip, client.userAgent, client.agent);
    // Soft budget alert (#1158 follow-on): the ledger trigger fired with this
    // row, so compare the caps once. No-op for uncapped keys.
    if (status === 'success' && row.keyId != null) noteBudgetAlerts(row.keyId);
  } catch (e) {
    console.error('Failed to log moderation request:', e);
  }
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

export async function runModerations(
  model: string | undefined,
  inputs: string[],
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

  let lastError: ModerationError | null = null;
  // #1158: a moderation call spends real provider quota, so a key at its
  // monthly cap must not serve one. Every other inference surface checks the
  // caps before dispatch (router, embeddings, media, search); moderation was
  // the only one that read api_keys directly and skipped the gate.
  let budgetBlocked = false;
  for (const row of chain) {
    let apiKey: string;
    try {
      apiKey = decrypt(row.encryptedKey, row.iv, row.authTag);
    } catch {
      continue;
    }
    if (!checkMonthlyBudget(row.keyId, 0).allowed) {
      budgetBlocked = true;
      continue;
    }
    const started = Date.now();
    try {
      const json = await callProvider(row, apiKey, inputs);
      logModerationRequest(row, 'success', Date.now() - started, null);
      // A served moderation is the evidence the key works, the same as a
      // served chat request (#1493): it stamps last_healthy_at and lifts an
      // 'unknown' or 'error' key.
      markKeyHealthyFromRequest(row.keyId);
      return {
        provider: row.platform,
        model: (json.model as string) ?? row.modelId,
        result: json,
      };
    } catch (err: any) {
      const e = err instanceof ModerationError ? err : new ModerationError(String(err?.message ?? err), 502);
      logModerationRequest(row, 'error', Date.now() - started, e.message.slice(0, 300));
      lastError = e;
    }
  }

  // A monthly-cap exhaustion outranks a transport failure in the reply: the
  // caller needs the month-reset Retry-After, not a "try another provider" 502.
  if (budgetBlocked && (!lastError || lastError.status === 429)) {
    const exhausted = new ModerationError(
      'Monthly key budget exhausted.',
      429,
      secondsUntilNextMonth(),
    );
    throw exhausted;
  }

  throw new ModerationError(
    `All moderation providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && lastError.status === 429 ? 429 : 502,
    lastError?.retryAfterSec,
  );
}
