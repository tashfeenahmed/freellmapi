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
import { decrypt } from '../lib/crypto.js';

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
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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

function getPlatformKey(platform: string): string | null {
  const row = getDb().prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY id LIMIT 1",
  ).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!row) return null;
  try {
    return decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return null;
  }
}

// Rough token estimate when the provider doesn't report usage (~4 chars/token).
function estimateTokens(inputs: string[]): number {
  return Math.ceil(inputs.reduce((n, s) => n + s.length, 0) / 4);
}

const FETCH_TIMEOUT_MS = 30_000;

interface ProviderCallResult {
  vectors: number[][];
  inputTokens: number | null; // provider-reported, when available
}

async function openAiStyleEmbed(
  url: string,
  key: string,
  modelId: string,
  inputs: string[],
  extra: Record<string, unknown> = {},
): Promise<ProviderCallResult> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: modelId, input: inputs, ...extra }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) {
    throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
  }
  const j = (await r.json()) as {
    data?: { index?: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    vectors: data.map(d => d.embedding),
    inputTokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? null,
  };
}

async function callProvider(row: EmbeddingModelRow, key: string, inputs: string[]): Promise<ProviderCallResult> {
  switch (row.platform) {
    case 'google':
      return openAiStyleEmbed('https://generativelanguage.googleapis.com/v1beta/openai/embeddings', key, row.model_id, inputs);
    case 'nvidia':
      // NeMo Retriever NIMs require input_type; 'query' is the symmetric-safe
      // choice for a gateway that can't know whether this is index or query time.
      return openAiStyleEmbed('https://integrate.api.nvidia.com/v1/embeddings', key, row.model_id, inputs, { input_type: 'query' });
    case 'openrouter':
      return openAiStyleEmbed('https://openrouter.ai/api/v1/embeddings', key, row.model_id, inputs);
    case 'github':
      return openAiStyleEmbed('https://models.github.ai/inference/embeddings', key, row.model_id, inputs);
    case 'cloudflare': {
      // Key is stored as "account_id:token".
      const sep = key.indexOf(':');
      if (sep === -1) throw new EmbeddingsError('cloudflare key is not in account_id:token form', 500);
      const accountId = key.slice(0, sep);
      const token = key.slice(sep + 1);
      return openAiStyleEmbed(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/embeddings`,
        token, row.model_id, inputs,
      );
    }
    case 'huggingface': {
      // HF serves embeddings as the feature-extraction task, not /v1/embeddings.
      const r = await fetch(
        `https://router.huggingface.co/hf-inference/models/${row.model_id}/pipeline/feature-extraction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ inputs }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (!r.ok) throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const j = (await r.json()) as number[][] | number[];
      const vectors = Array.isArray(j[0]) ? (j as number[][]) : [j as number[]];
      return { vectors, inputTokens: null };
    }
    case 'cohere': {
      const r = await fetch('https://api.cohere.com/v2/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: row.model_id,
          texts: inputs,
          input_type: 'search_document',
          embedding_types: ['float'],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new EmbeddingsError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status);
      const j = (await r.json()) as { embeddings?: { float?: number[][] }; meta?: { billed_units?: { input_tokens?: number } } };
      return { vectors: j.embeddings?.float ?? [], inputTokens: j.meta?.billed_units?.input_tokens ?? null };
    }
    default:
      throw new EmbeddingsError(`no embeddings adapter for platform '${row.platform}'`, 500);
  }
}

function logEmbeddingRequest(
  row: EmbeddingModelRow,
  status: 'success' | 'error',
  inputTokens: number,
  latencyMs: number,
  error: string | null,
): void {
  try {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
      VALUES (?, ?, NULL, ?, ?, 0, ?, ?, 'embedding')
    `).run(row.platform, row.model_id, status, inputTokens, latencyMs, error);
  } catch (e) {
    console.error('Failed to log embedding request:', e);
  }
}

/** Embed `inputs` via the family's provider chain, failing over within the
 * family on any provider error. Throws EmbeddingsError when the chain is dry. */
export async function runEmbeddings(model: string | undefined, inputs: string[]): Promise<EmbeddingsResult> {
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

  let lastError: EmbeddingsError | null = null;
  for (const row of chain) {
    const key = getPlatformKey(row.platform);
    if (!key) continue; // no usable key for this provider — try the next one
    const started = Date.now();
    try {
      const out = await callProvider(row, key, inputs);
      if (out.vectors.length !== inputs.length || out.vectors.some(v => !Array.isArray(v) || v.length === 0)) {
        throw new EmbeddingsError('upstream returned malformed embeddings', 502);
      }
      const tokens = out.inputTokens ?? estimateTokens(inputs);
      logEmbeddingRequest(row, 'success', tokens, Date.now() - started, null);
      return {
        family,
        platform: row.platform,
        modelId: row.model_id,
        dimensions: out.vectors[0].length,
        vectors: out.vectors,
        inputTokens: tokens,
      };
    } catch (err: any) {
      const e = err instanceof EmbeddingsError ? err : new EmbeddingsError(String(err?.message ?? err), 502);
      logEmbeddingRequest(row, 'error', 0, Date.now() - started, e.message.slice(0, 300));
      lastError = e;
      // fall through to the next provider in the family
    }
  }

  throw new EmbeddingsError(
    `All providers for embedding family '${family}' failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    lastError && lastError.status === 429 ? 429 : 502,
  );
}
