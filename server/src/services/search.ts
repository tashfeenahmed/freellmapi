import { getDb, getSetting, setSetting } from '../db/index.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { RetryHintTracker } from '../lib/retry-hint.js';
import { getClientContext } from '../lib/client-context.js';
import { proxyFetch } from '../lib/proxy.js';
import { isSearchPlatform } from '../lib/search-platforms.js';
import { TAVILY_BASE_URL } from '../providers/tavily.js';
import { EXA_BASE_URL } from '../providers/exa.js';
import { FIRECRAWL_BASE_URL } from '../providers/firecrawl.js';
import { LINKUP_BASE_URL } from '../providers/linkup.js';
import { PARALLEL_BASE_URL, PARALLEL_MCP_URL } from '../providers/parallel.js';
import { isAnonymousCredential } from '../lib/credential.js';
import { randomUUID } from 'node:crypto';
import { secondsUntilNextMonth } from './key-budget.js';
import { reserveProviderCredential, type ReservedProviderCredential } from './provider-credential.js';
import { isOnCooldown, setCooldown, setRetryAfterCooldown } from './ratelimit.js';
import { USABLE_KEY_SQL, isUsableKey } from './key-state.js';

// Web search over the key pool (#1174).
//
// Search engines are media_models rows with modality = 'search' (model_id is
// the engine id, e.g. 'tavily-search'). The catalog's `searchEngines` registry
// maintains them (see catalog-sync); nothing is bundled, so engines reach
// Premium first and Free 30 days later like any catalog row. A user can also
// register a custom endpoint that speaks Tavily's wire shape at POST {base_url}/search (POST /api/media/custom with
// modality 'search'), which binds the row to that endpoint's key.
//
// Routing: custom endpoints first (the operator's explicit relays), then the
// catalog engines in priority order (a local reorder from the dashboard wins
// over the catalog's order), then every healthy enabled key of the engine's
// platform. A rate-limited or out-of-credit key cools down per engine and the
// chain moves on; the first engine that returns hits wins. Every attempt is
// logged to search_requests for the dashboard's Search page and analytics.

export const SEARCH_MODALITY = 'search';

/** settings key holding the dashboard's local engine order: a JSON map of
 *  `${platform}:${engineId}` → priority. Kept out of media_models.priority so
 *  the next catalog apply (which rewrites that column) cannot undo it. */
const PRIORITY_OVERRIDES_SETTING = 'search_engine_priority';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;
/** Page text per hit for the engines that return full content (Exa). Enough
 *  for a model to ground an answer without flooding its context. */
const CONTENT_CHARS = 1_500;
/** Cooldowns, per key and engine. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const BAD_KEY_COOLDOWN_MS = 60 * 60_000;
/** Out of credits: free search credits reset on each account's own cycle, not
 *  a calendar month, so re-check twice a day instead of benching to month end. */
const NO_CREDIT_COOLDOWN_MS = 12 * 60 * 60_000;

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  answer?: string;
  results: SearchHit[];
  /** Platform that served the search ('tavily', 'exa', ..., or 'custom'). */
  provider: string;
  /** Engine id that served the search ('tavily-search', ...). */
  engine: string;
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

export interface SearchOptions {
  maxResults?: number;
  topic?: 'general' | 'news';
  includeAnswer?: boolean;
  /** Pin one engine by id; omitted or 'auto' walks the whole chain. */
  engine?: string;
  /** Agent the search runs for (e.g. 'claude-code'); defaults to the request's
   *  detected client. Recorded on search_requests. */
  clientAgent?: string | null;
  /** The caller's cancellation (a departed client). */
  signal?: AbortSignal;
}

export interface SearchEngineFeatures {
  news?: boolean;
  answer?: boolean;
  fullContent?: boolean;
}

export interface SearchEngineMeta {
  creditsPerQuery?: number | null;
  features?: SearchEngineFeatures;
  premiumSince?: string | null;
}

interface SearchEngineRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  priority: number;
  enabled: number;
  quota_label: string;
  key_id: number | null;
  meta_json: string | null;
}

export function parseSearchMeta(raw: string | null): SearchEngineMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as SearchEngineMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ── Engine order ─────────────────────────────────────────────────────────────

function engineKey(row: Pick<SearchEngineRow, 'platform' | 'model_id'>): string {
  return `${row.platform}:${row.model_id}`;
}

function readPriorityOverrides(): Record<string, number> {
  const raw = getSetting(PRIORITY_OVERRIDES_SETTING);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function allEngineRows(): SearchEngineRow[] {
  return getDb()
    .prepare(`SELECT id, platform, model_id, display_name, priority, enabled, quota_label, key_id, meta_json
                FROM media_models WHERE modality = ? ORDER BY priority, id`)
    .all(SEARCH_MODALITY) as SearchEngineRow[];
}

/** Every search engine row in effective order (local reorder over catalog
 *  priority), each carrying its effective priority. */
function orderedEngines(): Array<SearchEngineRow & { effectivePriority: number }> {
  const overrides = readPriorityOverrides();
  return allEngineRows()
    .map(row => ({ ...row, effectivePriority: overrides[engineKey(row)] ?? row.priority }))
    .sort((a, b) => a.effectivePriority - b.effectivePriority || a.id - b.id);
}

// ── Adapters ────────────────────────────────────────────────────────────────

interface AdapterResult {
  answer?: string;
  results: SearchHit[];
}

type Adapter = (cred: ReservedProviderCredential, query: string, opts: SearchOptions, maxResults: number) => Promise<AdapterResult>;

async function upstream(url: string, platform: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await proxyFetch(
    url,
    { ...init, signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal },
    platform,
    'search',
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SearchError(
      `${platform} ${res.status}: ${body.slice(0, 200)}`,
      res.status,
      undefined,
      parseRetryAfterMs(res.headers?.get('retry-after') ?? null),
    );
  }
  // MCP servers may answer a POST as a one-event stream instead of plain JSON.
  if ((res.headers?.get('content-type') ?? '').includes('text/event-stream')) {
    return lastSseJson(await res.text());
  }
  return res.json();
}

/** The JSON payload of the last `data:` event in an SSE body. */
function lastSseJson(body: string): unknown {
  const data = body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  if (data.length === 0) throw new SearchError('upstream sent an empty event stream', 502);
  return JSON.parse(data[data.length - 1]!);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (v: string): string => (v.length > CONTENT_CHARS ? `${v.slice(0, CONTENT_CHARS)}…` : v);
/** Engines that do not score hits keep their own ranking: 1.0 down to ~0. */
const rankScore = (i: number, n: number): number => Number((1 - i / Math.max(n, 1)).toFixed(3));

// Some engines (Linkup) return page titles with their HTML entities intact
// ("Quelle est la capitale de l&#039;Australie"). Decode the common ones so
// every engine hands back plain text.
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(v: string): string {
  if (!v.includes('&')) return v;
  return v.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function keepHits(hits: Array<{ title: string; url: string; content: string; score?: number }>): SearchHit[] {
  const valid = hits.filter(h => h.url);
  return valid.map((h, i) => ({
    title: decodeEntities(h.title),
    url: h.url,
    content: clip(decodeEntities(h.content)),
    score: typeof h.score === 'number' && Number.isFinite(h.score) ? h.score : rankScore(i, valid.length),
  }));
}

// Parallel's anonymous Search MCP asks for a stable conversation id on every
// call (used for its free-tier rate limiting); one per server process.
const PARALLEL_SESSION_ID = `freellmapi-${randomUUID()}`;
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|quota/i;

/** Unwrap a JSON-RPC `tools/call` reply from Parallel's Search MCP into the
 *  REST-shaped search response its text content carries. */
function parallelMcpPayload(rpc: unknown): { results?: Array<Record<string, unknown>> } {
  const r = rpc as { error?: { message?: unknown }; result?: { isError?: boolean; content?: Array<{ type?: string; text?: unknown }> } };
  const text = (r?.result?.content ?? []).find(c => c?.type === 'text' && typeof c.text === 'string')?.text as string | undefined;
  const failure = typeof r?.error?.message === 'string' ? r.error.message : (r?.result?.isError ? (text ?? 'tool error') : null);
  if (failure !== null) {
    throw new SearchError(`parallel MCP: ${failure.slice(0, 200)}`, RATE_LIMIT_TEXT.test(failure) ? 429 : 502);
  }
  if (!text) throw new SearchError('parallel MCP returned no text content', 502);
  try {
    return JSON.parse(text) as { results?: Array<Record<string, unknown>> };
  } catch {
    throw new SearchError('parallel MCP returned non-JSON content', 502);
  }
}

/** Tavily's wire shape, shared by Tavily itself and custom search relays. */
async function tavilyShaped(url: string, platform: string, cred: ReservedProviderCredential, query: string, opts: SearchOptions, maxResults: number): Promise<AdapterResult> {
  const body: Record<string, unknown> = { query, max_results: maxResults };
  if (opts.topic) body.topic = opts.topic;
  if (opts.includeAnswer !== undefined) body.include_answer = opts.includeAnswer;
  const parsed = await upstream(url, platform, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, opts.signal) as { answer?: unknown; results?: Array<Record<string, unknown>> };
  const hits = (Array.isArray(parsed?.results) ? parsed.results : []).map(r => ({
    title: str(r.title),
    url: str(r.url),
    content: str(r.content),
    score: typeof r.score === 'number' ? r.score : undefined,
  }));
  return { answer: typeof parsed?.answer === 'string' ? parsed.answer : undefined, results: keepHits(hits) };
}

const ADAPTERS: Record<string, Adapter> = {
  tavily: (cred, query, opts, n) => tavilyShaped(`${TAVILY_BASE_URL}/search`, 'tavily', cred, query, opts, n),

  custom: (cred, query, opts, n) => {
    if (!cred.baseUrl) throw new SearchError('custom search endpoint has no base URL', 502);
    return tavilyShaped(`${cred.baseUrl}/search`, 'custom', cred, query, opts, n);
  },

  exa: async (cred, query, opts, n) => {
    const body: Record<string, unknown> = {
      query,
      numResults: n,
      type: 'auto',
      contents: { text: { maxCharacters: CONTENT_CHARS } },
    };
    if (opts.topic === 'news') body.category = 'news';
    const parsed = await upstream(`${EXA_BASE_URL}/search`, 'exa', {
      method: 'POST',
      headers: { 'x-api-key': cred.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, opts.signal) as { results?: Array<Record<string, unknown>> };
    const hits = (Array.isArray(parsed?.results) ? parsed.results : []).map(r => ({
      title: str(r.title),
      url: str(r.url),
      content: str(r.text) || str(r.summary) || (Array.isArray(r.highlights) ? r.highlights.filter(h => typeof h === 'string').join(' … ') : ''),
    }));
    return { results: keepHits(hits) };
  },

  firecrawl: async (cred, query, opts, n) => {
    const source = opts.topic === 'news' ? 'news' : 'web';
    const parsed = await upstream(`${FIRECRAWL_BASE_URL}/search`, 'firecrawl', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: n, sources: [source] }),
    }, opts.signal) as { data?: { web?: Array<Record<string, unknown>>; news?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> };
    // v2 groups hits by source; tolerate the v1 flat array too.
    const data = parsed?.data;
    const rows = Array.isArray(data) ? data : (data?.[source] ?? data?.web ?? []);
    const hits = (Array.isArray(rows) ? rows : []).map(r => ({
      title: str(r.title),
      url: str(r.url),
      content: str(r.description) || str(r.snippet) || str(r.markdown),
    }));
    return { results: keepHits(hits) };
  },

  linkup: async (cred, query, opts, n) => {
    const answer = opts.includeAnswer === true;
    const parsed = await upstream(`${LINKUP_BASE_URL}/search`, 'linkup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, depth: 'standard', outputType: answer ? 'sourcedAnswer' : 'searchResults', maxResults: n }),
    }, opts.signal) as { answer?: unknown; sources?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> };
    if (answer) {
      const hits = (Array.isArray(parsed?.sources) ? parsed.sources : []).map(r => ({
        title: str(r.name),
        url: str(r.url),
        content: str(r.snippet),
      }));
      return { answer: typeof parsed?.answer === 'string' ? parsed.answer : undefined, results: keepHits(hits) };
    }
    const hits = (Array.isArray(parsed?.results) ? parsed.results : [])
      .filter(r => r.type === undefined || r.type === 'text')
      .map(r => ({ title: str(r.name), url: str(r.url), content: str(r.content) }));
    return { results: keepHits(hits) };
  },

  // Keyless: the stored `no-key` sentinel goes through the anonymous Search
  // MCP; a real key uses the REST API. Both return the same result shape.
  parallel: async (cred, query, opts, n) => {
    const args = { objective: query, search_queries: [query] };
    const parsed = isAnonymousCredential(cred.key)
      ? parallelMcpPayload(await upstream(PARALLEL_MCP_URL, 'parallel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'web_search', arguments: { ...args, session_id: PARALLEL_SESSION_ID } },
          }),
        }, opts.signal))
      : await upstream(`${PARALLEL_BASE_URL}/search`, 'parallel', {
          method: 'POST',
          headers: { 'x-api-key': cred.key.trim(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...args, mode: 'fast', advanced_settings: { max_results: n } }),
        }, opts.signal) as { results?: Array<Record<string, unknown>> };
    const hits = (Array.isArray(parsed?.results) ? parsed.results : []).slice(0, n).map(r => ({
      title: str(r.title) || str(r.url),
      url: str(r.url),
      content: Array.isArray(r.excerpts) ? r.excerpts.filter(e => typeof e === 'string').join(' … ') : '',
    }));
    return { results: keepHits(hits) };
  },
};

/** Platforms with a search adapter. catalog-sync gates searchEngines rows on
 *  this, the way VIDEO_PLATFORMS gates video rows. */
export const SEARCH_ENGINE_PLATFORMS = new Set(Object.keys(ADAPTERS).filter(p => p !== 'custom'));

// ── Routing ─────────────────────────────────────────────────────────────────

function logSearch(row: SearchEngineRow, keyId: number | null, status: 'ok' | 'error', latencyMs: number, resultCount: number, clientAgent: string | null, error: string | null): void {
  try {
    getDb()
      .prepare(`INSERT INTO search_requests (engine_id, platform, key_id, status, latency_ms, result_count, client_agent, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.model_id, row.platform, keyId, status, latencyMs, resultCount, clientAgent, error);
  } catch (e) {
    console.error('Failed to log search request:', e);
  }
}

/** Bench this key for this engine according to what the upstream said. */
function coolDown(row: SearchEngineRow, keyId: number, e: SearchError): void {
  if (row.platform === 'custom') {
    if (e.status === 429) setRetryAfterCooldown(row.platform, row.model_id, keyId, e.retryAfterMs, RATE_LIMIT_COOLDOWN_MS);
    return;
  }
  if (e.status === 401 || e.status === 403) {
    setCooldown(row.platform, row.model_id, keyId, BAD_KEY_COOLDOWN_MS);
  } else if (e.status === 402 || e.status === 432 || e.status === 433) {
    // 402 (Exa, Firecrawl) and 432/433 (Tavily plan / pay-as-you-go cap):
    // the key's credits are spent.
    setCooldown(row.platform, row.model_id, keyId, NO_CREDIT_COOLDOWN_MS, 'credit');
  } else if (e.status === 429) {
    setRetryAfterCooldown(row.platform, row.model_id, keyId, e.retryAfterMs, RATE_LIMIT_COOLDOWN_MS);
  }
}

/** True when at least one enabled engine has a usable key, i.e. a search can
 *  be attempted. The agents' web_search integration keys off this. */
export function searchAvailable(): boolean {
  const db = getDb();
  for (const row of orderedEngines()) {
    if (row.enabled !== 1) continue;
    if (row.platform === 'custom') {
      if (row.key_id == null) continue;
      const k = db.prepare(`SELECT 1 FROM api_keys WHERE id = ? AND ${USABLE_KEY_SQL}`).get(row.key_id);
      if (k) return true;
      continue;
    }
    if (!ADAPTERS[row.platform]) continue;
    const k = db.prepare(`SELECT 1 FROM api_keys WHERE platform = ? AND ${USABLE_KEY_SQL} LIMIT 1`).get(row.platform);
    if (k) return true;
  }
  return false;
}

function searchChain(engine: string | undefined): SearchEngineRow[] {
  const enabled = orderedEngines().filter(r => r.enabled === 1 && ADAPTERS[r.platform]);
  // Custom relays first, catalog engines after, each group in effective order.
  const chain = [...enabled.filter(r => r.platform === 'custom'), ...enabled.filter(r => r.platform !== 'custom')];
  if (!engine || engine === 'auto') return chain;
  const pinned = chain.filter(r => r.model_id === engine);
  if (pinned.length === 0) {
    const known = orderedEngines().some(r => r.model_id === engine);
    throw new SearchError(
      known
        ? `Search engine '${engine}' is turned off. Turn it on from Models → Search, or use 'auto'.`
        : `Unknown search engine '${engine}'. Use 'auto' or an engine id from GET /v1/search/engines.`,
      400,
    );
  }
  return pinned;
}

export async function runSearch(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const chain = searchChain(opts.engine);
  const maxResults = Math.min(Math.max(1, Math.floor(opts.maxResults ?? DEFAULT_RESULTS)), MAX_RESULTS);
  const clientAgent = opts.clientAgent !== undefined ? opts.clientAgent : getClientContext().agent;

  let lastError: SearchError | null = null;
  let attempted = 0;
  const hints = new RetryHintTracker();
  for (const row of chain) {
    // Several keys per engine: a benched or failing key passes to the next
    // key of the same engine before the chain moves to the next engine.
    const tried = new Set<number>();
    for (;;) {
      if (opts.signal?.aborted) throw new SearchError('search cancelled by the client', 499);
      const { credential, budgetBlocked } = reserveProviderCredential(
        row,
        0,
        keyId => tried.has(keyId) || isOnCooldown(row.platform, row.model_id, keyId),
      );
      if (!credential) {
        if (budgetBlocked) {
          lastError = new SearchError('Monthly key budget exhausted', 429, 'quota_exceeded');
          hints.record(429, secondsUntilNextMonth() * 1000);
        }
        break;
      }
      tried.add(credential.id);
      attempted++;
      const started = Date.now();
      try {
        const out = await ADAPTERS[row.platform]!(credential, query, opts, maxResults);
        if (out.results.length === 0) throw new SearchError('upstream returned no valid search hits', 502);
        logSearch(row, credential.id, 'ok', Date.now() - started, out.results.length, clientAgent, null);
        return {
          query,
          ...(out.answer ? { answer: out.answer } : {}),
          results: out.results,
          provider: row.platform,
          engine: row.model_id,
        };
      } catch (err: any) {
        const e = err instanceof SearchError ? err : new SearchError(String(err?.message ?? err), 502);
        logSearch(row, credential.id, 'error', Date.now() - started, 0, clientAgent, e.message.slice(0, 300));
        coolDown(row, credential.id, e);
        lastError = e;
        hints.record(e.status, e.retryAfterMs);
        if (opts.signal?.aborted) throw new SearchError('search cancelled by the client', 499);
        // A query the engine rejected as malformed is the caller's problem,
        // not this key's: try the next engine rather than every key.
        if (e.status === 400) break;
      } finally {
        credential.release();
      }
    }
  }

  if (attempted === 0 && !lastError) {
    // Keys exist but every one is benched (rate limited, out of credits or
    // rejected recently): a retryable condition, not a setup problem.
    if (searchAvailable()) {
      throw new SearchError(
        'Every search key is cooling down (rate limited or out of credits). Try again later or add another search key.',
        429,
        'search_keys_cooling_down',
      );
    }
    throw new SearchError(
      'No search key configured. Enable Parallel (no key needed) or add a Tavily, Exa, Firecrawl or Linkup key on the Keys page.',
      503,
      'no_search_keys',
    );
  }
  // Only statuses the caller can act on pass through (see media chainError):
  // an upstream 401 means OUR provider key failed, not the caller's.
  const status = lastError?.status === 429 ? 429 : 502;
  throw new SearchError(
    `All search engines failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ' (no usable keys)'}.`,
    status,
    lastError?.code,
    status === 429 ? hints.retryAfterMs() : undefined,
  );
}

/** Whole seconds the client should wait before retrying: the upstream back-off
 *  when the chain was rate limited, else the monthly-budget reset. */
export function searchRetryAfterSec(err: SearchError): number | undefined {
  if (err.retryAfterMs !== undefined) return Math.ceil(err.retryAfterMs / 1000);
  if (err.code === 'quota_exceeded') return secondsUntilNextMonth();
  return undefined;
}

// ── Dashboard: engines ───────────────────────────────────────────────────────

export interface SearchEngineView {
  id: number;
  platform: string;
  engineId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel: string;
  creditsPerQuery: number | null;
  features: SearchEngineFeatures;
  premiumSince: string | null;
  /** premiumSince + 30 days: when a free install receives the engine. */
  freeFrom: string | null;
  isCustom: boolean;
  keyCount: number;
  healthyKeyCount: number;
  searchesThisMonth: number;
}

const FREE_LAG_MS = 30 * 24 * 60 * 60 * 1000;

export function listSearchEngines(): SearchEngineView[] {
  const db = getDb();
  const keyRows = db.prepare(`
    SELECT id, platform, enabled, status FROM api_keys
     WHERE platform = 'custom' OR platform IN (${[...SEARCH_ENGINE_PLATFORMS].map(() => '?').join(', ')})
  `).all(...SEARCH_ENGINE_PLATFORMS) as { id: number; platform: string; enabled: number; status: string }[];
  const healthy = (k: { enabled: number; status: string }) => isUsableKey(k);
  const monthCounts = new Map(
    (db.prepare(`
      SELECT platform, engine_id, COUNT(*) AS n FROM search_requests
       WHERE status = 'ok' AND created_at >= datetime('now', 'start of month')
       GROUP BY platform, engine_id
    `).all() as { platform: string; engine_id: string; n: number }[]).map(r => [`${r.platform}:${r.engine_id}`, r.n]),
  );

  return orderedEngines().map(row => {
    const meta = parseSearchMeta(row.meta_json);
    const keys = row.platform === 'custom'
      ? keyRows.filter(k => k.id === row.key_id)
      : keyRows.filter(k => k.platform === row.platform);
    const premiumSince = typeof meta.premiumSince === 'string' ? meta.premiumSince : null;
    const premiumMs = premiumSince ? Date.parse(premiumSince) : NaN;
    return {
      id: row.id,
      platform: row.platform,
      engineId: row.model_id,
      displayName: row.display_name,
      priority: row.effectivePriority,
      enabled: row.enabled === 1,
      quotaLabel: row.quota_label,
      creditsPerQuery: typeof meta.creditsPerQuery === 'number' ? meta.creditsPerQuery : null,
      features: meta.features ?? {},
      premiumSince,
      freeFrom: Number.isFinite(premiumMs) ? new Date(premiumMs + FREE_LAG_MS).toISOString() : null,
      isCustom: row.platform === 'custom',
      keyCount: keys.length,
      healthyKeyCount: keys.filter(healthy).length,
      searchesThisMonth: monthCounts.get(engineKey(row)) ?? 0,
    };
  });
}

/** Turn an engine on/off and/or move it to `priority` (0 = first/default).
 *  A move renumbers every engine 0..n-1 in the new order and stores that as
 *  the local order. Returns false when the id is not a search engine. */
export function updateSearchEngine(id: number, patch: { enabled?: boolean; priority?: number }): boolean {
  const db = getDb();
  const ordered = orderedEngines();
  const target = ordered.find(r => r.id === id);
  if (!target) return false;
  if (patch.enabled !== undefined) {
    db.prepare('UPDATE media_models SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
  }
  if (patch.priority !== undefined) {
    const rest = ordered.filter(r => r.id !== id);
    const index = Math.max(0, Math.min(Math.floor(patch.priority), rest.length));
    rest.splice(index, 0, target);
    const overrides: Record<string, number> = {};
    rest.forEach((r, i) => { overrides[engineKey(r)] = i; });
    setSetting(PRIORITY_OVERRIDES_SETTING, JSON.stringify(overrides));
  }
  return true;
}

// ── Dashboard: analytics ────────────────────────────────────────────────────

export type SearchAnalyticsRange = '24h' | '7d' | '30d' | '90d' | 'all';

export interface SearchAnalytics {
  total: number;
  today: number;
  successRate: number;
  avgLatencyMs: number;
  byEngine: Array<{ engineId: string; displayName: string; count: number }>;
  series: Array<{ date: string; engineId: string; count: number }>;
}

function rangeSince(range: SearchAnalyticsRange): string | null {
  const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 } as const;
  if (range === 'all') return null;
  const ms = Date.now() - days[range] * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Searches over a range: totals count successful searches; successRate and
 *  latency are over every attempt (a failed attempt that failed over is
 *  still a cost the operator wants to see). */
export function searchAnalytics(range: SearchAnalyticsRange): SearchAnalytics {
  const db = getDb();
  const since = rangeSince(range);
  const where = since ? 'WHERE created_at >= ?' : '';
  const args = since ? [since] : [];

  const totals = db.prepare(`
    SELECT COUNT(*) AS attempts,
           COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
           COALESCE(AVG(latency_ms), 0) AS avg_latency
      FROM search_requests ${where}
  `).get(...args) as { attempts: number; ok: number; avg_latency: number };
  const today = (db.prepare(`
    SELECT COUNT(*) AS n FROM search_requests WHERE status = 'ok' AND created_at >= datetime('now', 'start of day')
  `).get() as { n: number }).n;

  const names = new Map(allEngineRows().map(r => [r.model_id, r.display_name]));
  const byEngine = (db.prepare(`
    SELECT engine_id, COUNT(*) AS n FROM search_requests
     ${where ? `${where} AND` : 'WHERE'} status = 'ok'
     GROUP BY engine_id ORDER BY n DESC, engine_id
  `).all(...args) as { engine_id: string; n: number }[])
    .map(r => ({ engineId: r.engine_id, displayName: names.get(r.engine_id) ?? r.engine_id, count: r.n }));
  const series = (db.prepare(`
    SELECT date(created_at) AS day, engine_id, COUNT(*) AS n FROM search_requests
     ${where ? `${where} AND` : 'WHERE'} status = 'ok'
     GROUP BY day, engine_id ORDER BY day, engine_id
  `).all(...args) as { day: string; engine_id: string; n: number }[])
    .map(r => ({ date: r.day, engineId: r.engine_id, count: r.n }));

  return {
    total: totals.ok,
    today,
    // Percent, 0–100, one decimal: the same scale as the chat summary.
    successRate: totals.attempts > 0 ? Math.round((totals.ok / totals.attempts) * 1000) / 10 : 0,
    avgLatencyMs: Math.round(totals.avg_latency),
    byEngine,
    series,
  };
}

/** Search platforms are not chat providers; re-exported for routes that
 *  decorate the provider list. */
export { isSearchPlatform };
