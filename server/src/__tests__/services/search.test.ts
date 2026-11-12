import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns, getProbeableCooldowns } from '../../services/ratelimit.js';
import {
  runSearch,
  SearchError,
  listSearchEngines,
  updateSearchEngine,
  searchAnalytics,
  searchAvailable,
  decodeEntities,
} from '../../services/search.js';
import { SEARCH_PLATFORMS as SHARED_SEARCH_PLATFORMS } from '../../../../shared/types.js';
import { SEARCH_PLATFORMS } from '../../lib/search-platforms.js';
import { seedSearchEngines } from '../helpers/search-engines.js';

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
  return Number(row.lastInsertRowid);
}

function addCustomRelay(baseUrl: string, engineId = 'my-relay'): number {
  const { encrypted, iv, authTag } = encrypt('relay-key');
  const key = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'relay', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, baseUrl);
  const keyId = Number(key.lastInsertRowid);
  getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
    VALUES ('custom', ?, ?, 'search', 99, 1, 'custom endpoint', ?)
  `).run(engineId, engineId, keyId);
  return keyId;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Call = [string, RequestInit];
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(url, init)));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const calls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls as unknown as Call[];
const bodyOf = (call: Call) => JSON.parse(call[1].body as string);

function logRows() {
  return getDb().prepare('SELECT engine_id, platform, status, result_count FROM search_requests ORDER BY id').all() as
    Array<{ engine_id: string; platform: string; status: string; result_count: number }>;
}

describe('search platforms', () => {
  it('server runtime list matches the shared list', () => {
    expect([...SEARCH_PLATFORMS]).toEqual([...SHARED_SEARCH_PLATFORMS]);
  });
});

describe('search service', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedSearchEngines();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('lists the catalog engines in priority order', () => {
    expect(listSearchEngines().map(e => e.engineId)).toEqual(['tavily-search', 'exa-search', 'firecrawl-search', 'linkup-search']);
    expect(searchAvailable()).toBe(false);
  });

  it('answers 503 no_search_keys when no engine has a key', async () => {
    await expect(runSearch('q')).rejects.toMatchObject({ status: 503, code: 'no_search_keys' });
  });

  it('skips engines without keys and maps Exa hits (text → content, rank scores)', async () => {
    addKey('exa');
    const fn = mockFetch(() => json({
      results: [
        { title: 'A', url: 'https://a', text: 'alpha' },
        { title: 'no url', text: 'x' },
        { title: 'B', url: 'https://b', text: 'beta' },
      ],
    }));
    const out = await runSearch('what', { topic: 'news', maxResults: 3 });
    expect(calls(fn)).toHaveLength(1);
    expect(calls(fn)[0][0]).toBe('https://api.exa.ai/search');
    expect(new Headers(calls(fn)[0][1].headers).get('x-api-key')).toBe('exa-test-key');
    expect(bodyOf(calls(fn)[0])).toMatchObject({ query: 'what', numResults: 3, category: 'news' });
    expect(out).toMatchObject({ provider: 'exa', engine: 'exa-search' });
    expect(out.results).toEqual([
      { title: 'A', url: 'https://a', content: 'alpha', score: 1 },
      { title: 'B', url: 'https://b', content: 'beta', score: 0.5 },
    ]);
    expect(logRows()).toEqual([{ engine_id: 'exa-search', platform: 'exa', status: 'ok', result_count: 2 }]);
  });

  it('passes Tavily topic/answer through and keeps its scores', async () => {
    addKey('tavily');
    const fn = mockFetch(() => json({ answer: '42', results: [{ title: 'T', url: 'https://t', content: 'c', score: 0.83 }] }));
    const out = await runSearch('q', { includeAnswer: true, topic: 'general' });
    expect(calls(fn)[0][0]).toBe('https://api.tavily.com/search');
    expect(bodyOf(calls(fn)[0])).toEqual({ query: 'q', max_results: 5, topic: 'general', include_answer: true });
    expect(out.answer).toBe('42');
    expect(out.results[0].score).toBe(0.83);
  });

  it('maps Firecrawl news hits and Linkup sourced answers', async () => {
    addKey('firecrawl');
    let fn = mockFetch(() => json({ success: true, data: { news: [{ title: 'N', url: 'https://n', snippet: 'fresh' }] } }));
    let out = await runSearch('q', { topic: 'news' });
    expect(bodyOf(calls(fn)[0])).toMatchObject({ query: 'q', limit: 5, sources: ['news'] });
    expect(out.results).toEqual([{ title: 'N', url: 'https://n', content: 'fresh', score: 1 }]);

    updateSearchEngine(listSearchEngines().find(e => e.engineId === 'firecrawl-search')!.id, { enabled: false });
    addKey('linkup');
    fn = mockFetch(() => json({ answer: 'yes', sources: [{ name: 'S', url: 'https://s', snippet: 'src' }] }));
    out = await runSearch('q', { includeAnswer: true });
    expect(calls(fn)[0][0]).toBe('https://api.linkup.so/v1/search');
    expect(bodyOf(calls(fn)[0])).toMatchObject({ q: 'q', depth: 'standard', outputType: 'sourcedAnswer', maxResults: 5 });
    expect(out).toMatchObject({ answer: 'yes', provider: 'linkup', results: [{ title: 'S', url: 'https://s', content: 'src' }] });
  });

  describe('Parallel (keyless)', () => {
    function seedParallel(): void {
      getDb().prepare(`
        INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
        VALUES ('parallel', 'parallel-search', 'Parallel Search', 'search', 4, 1, 'Free, no key needed', '{}')
      `).run();
    }
    const mcpReply = (payload: unknown) => ({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    });
    const hits = { results: [
      { url: 'https://a', title: 'A &amp; B', excerpts: ['one', 'two'] },
      { url: 'https://b', title: null, excerpts: [] },
      { url: '', title: 'dropped', excerpts: ['x'] },
    ] };

    it('searches anonymously over MCP with the stored sentinel and maps excerpts', async () => {
      seedParallel();
      addKey('parallel', 'no-key');
      expect(searchAvailable()).toBe(true);
      const fn = mockFetch(() => json(mcpReply(hits)));
      const out = await runSearch('node version');
      const [url, init] = calls(fn)[0];
      expect(url).toBe('https://search.parallel.ai/mcp');
      expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
      const body = bodyOf(calls(fn)[0]);
      expect(body).toMatchObject({ method: 'tools/call', params: { name: 'web_search', arguments: { objective: 'node version', search_queries: ['node version'] } } });
      expect(body.params.arguments.session_id).toMatch(/^freellmapi-/);
      expect(out).toMatchObject({ provider: 'parallel', engine: 'parallel-search' });
      expect(out.results).toEqual([
        { title: 'A & B', url: 'https://a', content: 'one … two', score: 1 },
        { title: 'https://b', url: 'https://b', content: '', score: 0.5 },
      ]);
    });

    it('reads an MCP reply sent as an event stream', async () => {
      seedParallel();
      addKey('parallel', 'no-key');
      mockFetch(() => new Response(`event: message\ndata: ${JSON.stringify(mcpReply(hits))}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
      const out = await runSearch('q');
      expect(out.results.map(r => r.url)).toEqual(['https://a', 'https://b']);
    });

    it('uses the REST API with x-api-key when a real key is stored', async () => {
      seedParallel();
      addKey('parallel', 'real-parallel-key');
      const fn = mockFetch(() => json(hits));
      const out = await runSearch('q', { maxResults: 1 });
      const [url, init] = calls(fn)[0];
      expect(url).toBe('https://api.parallel.ai/v1/search');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('real-parallel-key');
      expect(bodyOf(calls(fn)[0])).toEqual({ objective: 'q', search_queries: ['q'], mode: 'fast', advanced_settings: { max_results: 1 } });
      expect(out.results).toHaveLength(1);
    });

    it('turns an MCP rate-limit tool error into a retryable 429', async () => {
      seedParallel();
      addKey('parallel', 'no-key');
      mockFetch(() => json({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded for free tier' }] } }));
      await expect(runSearch('q')).rejects.toMatchObject({ status: 429 });
      expect(logRows()).toEqual([expect.objectContaining({ platform: 'parallel', status: 'error' })]);
    });

    it('fails over to the next engine when the MCP call errors', async () => {
      seedParallel();
      addKey('parallel', 'no-key');
      addKey('tavily');
      updateSearchEngine(listSearchEngines().find(e => e.engineId === 'parallel-search')!.id, { priority: 0 });
      mockFetch(url => url.startsWith('https://search.parallel.ai')
        ? json({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'internal error' } })
        : json({ results: [{ title: 'T', url: 'https://t', content: 'c' }] }));
      const out = await runSearch('q');
      expect(out.provider).toBe('tavily');
    });
  });

  it('tries a custom relay before the catalog engines', async () => {
    addKey('tavily');
    addCustomRelay('https://relay.example/v1');
    const fn = mockFetch(url => url.startsWith('https://relay.example')
      ? json({ error: 'down' }, 500)
      : json({ results: [{ title: 'T', url: 'https://t', content: 'c', score: 1 }] }));
    const out = await runSearch('q');
    expect(calls(fn).map(c => c[0])).toEqual(['https://relay.example/v1/search', 'https://api.tavily.com/search']);
    expect(out.provider).toBe('tavily');
    expect(logRows().map(r => `${r.platform}:${r.status}`)).toEqual(['custom:error', 'tavily:ok']);
  });

  it('cools a rate-limited key down and fails over to the next engine', async () => {
    const tavilyKey = addKey('tavily');
    addKey('exa');
    const fn = mockFetch(url => url.includes('tavily')
      ? json({ detail: 'slow down' }, 429, { 'retry-after': '120' })
      : json({ results: [{ title: 'E', url: 'https://e', text: 'x' }] }));
    expect((await runSearch('q')).provider).toBe('exa');
    // Retry-After is the provider's own retry time, so the prober never clears it early.
    expect(getProbeableCooldowns().some(c => c.keyId === tavilyKey)).toBe(false);
    // The benched Tavily key is skipped on the next search.
    await runSearch('q2');
    expect(calls(fn).map(c => new URL(c[0]).host)).toEqual(['api.tavily.com', 'api.exa.ai', 'api.exa.ai']);
  });

  it('tries every key of an engine before moving on, and benches spent credits', async () => {
    addKey('tavily', 'spent');
    addKey('tavily', 'fresh');
    const fn = mockFetch((_url, init) => new Headers(init.headers).get('Authorization') === 'Bearer spent'
      ? json({ detail: 'plan limit' }, 432)
      : json({ results: [{ title: 'T', url: 'https://t', content: 'c' }] }));
    const out = await runSearch('q');
    expect(out.provider).toBe('tavily');
    await runSearch('q');
    const auths = calls(fn).map(c => new Headers(c[1].headers).get('Authorization'));
    // At most one attempt on the spent key, whichever order the keys came in.
    expect(auths.filter(a => a === 'Bearer spent').length).toBeLessThanOrEqual(1);
    expect(auths.at(-1)).toBe('Bearer fresh');
  });

  it('returns 429 with the soonest Retry-After when every engine is rate limited', async () => {
    addKey('tavily');
    addKey('exa');
    mockFetch(url => json({}, 429, { 'retry-after': url.includes('exa') ? '30' : '90' }));
    const err = await runSearch('q').catch(e => e) as SearchError;
    expect(err).toBeInstanceOf(SearchError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('reports a provider 401 as a 502, never as the caller’s auth failure', async () => {
    addKey('tavily');
    mockFetch(() => json({ detail: 'bad key' }, 401));
    await expect(runSearch('q')).rejects.toMatchObject({ status: 502 });
    // The rejected key is benched, so the next search is a retryable 429.
    await expect(runSearch('q')).rejects.toMatchObject({ status: 429, code: 'search_keys_cooling_down' });
  });

  it('pins an engine by id and rejects unknown or disabled ones', async () => {
    addKey('tavily');
    addKey('exa');
    const fn = mockFetch(() => json({ results: [{ title: 'E', url: 'https://e', text: 'x' }] }));
    expect((await runSearch('q', { engine: 'exa-search' })).engine).toBe('exa-search');
    expect(calls(fn)).toHaveLength(1);
    await expect(runSearch('q', { engine: 'nope' })).rejects.toMatchObject({ status: 400 });
    updateSearchEngine(listSearchEngines().find(e => e.engineId === 'exa-search')!.id, { enabled: false });
    await expect(runSearch('q', { engine: 'exa-search' })).rejects.toMatchObject({ status: 400 });
  });

  it('reorders engines locally and lists key and usage counts', async () => {
    addKey('linkup');
    const linkup = listSearchEngines().find(e => e.engineId === 'linkup-search')!;
    expect(updateSearchEngine(linkup.id, { priority: 0 })).toBe(true);
    const order = listSearchEngines();
    expect(order.map(e => e.engineId)).toEqual(['linkup-search', 'tavily-search', 'exa-search', 'firecrawl-search']);
    expect(order.map(e => e.priority)).toEqual([0, 1, 2, 3]);
    expect(order[0]).toMatchObject({ keyCount: 1, healthyKeyCount: 1, searchesThisMonth: 0, isCustom: false });

    mockFetch(() => json({ results: [{ type: 'text', name: 'L', url: 'https://l', content: 'c' }] }));
    await runSearch('q');
    expect(listSearchEngines()[0].searchesThisMonth).toBe(1);
    expect(updateSearchEngine(999_999, { enabled: false })).toBe(false);
  });

  it('derives freeFrom 30 days after premiumSince', () => {
    getDb().prepare(`UPDATE media_models SET meta_json = ? WHERE model_id = 'exa-search'`)
      .run(JSON.stringify({ premiumSince: '2026-10-13T00:00:00.000Z' }));
    const exa = listSearchEngines().find(e => e.engineId === 'exa-search')!;
    expect(exa.freeFrom).toBe('2026-11-12T00:00:00.000Z');
  });

  it('summarises searches per engine and per day', async () => {
    addKey('tavily');
    addKey('exa');
    mockFetch(url => url.includes('tavily')
      ? json({}, 500)
      : json({ results: [{ title: 'E', url: 'https://e', text: 'x' }] }));
    await runSearch('a');
    await runSearch('b');
    const stats = searchAnalytics('7d');
    expect(stats.total).toBe(2);
    expect(stats.today).toBe(2);
    expect(stats.successRate).toBe(50);
    expect(stats.byEngine).toEqual([{ engineId: 'exa-search', displayName: 'Exa Search', count: 2 }]);
    expect(stats.series).toHaveLength(1);
    expect(stats.series[0]).toMatchObject({ engineId: 'exa-search', count: 2 });
  });
});

describe('decodeEntities', () => {
  it('turns HTML entities in titles into plain text', () => {
    expect(decodeEntities('Quelle est la capitale de l&#039;Australie ?')).toBe("Quelle est la capitale de l'Australie ?");
    expect(decodeEntities('Tom &amp; Jerry &quot;live&quot; &#x2014; &nbsp;ok')).toBe('Tom & Jerry "live" \u2014  ok');
    expect(decodeEntities('&bogus; stays')).toBe('&bogus; stays');
    expect(decodeEntities('plain')).toBe('plain');
  });
});
