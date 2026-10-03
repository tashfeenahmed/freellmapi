import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { secondsUntilNextMonth } from './key-budget.js';

// Cohere-style rerank over the existing free-tier key pool (#1029). Deliberately
// narrow first slice: platform='cohere' keys and custom OpenAI-compatible
// endpoints (POST {base_url}/rerank, Jina shape). No catalog table, no new
// platforms — a rerank model id pins nothing; failover walks the candidate
// keys in order and takes the first success.

export interface RerankResult {
  platform: string;
  modelId: string;
  results: { index: number; relevanceScore: number; document: string }[];
}

export class RerankError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

interface RerankCandidate {
  id: number;
  platform: string;
  key: string;
  baseUrl: string | null;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOCUMENTS = 100;

function candidates(): RerankCandidate[] {
  const rows = getDb().prepare(
    "SELECT id, platform, base_url, encrypted_key, iv, auth_tag FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') AND platform IN ('cohere', 'custom') ORDER BY platform, created_at",
  ).all() as { id: number; platform: string; base_url: string | null; encrypted_key: string; iv: string; auth_tag: string }[];
  const out: RerankCandidate[] = [];
  for (const row of rows) {
    if (row.platform === 'custom' && !row.base_url) continue;
    try {
      out.push({ id: row.id, platform: row.platform, key: decrypt(row.encrypted_key, row.iv, row.auth_tag), baseUrl: row.base_url });
    } catch { /* undecryptable row is not a candidate */ }
  }
  // Custom endpoints (the operator's explicit rerank relays) go first.
  return out.sort((a, b) => (a.platform === 'custom' ? -1 : 0) - (b.platform === 'custom' ? -1 : 0));
}

async function upstreamError(r: Response): Promise<RerankError> {
  const retryAfterMs = parseRetryAfterMs(r.headers?.get('retry-after') ?? null);
  return new RerankError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status, undefined, retryAfterMs);
}

async function callProvider(cand: RerankCandidate, model: string | undefined, query: string,
  documents: string[], topN: number): Promise<{ modelId: string; results: RerankResult['results'] }> {
  // ponytail: cohere + jina-shaped custom only; per-provider adapters when a
  // provider needs a different wire shape.
  const url = cand.platform === 'cohere'
    ? 'https://api.cohere.com/v2/rerank'
    : `${cand.baseUrl!.replace(/\/$/, '')}/rerank`;
  const modelId = model
    || (cand.platform === 'cohere' ? 'rerank-v3.5' : 'rerank');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cand.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, query, documents, top_n: topN }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw await upstreamError(res);
  const body = await res.json() as { results?: { index?: number; relevance_score?: number; document?: { text?: string } | string }[] };
  if (!Array.isArray(body.results)) throw new RerankError('upstream returned malformed rerank results', 502);
  const results = body.results.map(r => ({
    index: r.index ?? -1,
    relevanceScore: r.relevance_score ?? 0,
    document: typeof r.document === 'string' ? r.document : r.document?.text ?? documents[r.index ?? -1] ?? '',
  })).filter(r => r.index >= 0 && r.index < documents.length);
  // An upstream answer with no in-range hit serves nobody — treat it as a
  // malformed response so the chain moves on to the next provider.
  if (results.length === 0) throw new RerankError('upstream returned no valid rerank hits', 502);
  return { modelId, results };
}

export async function runRerank(model: string | undefined, query: string, documents: string[],
  topN?: number): Promise<RerankResult> {
  if (documents.length > MAX_DOCUMENTS) {
    throw new RerankError(`Too many documents: ${documents.length} (max ${MAX_DOCUMENTS})`, 400);
  }
  const chain = candidates();
  if (chain.length === 0) {
    throw new RerankError('No rerank-capable key configured. Add a Cohere key or a custom rerank endpoint.', 503);
  }
  const n = topN ?? documents.length;

  let lastError: RerankError | null = null;
  for (const cand of chain) {
    try {
      const out = await callProvider(cand, model, query, documents, n);
      return { platform: cand.platform, modelId: out.modelId, results: out.results };
    } catch (err: any) {
      lastError = err instanceof RerankError ? err : new RerankError(String(err?.message ?? err), 502);
    }
  }
  throw new RerankError(
    `All rerank providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ''}.`,
    lastError?.status === 429 ? 429 : 502,
    lastError?.code,
    lastError?.status === 429 ? lastError?.retryAfterMs : undefined,
  );
}

/** Whole seconds the client should wait before retrying: the upstream back-off
 *  when the chain was rate limited, else the monthly-budget reset. */
export function rerankRetryAfterSec(err: RerankError): number | undefined {
  if (err.retryAfterMs !== undefined) return Math.ceil(err.retryAfterMs / 1000);
  if (err.code === 'quota_exceeded') return secondsUntilNextMonth();
  return undefined;
}
