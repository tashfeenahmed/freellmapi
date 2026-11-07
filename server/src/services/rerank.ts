import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { checkMonthlyBudget, reserveMonthlyBudget, secondsUntilNextMonth } from './key-budget.js';
import { noteBudgetAlerts } from './budget-alerts.js';
import { markKeyHealthyFromRequest } from './health.js';
import { getClientContext } from '../lib/client-context.js';

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
  /** Parsed api_keys.model_scope_json (#657) — null = unscoped, serves any rerank model. */
  scope: Set<string> | null;
}

/** The model a candidate actually calls for a requested model (same resolution
 *  as callProvider), so the scope gate checks the id the key really serves. */
function effectiveModel(cand: Pick<RerankCandidate, 'platform'>, model?: string): string {
  return model || (cand.platform === 'cohere' ? 'rerank-v3.5' : 'rerank');
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOCUMENTS = 100;

function candidates(): RerankCandidate[] {
  const rows = getDb().prepare(
    "SELECT id, platform, base_url, encrypted_key, iv, auth_tag, model_scope_json FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') AND platform IN ('cohere', 'custom') ORDER BY platform, created_at",
  ).all() as { id: number; platform: string; base_url: string | null; encrypted_key: string; iv: string; auth_tag: string; model_scope_json: string | null }[];
  const out: RerankCandidate[] = [];
  for (const row of rows) {
    if (row.platform === 'custom' && !row.base_url) continue;
    try {
      out.push({ id: row.id, platform: row.platform, key: decrypt(row.encrypted_key, row.iv, row.auth_tag), baseUrl: row.base_url, scope: parseModelScope(row.model_scope_json) });
    } catch { /* undecryptable row is not a candidate */ }
  }
  // Custom endpoints (the operator's explicit rerank relays) go first.
  return out.sort((a, b) => (a.platform === 'custom' ? -1 : 0) - (b.platform === 'custom' ? -1 : 0));
}

async function upstreamError(r: Response): Promise<RerankError> {
  const retryAfterMs = parseRetryAfterMs(r.headers?.get('retry-after') ?? null);
  return new RerankError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status, undefined, retryAfterMs);
}

// Every other inference surface writes its attempts to `requests` (chat via
// logRequest, embeddings/media/decisions via their own loggers), which is
// where the dashboard history and retention sweeper read from. Rerank was the
// only one that served traffic without a row: invisible in analytics, outside
// retention, and with no key attribution when debugging a bad upstream.
// request_type='rerank' follows the media precedent of tagging non-chat
// traffic; the analytics type-count endpoint ignores types it doesn't map.
function logRerankRequest(cand: { platform: string }, keyId: number, modelId: string,
  status: 'success' | 'error', inputTokens: number, latencyMs: number, error: string | null): void {
  try {
    const client = getClientContext();
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, client_ip, client_user_agent, client_agent)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'rerank', ?, ?, ?)
    `).run(cand.platform, modelId, keyId, status, inputTokens, latencyMs, error, client.ip, client.userAgent, client.agent);
    // Soft budget alert (#1158 follow-on): the ledger trigger fired with this
    // row, so compare the caps once. No-op for uncapped keys.
    if (status === 'success' && keyId != null) noteBudgetAlerts(keyId);
  } catch (e) {
    console.error('Failed to log rerank request:', e);
  }
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
  // Per-key model scope (#657), the same wall the chat router and search key
  // pools honour: a relay key scoped to a model group must never be picked to
  // serve a model outside its list. Filter up front so a pool where every key
  // is scoped out reports "no capable key configured" (503) instead of
  // pretending the providers were tried and failed (502).
  const chain = candidates().filter(c => scopeAllows(c.scope, effectiveModel(c, model)));
  if (chain.length === 0) {
    throw new RerankError('No rerank-capable key configured. Add a Cohere key or a custom rerank endpoint.', 503);
  }
  const n = topN ?? documents.length;
  // Rough token estimate (query + documents, ~4 chars/token), the heuristic
  // embeddings log when upstream reports no usage. It sizes both the request
  // row and the monthly-budget admission check: rerank spends real provider
  // quota, so a key at its monthly cap (#1158) must not serve one.
  const estTokens = Math.ceil((query.length + documents.reduce((s, d) => s + d.length, 0)) / 4);

  let budgetBlocked = false;
  let lastError: RerankError | null = null;
  for (const cand of chain) {
    // Check-and-reserve (the search/embeddings semantics): an in-flight rerank
    // holds its estimate so two concurrent reranks can't both pass the gate on
    // a nearly-spent cap. Released the moment the attempt settles.
    const reservation = reserveMonthlyBudget(cand.id, estTokens);
    if (!reservation.allowed) { budgetBlocked = true; continue; }
    const started = Date.now();
    try {
      const out = await callProvider(cand, model, query, documents, n);
      // A served rerank is evidence the key works, the same as a served chat
      // request (#1493) or a served search (#1612). Rerank candidates come
      // from the same 'healthy'/'unknown' pool, so a key that only ever
      // serves reranks had no success signal to lift it out of 'error'.
      markKeyHealthyFromRequest(cand.id);
      logRerankRequest(cand, cand.id, out.modelId, 'success', estTokens, Date.now() - started, null);
      return { platform: cand.platform, modelId: out.modelId, results: out.results };
    } catch (err: any) {
      lastError = err instanceof RerankError ? err : new RerankError(String(err?.message ?? err), 502);
      logRerankRequest(cand, cand.id, model ?? (cand.platform === 'cohere' ? 'rerank-v3.5' : 'rerank'),
        'error', 0, Date.now() - started, lastError.message.slice(0, 300));
    } finally {
      reservation.release();
    }
  }
  if (budgetBlocked && chain.every(c => !checkMonthlyBudget(c.id, estTokens).allowed)) {
    throw new RerankError('All rerank keys are at their monthly budget.', 429, 'quota_exceeded');
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
