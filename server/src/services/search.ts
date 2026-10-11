import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { secondsUntilNextMonth } from './key-budget.js';

// Search over the existing free-tier key pool (#1174), following the rerank
// slice (#1029): platform='tavily' keys and custom endpoints exposing
// POST {base_url}/search (Tavily's own wire shape). No catalog table, no smart
// routing — the `topic` and `depth` fields pass through; failover walks the
// candidate keys in order and takes the first success.

export interface SearchResponse {
  query: string;
  answer?: string;
  results: { title: string; url: string; content: string; score: number }[];
  provider: string;
  modelId: string;
}

export class SearchError extends Error {
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

interface SearchCandidate {
  id: number;
  platform: string;
  key: string;
  baseUrl: string | null;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 20;

function candidates(): SearchCandidate[] {
  const rows = getDb().prepare(
    "SELECT id, platform, base_url, encrypted_key, iv, auth_tag FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') AND platform IN ('tavily', 'custom') ORDER BY platform, created_at",
  ).all() as { id: number; platform: string; base_url: string | null; encrypted_key: string; iv: string; auth_tag: string }[];
  const out: SearchCandidate[] = [];
  for (const row of rows) {
    if (row.platform === 'custom' && !row.base_url) continue;
    try {
      out.push({ id: row.id, platform: row.platform, key: decrypt(row.encrypted_key, row.iv, row.auth_tag), baseUrl: row.base_url });
    } catch { /* undecryptable row is not a candidate */ }
  }
  // Custom endpoints (the operator's explicit search relays) go first.
  return out.sort((a, b) => (a.platform === 'custom' ? -1 : 0) - (b.platform === 'custom' ? -1 : 0));
}

async function upstreamError(r: Response): Promise<SearchError> {
  const retryAfterMs = parseRetryAfterMs(r.headers?.get('retry-after') ?? null);
  return new SearchError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status, undefined, retryAfterMs);
}

export interface SearchOptions {
  maxResults?: number;
  topic?: 'general' | 'news';
  includeAnswer?: boolean;
}

async function callProvider(cand: SearchCandidate, query: string, opts: SearchOptions): Promise<Omit<SearchResponse, 'provider'>> {
  // ponytail: tavily-shaped wire only; per-provider adapters when a second
  // search provider (Brave, Exa, Serper) needs a different shape.
  const url = cand.platform === 'tavily'
    ? 'https://api.tavily.com/search'
    : `${cand.baseUrl!.replace(/\/$/, '')}/search`;
  const body: Record<string, unknown> = {
    query,
    max_results: Math.min(opts.maxResults ?? 5, MAX_RESULTS),
  };
  if (opts.topic) body.topic = opts.topic;
  if (opts.includeAnswer !== undefined) body.include_answer = opts.includeAnswer;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cand.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw await upstreamError(res);
  const parsed = await res.json() as {
    answer?: string;
    results?: { title?: string; url?: string; content?: string; score?: number }[];
  };
  // A search answer with no hits serves nobody — treat it as malformed so the
  // chain moves on to the next provider (mirrors the rerank slice).
  const results = (Array.isArray(parsed.results) ? parsed.results : [])
    .filter(r => typeof r.url === 'string' && r.url)
    .map(r => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: r.url!,
      content: typeof r.content === 'string' ? r.content : '',
      score: typeof r.score === 'number' ? r.score : 0,
    }));
  if (results.length === 0) throw new SearchError('upstream returned no valid search hits', 502);
  return { query, answer: typeof parsed.answer === 'string' ? parsed.answer : undefined, results, modelId: 'search' };
}

export async function runSearch(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const chain = candidates();
  if (chain.length === 0) {
    throw new SearchError('No search-capable key configured. Add a Tavily key or a custom search endpoint.', 503);
  }

  let lastError: SearchError | null = null;
  for (const cand of chain) {
    try {
      const out = await callProvider(cand, query, opts);
      return { ...out, provider: cand.platform };
    } catch (err: any) {
      lastError = err instanceof SearchError ? err : new SearchError(String(err?.message ?? err), 502);
    }
  }
  throw new SearchError(
    `All search providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ''}.`,
    lastError?.status === 429 ? 429 : 502,
    lastError?.code,
    lastError?.status === 429 ? lastError?.retryAfterMs : undefined,
  );
}

/** Whole seconds the client should wait before retrying: the upstream back-off
 *  when the chain was rate limited, else the monthly-budget reset. */
export function searchRetryAfterSec(err: SearchError): number | undefined {
  if (err.retryAfterMs !== undefined) return Math.ceil(err.retryAfterMs / 1000);
  if (err.code === 'quota_exceeded') return secondsUntilNextMonth();
  return undefined;
}
