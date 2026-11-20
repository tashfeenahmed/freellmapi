// Embeddings routing. Unlike chat, embeddings can NOT fail over across models:
// vectors from different models live in incompatible spaces, and silently
// switching models would corrupt any vector store built on top of us. So the
// routing unit is a "family" (one model identity + dimension) and failover only
// walks the providers serving that same family.
//
// `model: "auto"` (or empty) routes to the configured default family — so auto
// always works: with one provider it just uses that one, with several it gets
// cross-provider redundancy for free.
import { getDb, getSetting } from '../db/index.js';
import { secondsUntilNextMonth } from './key-budget.js';
import { noteBudgetAlerts } from './budget-alerts.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { RetryHintTracker, retryAfterSeconds } from '../lib/retry-hint.js';
import { getClientContext } from '../lib/client-context.js';
import { reserveProviderCredential } from './provider-credential.js';
import {
  setCooldown, canMakeRequest, canUseTokens, getProviderMinuteRequestCap,
  recordRequest, recordTokens, acquireLease, releaseLease,
} from './ratelimit.js';
import { meterCloudflare, roughTokens } from './cloudflare-neurons.js';
import { proxyFetch } from '../lib/proxy.js';
import { bearerAuthHeader } from '../lib/credential.js';
import { markKeyHealthyFromRequest } from './health.js';
import { customEndpointKeyIds } from './custom-endpoint.js';
import type { Db } from '../db/types.js';
import { SPEKA_BASE_URL } from '../providers/speka.js';
import { ELECTRONHUB_BASE_URL } from '../providers/electronhub.js';
import { INFERBASE_BASE_URL } from '../providers/inferbase.js';
import { LLMTR_BASE_URL } from '../providers/llmtr.js';
import { JAMAI_BASE_URL, jamaiHeaders } from '../providers/jamai.js';
import { FREEINFERENCE_BASE_URL } from '../providers/freeinference.js';
import { FREEAI_BASE_URL } from '../providers/freeai.js';
import { SILVR_BASE_URL } from '../providers/silvr.js';

export interface EmbeddingModelRow {
  id: number;
  family: string;
  platform: string;
  model_id: string;
  display_name: string;
  dimensions: number;
  max_input_tokens: number | null;
  priority: number;
  enabled: number;
  quota_label: string;
  key_id: number | null;
  /** 'query' | 'passage' for a custom model registered against an asymmetric
   *  endpoint (NVIDIA Nemotron 3.5); null means "send no input_type", which is
   *  what every symmetric model wants. */
  input_type: string | null;
  /** Per-model rate-limit windows, mirroring the chat `models` table. NULL
   *  means "no opinion" — the window is not enforced for this row, which is
   *  how every row behaved before the columns existed. */
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

/** The `input_type` hint an asymmetric embedding endpoint needs.
 *
 *  NVIDIA's Nemotron 3.5 family is asymmetric: the "query" side and the
 *  "passage" side live in different vector spaces, and the provider refuses to
 *  guess — a request without `input_type` comes back 400. Symmetric models
 *  (bge-m3, text-embedding-3-*) want no `input_type` at all, so this stays
 *  optional everywhere. */
export type EmbeddingInputType = 'query' | 'passage';

/** Narrow a stored/parsed input_type to the two values the wire contract
 *  defines. The column is TEXT, so a hand-edited row could hold anything; an
 *  unrecognised value is treated as "no opinion" rather than forwarded, since
 *  a bogus input_type is as fatal upstream as a missing one. */
export function asEmbeddingInputType(value: string | null | undefined): EmbeddingInputType | null {
  return value === 'query' || value === 'passage' ? value : null;
}

/**
 * The ledger key an embedding model's rate-limit windows are counted under.
 *
 * `rate_limit_usage` is keyed on (platform, model_id, key_id) and is SHARED by
 * every surface that spends provider quota: chat models (the `models` table)
 * and embedding models (the separate `embedding_models` table) both write into
 * it. Checked against the baseline migration data when this was written: 108
 * chat rows and 10 embedding rows, with ZERO overlap on model_id — neither bare
 * nor within one platform — so no window is shared today, and `platform` in the
 * key keeps ids on different providers apart for free.
 *
 * That is a property of today's DATA, not of the schema. An operator can
 * register one custom endpoint model for chat and for embeddings under the same
 * id on the same key, and a future provider could expose a single model id
 * through both surfaces. Sharing a counter would compare one count against two
 * DIFFERENT limit sets (chat's `models.rpm_limit` and the embedding row's
 * `rpm_limit`), so each surface would be throttled by the other's traffic.
 * Namespacing the embedding side makes that collision impossible rather than
 * merely unlikely.
 *
 * The provider-ACCOUNT gates are deliberately not namespaced: canUseProviderMinute
 * and the provider daily caps count by (platform, key_id) only, so chat and
 * embedding traffic still draw from one account-wide budget — which is exactly
 * why the embeddings path has to record usage at all.
 *
 * Exported so the catalogue/dashboard surfaces read the same key instead of
 * re-deriving it.
 */
export function embeddingRateLimitModelId(modelId: string): string {
  return `embedding:${modelId}`;
}

export interface EmbeddingsResult {
  family: string;
  platform: string;
  modelId: string;
  dimensions: number;
  vectors: number[][];
  inputTokens: number;
}

export class EmbeddingsError extends Error {
  status: number;
  code?: string;
  /** Back-off the upstream provider stated (`Retry-After` header or a
   *  retry-delay field in the error body), in milliseconds. Kept separate from
   *  the message so the route can answer the client with a real Retry-After
   *  instead of a bare 429, the same way the chat router benches keys. */
  retryAfterMs?: number;
  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** EmbeddingsError for a non-OK upstream response: status, truncated body and
 *  any stated back-off read off the `Retry-After` header before the body is
 *  consumed. */
async function upstreamEmbeddingsError(r: Response): Promise<EmbeddingsError> {
  const retryAfterMs = parseRetryAfterMs(r.headers?.get('retry-after') ?? null);
  return new EmbeddingsError(
    `upstream ${r.status}: ${(await r.text()).slice(0, 200)}`,
    r.status,
    undefined,
    retryAfterMs,
  );
}

export function listEmbeddingModels(): EmbeddingModelRow[] {
  return getDb().prepare(
    'SELECT * FROM embedding_models ORDER BY family, priority',
  ).all() as EmbeddingModelRow[];
}

export function getDefaultFamily(): string {
  return getSetting('embeddings_default_family') ?? 'gemini-embedding-001';
}

/** Map the request's `model` to a family: 'auto'/empty → default; a family
 * name → itself; a provider-specific model id → its family. */
export function resolveFamily(model: string | undefined): string | null {
  if (!model || model === 'auto') return getDefaultFamily();
  const rows = listEmbeddingModels();
  if (rows.some(r => r.family === model)) return model;
  const byModelId = rows.find(r => r.model_id === model);
  return byModelId?.family ?? null;
}

interface ProviderCredential {
  id: number;
  key: string;
  baseUrl: string | null;
}

// Rough token estimate when the provider doesn't report usage (~4 chars/token).
function estimateTokens(inputs: string[]): number {
  return Math.ceil(inputs.reduce((n, s) => n + s.length, 0) / 4);
}

const FETCH_TIMEOUT_MS = 30_000;

/** Provider adapters that can safely receive catalog-managed embedding rows. */
export const EMBEDDING_PLATFORMS = new Set([
  'freeinference',
  'jamai',
  'google',
  'nvidia',
  'openrouter',
  'cloudflare',
  'huggingface',
  'cohere',
  'sealion',
  'speka',
  'electronhub',
  'inferbase',
  'llmtr',
  'silvr',
  'freeai',
]);

interface ProviderCallResult {
  vectors: number[][];
  inputTokens: number | null; // provider-reported, when available
}

async function openAiStyleEmbed(
  url: string,
  platform: string,
  key: string,
  modelId: string,
  inputs: string[],
  extra: Record<string, unknown> = {},
  dimensions?: number,
  expectedDimensions?: number,
  timeoutMs = FETCH_TIMEOUT_MS,
  headers?: Record<string, string>,
): Promise<ProviderCallResult> {
  const body: Record<string, unknown> = { model: modelId, input: inputs, ...extra };
  // Some providers (NVIDIA NeMo NIM, Google Gemini Embedding, OpenAI v3) support
  // Matryoshka Representation Learning (MRL) — a smaller output_dim is valid and
  // truncates the vector rather than failing. Others (HuggingFace feature-extraction,
  // Cloudflare BGE) ignore unknown fields silently. We only forward the param when
  // the caller asked for an explicit override, so providers that don't accept it
  // see a request body identical to today.
  if (dimensions !== undefined) body.dimensions = dimensions;
  const r = await proxyFetch(url, {
    method: 'POST',
    // A custom endpoint with auth off holds the `no-key` sentinel: omit the
    // header instead of sending `Bearer no-key` (#1331).
    headers: headers ?? { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
    ...(['jamai', 'silvr'].includes(platform) ? { redirect: 'error' as const } : {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }, platform, 'embedding', timeoutMs);
  if (!r.ok) {
    // JamAI error bodies may echo credential-bearing request headers.
    if (['jamai', 'silvr'].includes(platform)) {
      await r.body?.cancel();
      throw new EmbeddingsError(`${platform} embeddings error (HTTP ${r.status})`, r.status, undefined, parseRetryAfterMs(r.headers.get('retry-after')));
    }
    throw await upstreamEmbeddingsError(r);
  }
  const j = (await r.json()) as {
    model?: string;
    data?: { index?: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const data = [...(Array.isArray(j?.data) ? j.data : [])].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  if (['electronhub', 'inferbase', 'llmtr', 'jamai', 'silvr'].includes(platform) && (
    j?.model !== modelId || data.length !== inputs.length ||
    data.some((d, i) => !d || d.index !== i || !Array.isArray(d.embedding) ||
      d.embedding.length !== (dimensions ?? expectedDimensions) ||
      d.embedding.some(value => typeof value !== 'number' || !Number.isFinite(value)) ||
      platform === 'silvr' && !d.embedding.some(value => value !== 0))
  )) {
    // A successful HTTP response is not enough: wrong model/dimension or
    // malformed vectors would corrupt the caller's embedding family.
    const provider = platform === 'silvr' ? 'SilvR' : platform === 'jamai' ? 'JamAI' : platform === 'electronhub' ? 'ElectronHub' : platform === 'llmtr' ? 'LLMTR' : 'Inferbase';
    throw new EmbeddingsError(`${provider} returned mismatched or malformed embeddings`, 502);
  }
  return {
    vectors: data.map(d => d.embedding),
    inputTokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? null,
  };
}

/** The gateway requests bge-m3 but replies with its canonical BAAI/bge-m3
 * identity. These are the only accepted aliases; never mix embedding spaces. */
async function freeInferenceEmbed(row: EmbeddingModelRow, key: string, inputs: string[], dimensions?: number): Promise<ProviderCallResult> {
  if (!key.trim() || key === 'no-key') throw new EmbeddingsError('FreeInference API key is required', 401);
  if (row.model_id !== 'bge-m3' || row.dimensions !== 1024 || (dimensions !== undefined && dimensions !== 1024)) {
    throw new EmbeddingsError('FreeInference embeddings support only bge-m3 at 1024 dimensions', 400);
  }
  const r = await proxyFetch(`${FREEINFERENCE_BASE_URL}/embeddings`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
    body: JSON.stringify({ model: row.model_id, input: inputs, encoding_format: 'float' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }, row.platform, 'embedding', FETCH_TIMEOUT_MS);
  if (!r.ok) throw new EmbeddingsError(`FreeInference embeddings error (HTTP ${r.status})`, r.status, undefined, parseRetryAfterMs(r.headers.get('retry-after')));
  const j = await r.json().catch(() => null) as {
    model?: string; data?: { index?: number; embedding?: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  } | null;
  if (!j || !['bge-m3', 'BAAI/bge-m3'].includes(j.model ?? '') || !Array.isArray(j.data) ||
      j.data.length !== inputs.length || j.data.some(d => !d || !Number.isInteger(d.index))) {
    throw new EmbeddingsError('FreeInference returned mismatched or malformed embeddings', 502);
  }
  const data = [...j.data].sort((a, b) => a.index! - b.index!);
  if (data.some((d, i) => d.index !== i || !Array.isArray(d.embedding) || d.embedding.length !== 1024 ||
      d.embedding.some(v => typeof v !== 'number' || !Number.isFinite(v)))) {
    throw new EmbeddingsError('FreeInference returned mismatched or malformed embeddings', 502);
  }
  const tokens = j.usage?.prompt_tokens ?? j.usage?.total_tokens;
  return { vectors: data.map(d => d.embedding!), inputTokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : null };
}

/** EmbeddingGemma 2 uses the native input schema, not ai/v1/embeddings.
 * Never fall back to the retired 300M model: its vectors are a different family. */
async function cloudflareEmbeddingGemma2(row: EmbeddingModelRow, accountId: string, token: string, inputs: string[], dimensions?: number): Promise<ProviderCallResult> {
  if (row.dimensions !== 768 || (dimensions !== undefined && dimensions !== 768)) {
    throw new EmbeddingsError('EmbeddingGemma 2 supports 768 dimensions', 400);
  }
  const r = await proxyFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/google/embeddinggemma-2`, {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: inputs }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }, 'cloudflare', 'embedding', FETCH_TIMEOUT_MS);
  if (!r.ok) throw new EmbeddingsError(`Cloudflare embeddings error (HTTP ${r.status})`, r.status, undefined, parseRetryAfterMs(r.headers.get('retry-after')));
  const json = await r.json() as {
    success?: boolean; errors?: unknown[];
    result?: { model?: string; data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
  };
  const data = json.result?.data;
  if (json.success === false || json.errors?.length || json.result?.model !== row.model_id || !Array.isArray(data) || data.length !== inputs.length ||
      data.some(d => !d || !Number.isInteger(d.index))) {
    throw new EmbeddingsError('Cloudflare returned mismatched or malformed embeddings', 502);
  }
  const ordered = [...data].sort((a, b) => a.index! - b.index!);
  if (ordered.some((d, i) => d.index !== i || !Array.isArray(d.embedding) || d.embedding.length !== 768 || d.embedding.some(v => !Number.isFinite(v)))) {
    throw new EmbeddingsError('Cloudflare returned mismatched or malformed embeddings', 502);
  }
  const tokens = json.result?.usage?.prompt_tokens;
  return { vectors: ordered.map(d => d.embedding!), inputTokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : null };
}

/** Probe a custom endpoint for its vector width.
 *
 *  `inputType` is forwarded verbatim: an asymmetric endpoint (NVIDIA Nemotron
 *  3.5) rejects a probe that carries no `input_type` with 400, so the probe
 *  has to speak the same contract the request path will speak. Omitting it
 *  keeps the body byte-identical to the symmetric case. */
export async function probeEmbeddingDimensions(
  baseUrl: string,
  key: string,
  modelId: string,
  inputType?: EmbeddingInputType | null,
): Promise<number> {
  const out = await openAiStyleEmbed(
    `${baseUrl.trim().replace(/\/+$/, '')}/embeddings`,
    'custom',
    key,
    modelId,
    ['dimension probe'],
    inputType ? { input_type: inputType } : {},
  );
  const vector = out.vectors[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new EmbeddingsError('upstream returned malformed embeddings', 502);
  }
  return vector.length;
}

export interface CustomEmbeddingRegistration {
  keyId: number;
  modelId: string;
  displayName: string | null;
  family: string;
  dimensions: number;
  maxInputTokens: number | null;
  quotaLabel: string;
  /** 'query' | 'passage' for an endpoint that requires one (NVIDIA Nemotron
   *  3.5 and friends).
   *
   *  Tri-state, because "the caller has no opinion" and "the caller says send
   *  no input_type" are different answers:
   *    undefined — no opinion: keep whatever is on record. Every caller that
   *                predates this field (the bulk key importer included) lands
   *                here, and none of them may clear a choice that is what
   *                makes an asymmetric endpoint answer at all.
   *    null      — send no input_type: the endpoint is symmetric. Clears a
   *                stored value.
   *    a value   — send that input_type. */
  inputType?: EmbeddingInputType | null;
  /** Optional per-model windows. `undefined` means the caller has no opinion
   *  (the bulk key importer, for instance, never collects them) and leaves an
   *  existing row's value alone; `null` explicitly clears it to "unlimited". */
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
}

/**
 * Upsert one custom embedding model bound to an endpoint credential — the
 * shared write path behind POST /api/embeddings/custom and the bulk key
 * importer (#382). Throws EmbeddingsError(400) when the family already exists
 * at a different dimension: vectors from mismatched spaces must never mix, so
 * the caller has to pick a new family name instead.
 */
export function registerCustomEmbeddingModel(db: Db, reg: CustomEmbeddingRegistration): { modelDbId: number; created: boolean } {
  const sibling = db.prepare(`
    SELECT dimensions
      FROM embedding_models
     WHERE family = ?
       AND NOT (platform = 'custom' AND model_id = ?)
     LIMIT 1
  `).get(reg.family, reg.modelId) as { dimensions: number } | undefined;
  if (sibling && sibling.dimensions !== reg.dimensions) {
    throw new EmbeddingsError(
      `Embedding family '${reg.family}' is ${sibling.dimensions} dimensions, but '${reg.modelId}' returned ${reg.dimensions}. Use a new family name.`,
      400,
    );
  }

  const endpointKeyIds = customEndpointKeyIds(db, reg.keyId);
  const existingModel = db.prepare(`
    SELECT id, priority, key_id, rpm_limit, rpd_limit, tpm_limit, tpd_limit
      FROM embedding_models
     WHERE platform = 'custom' AND model_id = ?
     LIMIT 1
  `).get(reg.modelId) as {
    id: number; priority: number; key_id: number | null;
    rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null;
  } | undefined;
  // A model already on this endpoint keeps the key it has; only a move to a
  // different endpoint re-binds it.
  const bindKeyId = existingModel?.key_id != null && endpointKeyIds.has(existingModel.key_id)
    ? existingModel.key_id
    : reg.keyId;
  const priority = existingModel?.priority ?? (
    (db.prepare('SELECT COALESCE(MAX(priority), 0) AS maxPriority FROM embedding_models WHERE family = ?')
      .get(reg.family) as { maxPriority: number }).maxPriority + 1
  );
  // Rate-limit windows follow the display-name rule (#704) rather than the
  // maxInputTokens one: a re-submit that does not mention them (the bulk key
  // importer, or the dashboard form with the fields left blank) must not wipe
  // a cap the operator configured earlier. An explicit null still clears.
  const keepLimit = <T,>(submitted: T | null | undefined, current: T | null): T | null =>
    submitted === undefined ? current : submitted;

  // `display_name` is optional: a new model takes its id, and a model already
  // on record keeps the name it has instead of being reset by a submit that
  // simply left the field blank (#704).
  //
  // `input_type` follows the same rule, with one addition. A submit that names
  // one sets it; a submit that stays silent (undefined) keeps the value on
  // record, because dropping it would leave an asymmetric endpoint (NVIDIA
  // Nemotron 3.5) unable to answer at all. An explicit null is the operator
  // saying "this endpoint is symmetric" and does clear a stored value.
  //
  // The three states are carried as two bind parameters: a flag saying whether
  // this submit had an opinion at all, and the value it had. A plain COALESCE
  // could not tell "keep the old value" from "clear it".
  if (existingModel) {
    db.prepare(`
      UPDATE embedding_models
         SET family = ?,
             display_name = COALESCE(?, display_name),
             dimensions = ?,
             max_input_tokens = ?,
             priority = ?,
             enabled = 1,
             quota_label = ?,
             key_id = ?,
             input_type = CASE WHEN ? = 1 THEN ? ELSE input_type END,
             rpm_limit = ?,
             rpd_limit = ?,
             tpm_limit = ?,
             tpd_limit = ?
       WHERE id = ?
    `).run(
      reg.family,
      reg.displayName,
      reg.dimensions,
      reg.maxInputTokens,
      priority,
      reg.quotaLabel,
      bindKeyId,
      reg.inputType === undefined ? 0 : 1,
      reg.inputType ?? null,
      keepLimit(reg.rpmLimit, existingModel.rpm_limit),
      keepLimit(reg.rpdLimit, existingModel.rpd_limit),
      keepLimit(reg.tpmLimit, existingModel.tpm_limit),
      keepLimit(reg.tpdLimit, existingModel.tpd_limit),
      existingModel.id,
    );
    return { modelDbId: existingModel.id, created: false };
  }

  const model = db.prepare(`
    INSERT INTO embedding_models
      (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label, key_id,
       input_type, rpm_limit, rpd_limit, tpm_limit, tpd_limit)
    VALUES (?, 'custom', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reg.family,
    reg.modelId,
    reg.displayName ?? reg.modelId,
    reg.dimensions,
    reg.maxInputTokens,
    priority,
    reg.quotaLabel,
    bindKeyId,
    reg.inputType ?? null,
    // A fresh registration that mentions no window stores NULL: unlimited,
    // exactly like an embedding row created before the columns existed.
    reg.rpmLimit ?? null, reg.rpdLimit ?? null, reg.tpmLimit ?? null, reg.tpdLimit ?? null,
  );
  return { modelDbId: Number(model.lastInsertRowid), created: true };
}

async function callProvider(row: EmbeddingModelRow, credential: ProviderCredential, inputs: string[], dimensions?: number): Promise<ProviderCallResult> {
  const { key } = credential;
  switch (row.platform) {
    case 'freeinference':
      return freeInferenceEmbed(row, key, inputs, dimensions);
    case 'custom': {
      if (!credential.baseUrl) throw new EmbeddingsError('custom embedding provider is missing base_url', 500);
      // An asymmetric endpoint (NVIDIA Nemotron 3.5) rejects a request that
      // carries no input_type with 400, so the operator's choice travels with
      // the model row. A symmetric custom endpoint keeps the exact body it
      // has always sent: no input_type field at all.
      const inputType = asEmbeddingInputType(row.input_type);
      return openAiStyleEmbed(
        `${credential.baseUrl}/embeddings`,
        row.platform,
        key,
        row.model_id,
        inputs,
        inputType ? { input_type: inputType } : {},
        dimensions,
      );
    }
    case 'google':
      return openAiStyleEmbed('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'nvidia':
      // NeMo Retriever NIMs require input_type; 'query' is the symmetric-safe
      // choice for a gateway that can't know whether this is index or query time.
      // MRL models (e.g. llama-nemotron-embed-1b-v2) accept dimensions and truncate.
      return openAiStyleEmbed('https://integrate.api.nvidia.com/v1/embeddings', row.platform, key, row.model_id, inputs, { input_type: 'query' }, dimensions);
    case 'openrouter':
      return openAiStyleEmbed('https://openrouter.ai/api/v1/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'sealion':
      return openAiStyleEmbed('https://api.sea-lion.ai/v1/embeddings', row.platform, key, row.model_id, inputs, {}, dimensions);
    case 'speka':
      return openAiStyleEmbed(`${SPEKA_BASE_URL}/embeddings`, row.platform, key, row.model_id, inputs, { encoding_format: 'float' }, dimensions);
    case 'electronhub':
      return openAiStyleEmbed(`${ELECTRONHUB_BASE_URL}/embeddings`, row.platform, key, row.model_id, inputs, { encoding_format: 'float' }, dimensions, row.dimensions);
    case 'freeai': {
      const expected = ({ 'bge-m3': 1024, 'embeddinggemma-2': 768 } as Record<string, number>)[row.model_id];
      if (!expected || row.dimensions !== expected || dimensions !== undefined && dimensions !== expected)
        throw new EmbeddingsError('Free.ai embeddings require a tested model and its native dimensions', 400);
      const r = await proxyFetch(FREEAI_BASE_URL + '/v1/embeddings/', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', ...bearerAuthHeader(key) },
        body: JSON.stringify({ model: row.model_id, input: inputs }),
      }, row.platform, 'embedding', FETCH_TIMEOUT_MS);
      if (!r.ok) {
        await r.body?.cancel();
        throw new EmbeddingsError('Free.ai embeddings error (HTTP ' + r.status + ')', r.status, undefined, parseRetryAfterMs(r.headers.get('retry-after')));
      }
      const body = await r.json().catch(() => null) as { model?: string; embeddings?: number[][]; count?: number; dimensions?: number; tokens_used?: number } | null;
      if (body?.model !== row.model_id || body.dimensions !== expected || body.count !== inputs.length ||
          !Array.isArray(body.embeddings) || body.embeddings.length !== inputs.length ||
          body.embeddings.some(v => !Array.isArray(v) || v.length !== expected || !v.every(Number.isFinite) || !v.some(x => x !== 0)))
        throw new EmbeddingsError('Free.ai returned mismatched or malformed embeddings', 502);
      return { vectors: body.embeddings, inputTokens: typeof body.tokens_used === 'number' && Number.isSafeInteger(body.tokens_used) && body.tokens_used >= 0 ? body.tokens_used : null };
    }
    case 'silvr': {
      const nativeDimensions: Record<string, number> = { 'nemotron-3-5-embed-1b': 2048, 'nemotron-3-5-embed-8b': 4096, 'gemini-embedding-2': 3072, 'gemini-embedding-001': 3072, 'text-embedding-3-small': 1536 };
      const expected = nativeDimensions[row.model_id];
      if (!expected || row.dimensions !== expected || dimensions !== undefined && dimensions !== expected) {
        throw new EmbeddingsError('SilvR embeddings require a tested model and its native dimensions', 400);
      }
      return openAiStyleEmbed(`${SILVR_BASE_URL}/embeddings`, row.platform, key, row.model_id, inputs, {}, undefined, expected);
    }
    case 'inferbase':
      return openAiStyleEmbed(`${INFERBASE_BASE_URL}/embeddings`, row.platform, key, row.model_id, inputs, { encoding_format: 'float' }, dimensions, row.dimensions);
    case 'jamai':
      if (dimensions !== undefined && dimensions !== row.dimensions) {
        throw new EmbeddingsError('JamAI does not support an embedding dimension override', 400);
      }
      return openAiStyleEmbed(`${JAMAI_BASE_URL}/embeddings`, row.platform, '', row.model_id, inputs,
        { type: 'document', encoding_format: 'float' }, undefined, row.dimensions, FETCH_TIMEOUT_MS, jamaiHeaders(key));
    case 'llmtr':
      // The catalog-approved models return fixed-width vectors. Do not send a
      // dimension override or accept a substituted model/embedding space.
      if (dimensions !== undefined && dimensions !== row.dimensions) {
        throw new EmbeddingsError('LLMTR does not support an embedding dimension override', 400);
      }
      return openAiStyleEmbed(`${LLMTR_BASE_URL}/embeddings`, row.platform, key, row.model_id, inputs, {}, undefined, row.dimensions);
    case 'cloudflare': {
      // Key is stored as "account_id:token".
      const sep = key.indexOf(':');
      if (sep === -1) throw new EmbeddingsError('cloudflare key is not in account_id:token form', 500);
      const accountId = key.slice(0, sep);
      const token = key.slice(sep + 1);
      return meterCloudflare(
        key, row.model_id,
        { inputTokens: inputs.reduce((sum, text) => sum + roughTokens(text), 0) },
        () => row.model_id === '@cf/google/embeddinggemma-2'
          ? cloudflareEmbeddingGemma2(row, accountId, token, inputs, dimensions)
          : openAiStyleEmbed(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`,
          row.platform, token, row.model_id, inputs, {},
        ),
        r => (r.inputTokens != null ? { inputTokens: r.inputTokens } : null),
        e => new EmbeddingsError(e.message, 429, 'quota_exceeded', e.retryAfterSec * 1000),
      );
    }
    case 'huggingface': {
      // HF serves embeddings as the feature-extraction task, not /v1/embeddings.
      const r = await proxyFetch(
        `https://router.huggingface.co/hf-inference/models/${row.model_id}/pipeline/feature-extraction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ inputs }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
        row.platform, 'embedding', FETCH_TIMEOUT_MS,
      );
      if (!r.ok) throw await upstreamEmbeddingsError(r);
      const j = await r.json() as number[][] | number[];
      const vectors = Array.isArray(j[0]) ? (j as number[][]) : [j as number[]];
      return { vectors, inputTokens: null };
    }
    case 'cohere': {
      const r = await proxyFetch('https://api.cohere.com/v2/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: row.model_id,
          texts: inputs,
          input_type: 'search_document',
          embedding_types: ['float'],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }, row.platform, 'embedding', FETCH_TIMEOUT_MS);
      if (!r.ok) throw await upstreamEmbeddingsError(r);
      const j = (await r.json()) as { embeddings?: { float?: number[][] }; meta?: { billed_units?: { input_tokens?: number } } };
      return { vectors: j.embeddings?.float ?? [], inputTokens: j.meta?.billed_units?.input_tokens ?? null };
    }
    default:
      throw new EmbeddingsError(`no embeddings adapter for platform '${row.platform}'`, 500);
  }
}

function logEmbeddingRequest(
  row: EmbeddingModelRow,
  keyId: number | null,
  status: 'success' | 'error',
  inputTokens: number,
  latencyMs: number,
  error: string | null,
): void {
  try {
    const client = getClientContext();
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, client_ip, client_user_agent, client_agent)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'embedding', ?, ?, ?)
    `).run(row.platform, row.model_id, keyId, status, inputTokens, latencyMs, error, client.ip, client.userAgent, client.agent);
    // Soft budget alert (#1158 follow-on): the ledger trigger fired with this
    // row, so compare the caps once. No-op for uncapped keys.
    if (status === 'success' && keyId != null) noteBudgetAlerts(keyId);
  } catch (e) {
    console.error('Failed to log embedding request:', e);
  }
}

/** Embed `inputs` via the family's provider chain, failing over within the
 * family on any provider error. Throws EmbeddingsError when the chain is dry.
 *
 * `dimensions` (optional): client-supplied output-dimension override forwarded to
 * providers that support MRL truncation (NVIDIA NeMo NIM, Google Gemini Embedding,
 * OpenAI text-embedding-3-*). Providers that ignore the field see an identical
 * request body. The override is independent of the model's native dimension — the
 * family registry still pins the canonical dimension, this just lets callers ask
 * for a smaller vector at the cost of some accuracy. */
export async function runEmbeddings(model: string | undefined, inputs: string[], dimensions?: number): Promise<EmbeddingsResult> {
  const family = resolveFamily(model);
  if (!family) {
    throw new EmbeddingsError(
      `Unknown embedding model '${model}'. Use 'auto', a family name, or a provider model id.`, 400,
    );
  }

  const chain = (getDb().prepare(
    'SELECT * FROM embedding_models WHERE family = ? AND enabled = 1 ORDER BY priority',
  ).all(family) as EmbeddingModelRow[]);
  if (chain.length === 0) {
    throw new EmbeddingsError(`No enabled providers for embedding family '${family}'.`, 503);
  }

  const estimatedTokens = estimateTokens(inputs);
  let lastError: EmbeddingsError | null = null;
  // Upstream back-offs across the whole chain: only a chain that was rate
  // limited end to end earns a Retry-After, and then the soonest one.
  const hints = new RetryHintTracker();
  // WHY a chain that never reached an upstream came up dry: our OWN windows.
  // Kept apart from `lastError`, which is always a real upstream/stated failure,
  // so the final response can tell "the providers are rate-limited, wait" from
  // "the providers are broken" — the same distinction the chat router draws
  // (services/router.ts summarizeExhaustion) instead of collapsing both into a
  // 502 that reads like an upstream outage.
  //
  // Keyed reason → platforms, so a family with several dry providers names each
  // cause once rather than repeating it per row.
  const limitBlocks = new Map<string, Set<string>>();
  const noteLimitBlock = (kind: string, platform: string) => {
    const platforms = limitBlocks.get(kind) ?? new Set<string>();
    platforms.add(platform);
    limitBlocks.set(kind, platforms);
    // A local window carries no provider-stated reset, so a Retry-After is no
    // longer an honest promise for this chain: RetryHintTracker's contract is
    // "every recorded failure was a 429 WITH a stated delay". Poisoning it here
    // is what makes a mixed chain (local block + upstream 429) drop the hint
    // rather than promise the client a retry its own window would refuse.
    hints.record(429, undefined);
  };
  let sawUpstreamFailure = false;
  let budgetExhausted = false;
  let coolingDown = false;

  for (const row of chain) {
    const tried = new Set<number>();
    // This row's own windows, mirroring the chat `models` columns. NULL on an
    // axis means "no opinion": canMakeRequest/canUseTokens skip a NULL axis, so
    // a row nobody configured behaves exactly as it did before these columns
    // existed.
    const limits = { rpm: row.rpm_limit, rpd: row.rpd_limit, tpm: row.tpm_limit, tpd: row.tpd_limit };
    const ledgerModelId = embeddingRateLimitModelId(row.model_id);
    do {
      const { credential, budgetBlocked, cooldownBlocked, cooldownRetryAfterMs, providerMinuteBlocked } =
        // providerMinuteCap: the provider ACCOUNT's per-minute budget is shared
        // with chat (NVIDIA NIM meters ~40 requests/minute across the whole
        // account), so an embedding request has to reserve from the same bucket
        // the chat router does. Without this the cap cannot see embedding
        // traffic at all and the family keeps dispatching until the provider
        // answers 429.
        reserveProviderCredential(row, estimatedTokens, keyId => tried.has(keyId), { providerMinuteCap: true });
      if (!credential) {
        if (budgetBlocked) {
          budgetExhausted = true;
          lastError = new EmbeddingsError('Monthly key budget exhausted', 429, 'quota_exceeded');
          hints.record(429, secondsUntilNextMonth() * 1000);
        }
        if (cooldownBlocked) {
          coolingDown = true;
          lastError ??= new EmbeddingsError('Provider keys are cooling down', 429);
          hints.record(429, cooldownRetryAfterMs);
        }
        if (providerMinuteBlocked) {
          // The account-wide cap, not the model's: say so, because "NVIDIA is
          // rate limited" and "this embedding model is rate limited" call for
          // different operator action (wait for the account bucket vs. raise
          // the model's own limit).
          const cap = getProviderMinuteRequestCap(row.platform);
          noteLimitBlock(`provider-account${cap == null ? '' : ` ${cap}/min`} request cap exhausted`, row.platform);
        }
        break;
      }
      tried.add(credential.id);

      // Per-model windows, the same two gates the chat router runs before it
      // dispatches (services/router.ts: canMakeRequest then canUseTokens). A
      // blocked row is SKIPPED before any upstream call — the provider is never
      // billed for a request it would have rejected — and the family chain
      // moves on, so one exhausted provider cannot strand a family that has a
      // healthy sibling. (For a custom platform the inner loop retries a
      // sibling key first: the window is per key, so a fresh credential on the
      // same endpoint may still have headroom.)
      if (!canMakeRequest(row.platform, ledgerModelId, credential.id, limits)) {
        credential.release();
        noteLimitBlock('rpm/rpd window exhausted', row.platform);
        continue;
      }
      if (!canUseTokens(row.platform, ledgerModelId, credential.id, estimatedTokens, limits)) {
        credential.release();
        noteLimitBlock('tpm/tpd window exhausted', row.platform);
        continue;
      }

      const started = Date.now();
      // Make the attempt visible while it is in the air: every gate above adds
      // in-flight leases on top of recorded usage (ratelimit.ts), which is what
      // stops N concurrent embeddings from all passing the same pre-check and
      // then blowing through the window together. It also counts toward the
      // provider-account minute budget, exactly like a chat attempt.
      const leaseId = acquireLease(row.platform, ledgerModelId, credential.id, estimatedTokens);
      try {
        const out = await callProvider(row, credential, inputs, dimensions);
        if (out.vectors.length !== inputs.length || out.vectors.some(v => !Array.isArray(v) || v.length === 0)) {
          throw new EmbeddingsError('upstream returned malformed embeddings', 502);
        }
        const tokens = out.inputTokens ?? estimatedTokens;
        logEmbeddingRequest(row, credential.id, 'success', tokens, Date.now() - started, null);
        // A served embedding spends provider quota exactly like a served chat
        // request, so it must advance the same windows the gates above read.
        // Skipping this was the bug: embedding traffic was invisible to its own
        // limits AND to the provider-account minute cap, so the gateway could
        // not throttle itself and only learned the ceiling from upstream 429s.
        recordRequest(row.platform, ledgerModelId, credential.id);
        recordTokens(row.platform, ledgerModelId, credential.id, tokens);
        // A served embedding is evidence the key works, the same as a served
        // chat request (#1493) or a served search (#1612): stamp last_healthy_at
        // and lift an 'unknown'/'error' key. Embedding-only keys (and #1459-era
        // providers that refuse probes) had no success signal at all otherwise.
        markKeyHealthyFromRequest(credential.id);
        return {
          family,
          platform: row.platform,
          modelId: row.model_id,
          dimensions: out.vectors[0].length,
          vectors: out.vectors,
          inputTokens: tokens,
        };
      } catch (err: any) {
        sawUpstreamFailure = true;
        const e = err instanceof EmbeddingsError ? err : new EmbeddingsError(String(err?.message ?? err), 502);
        logEmbeddingRequest(row, credential.id, 'error', 0, Date.now() - started, e.message.slice(0, 300));
        if (row.platform === 'custom' && e.status === 429) {
          setCooldown(row.platform, row.model_id, credential.id, e.retryAfterMs);
        }
        lastError = e;
        hints.record(e.status, e.retryAfterMs);
        if (![401, 402, 403, 429].includes(e.status)) break;
        // fall through to the next provider in the family
      } finally {
        releaseLease(leaseId);
        credential.release();
      }
    } while (row.platform === 'custom');
  }

  // Every candidate that could have served was skipped by OUR OWN windows and
  // no upstream ever answered. That is a rate-limit exhaustion, not an upstream
  // failure: the pool recovers by waiting, so answer 429 with the advice the
  // chat router gives (router.ts EXHAUSTION_ADVICE) instead of a 502 that reads
  // as "the providers are broken". Budget and cooldown blocks keep their own
  // (more specific, hint-carrying) paths below.
  if (limitBlocks.size > 0 && !sawUpstreamFailure && !budgetExhausted && !coolingDown) {
    const detail = [...limitBlocks]
      .map(([kind, platforms]) => `${[...platforms].join(', ')}: ${kind}`)
      .join('; ');
    throw new EmbeddingsError(
      `All providers for embedding family '${family}' are rate-limited (${detail}). ` +
      'Add more API keys or wait for rate limits to reset.',
      429,
      'rate_limit_exceeded',
    );
  }

  throw new EmbeddingsError(
    `All providers for embedding family '${family}' failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && lastError.status === 429 ? 429 : 502,
    lastError?.code,
    lastError && lastError.status === 429 ? hints.retryAfterMs() : undefined,
  );
}

/** Whole seconds the client should wait before retrying an embeddings request:
 *  the soonest upstream back-off when the whole chain was rate limited, else the
 *  monthly-budget reset for a local quota block. Undefined means the caller
 *  shouldn't set the header. */
export function embeddingsRetryAfterSec(err: EmbeddingsError): number | undefined {
  if (err.retryAfterMs !== undefined) return retryAfterSeconds(err.retryAfterMs);
  if (err.code === 'quota_exceeded') return secondsUntilNextMonth();
  return undefined;
}
