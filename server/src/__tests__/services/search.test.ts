import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns, isOnCooldown, setCooldown } from '../../services/ratelimit.js';
import { getProvider } from '../../providers/index.js';
import { BraveProvider } from '../../providers/brave.js';
import {
  runSearch,
  SearchError,
  listSearchEngines,
  updateSearchEngine,
  searchAnalytics,
  searchAvailable,
  decodeEntities,
  searchStatus,
  noSearchMessage,
  SEARCH_PLATFORM_INFO,
} from '../../services/search.js';
import { SEARCH_PLATFORMS as SHARED_SEARCH_PLATFORMS } from '../../../../shared/types.js';
import { SEARCH_PLATFORMS } from '../../lib/search-platforms.js';
import { seedSearchEngines } from '../helpers/search-engines.js';
import { clearLastHealthyStampState } from '../../services/health.js';

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

  it('a served search marks the key as working; a failed one does not (#1493)', async () => {
    clearLastHealthyStampState();
    const good = addKey('exa');
    getDb().prepare("UPDATE api_keys SET status = 'unknown' WHERE id = ?").run(good);
    mockFetch(() => json({ results: [{ title: 'A', url: 'https://a', text: 'alpha' }] }));
    await runSearch('q');
    expect(getDb().prepare('SELECT status, last_healthy_at FROM api_keys WHERE id = ?').get(good))
      .toMatchObject({ status: 'healthy', last_healthy_at: expect.any(String) });

    getDb().prepare('DELETE FROM api_keys').run();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    const bad = addKey('exa');
    mockFetch(() => json({ error: 'boom' }, 500));
    await expect(runSearch('q')).rejects.toBeInstanceOf(SearchError);
    expect(getDb().prepare('SELECT last_healthy_at FROM api_keys WHERE id = ?').get(bad)).toEqual({ last_healthy_at: null });
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

  describe('Brave (#1641)', () => {
    const badKey = { error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'The provided subscription token is invalid.', status: 422 }, type: 'ErrorResponse' };
    beforeEach(() => {
      getDb().prepare(`
        INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
        VALUES ('brave', 'brave-search', 'Brave Search', 'search', -1, 1, 'free monthly credits', '{}')
      `).run();
    });

    it('searches web and news with the subscription token and maps hits', async () => {
      addKey('brave');
      let fn = mockFetch(() => json({ web: { results: [{ title: 'A &amp; B', url: 'https://a', description: 'alpha' }, { title: 'no url' }] } }));
      let out = await runSearch('cats & dogs', { maxResults: 3 });
      const url = new URL(calls(fn)[0][0]);
      expect(`${url.origin}${url.pathname}`).toBe('https://api.search.brave.com/res/v1/web/search');
      expect(url.searchParams.get('q')).toBe('cats & dogs');
      expect(url.searchParams.get('count')).toBe('3');
      // Brave decorates matched terms with <strong> unless asked not to;
      // without this the hits carry raw markup every other engine never emits.
      expect(url.searchParams.get('text_decorations')).toBe('false');
      expect(new Headers(calls(fn)[0][1].headers).get('x-subscription-token')).toBe('brave-test-key');
      expect(out).toMatchObject({ provider: 'brave', engine: 'brave-search', results: [{ title: 'A & B', url: 'https://a', content: 'alpha', score: 1 }] });

      fn = mockFetch(() => json({ results: [{ title: 'N', url: 'https://n', description: 'fresh' }] }));
      out = await runSearch('q', { topic: 'news' });
      expect(new URL(calls(fn)[0][0]).pathname).toBe('/res/v1/news/search');
      expect(out.results).toEqual([{ title: 'N', url: 'https://n', content: 'fresh', score: 1 }]);
    });

    it('benches a key Brave rejects (422 SUBSCRIPTION_TOKEN_INVALID), but not a key whose request was refused (422 VALIDATION)', async () => {
      const key = addKey('brave');
      mockFetch(() => json({ error: { code: 'VALIDATION', detail: 'Unable to validate request parameter(s)', status: 422 } }, 422));
      await expect(runSearch('q', { engine: 'brave-search' })).rejects.toBeInstanceOf(SearchError);
      expect(isOnCooldown('brave', 'brave-search', key)).toBe(false);

      mockFetch(() => json(badKey, 422));
      await expect(runSearch('q', { engine: 'brave-search' })).rejects.toBeInstanceOf(SearchError);
      expect(isOnCooldown('brave', 'brave-search', key)).toBe(true);
    });

    it('cools a rate-limited key down only for the one-second burst window', async () => {
      const key = addKey('brave');
      mockFetch(() => json({ error: { code: 'RATE_LIMITED', detail: 'Request rate limit exceeded for plan' } }, 429));
      await expect(runSearch('q', { engine: 'brave-search' })).rejects.toBeInstanceOf(SearchError);
      expect(isOnCooldown('brave', 'brave-search', key)).toBe(true);
      const later = Date.now() + 2_000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      expect(isOnCooldown('brave', 'brave-search', key)).toBe(false);
    });

    it('parks a key whose monthly credit is spent (429 QUOTA_LIMITED) for the long credit cooldown', async () => {
      const key = addKey('brave');
      mockFetch(() => json({ error: { code: 'QUOTA_LIMITED', detail: 'Request quota limit exceeded for plan' } }, 429));
      await expect(runSearch('q', { engine: 'brave-search' })).rejects.toBeInstanceOf(SearchError);
      const later = Date.now() + 60 * 60_000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      expect(isOnCooldown('brave', 'brave-search', key)).toBe(true);
    });

    it('validates a key with a free no-query request: bad token is invalid, VALIDATION means the key is fine', async () => {
      const brave = new BraveProvider();
      mockFetch(() => json(badKey, 422));
      expect(await brave.validateKey('bad')).toMatchObject({ valid: false });
      mockFetch(() => json({ error: { code: 'VALIDATION', detail: 'Unable to validate request parameter(s)', status: 422 } }, 422));
      expect(await brave.validateKey('good')).toBe(true);
      expect(brave.supportsKeyPolling).toBe(false);
    });
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

  describe('Keenable (keyless)', () => {
    function seedKeenable(): void {
      getDb().prepare(`
        INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
        VALUES ('keenable', 'keenable-search', 'Keenable Search', 'search', 5, 1, 'Free, no key needed', '{}')
      `).run();
    }
    const hits = { results: [
      { url: 'https://a', title: 'A &amp; B', description: '', snippet: 'one', published_at: '2026-05-05T00:00:00Z' },
      { url: 'https://b', title: '', description: '', snippet: 'x'.repeat(2_000) },
      { url: '', title: 'dropped', description: '', snippet: 'x' },
    ] };

    it('searches the public endpoint with the stored sentinel and maps snippets', async () => {
      seedKeenable();
      addKey('keenable', 'no-key');
      expect(searchAvailable()).toBe(true);
      const fn = mockFetch(() => json(hits));
      const out = await runSearch('node version');
      const [url, init] = calls(fn)[0];
      expect(url).toBe('https://api.keenable.ai/v1/search/public');
      expect((init.headers as Record<string, string>)['X-Keenable-Title']).toBe('freellmapi');
      expect((init.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
      expect(bodyOf(calls(fn)[0])).toEqual({ query: 'node version', max_results: 5 });
      expect(out).toMatchObject({ provider: 'keenable', engine: 'keenable-search' });
      expect(out.results).toEqual([
        { title: 'A & B', url: 'https://a', content: 'one', score: 1 },
        { title: 'https://b', url: 'https://b', content: `${'x'.repeat(1_500)}…`, score: 0.5 },
      ]);
    });

    it('uses the keyed endpoint with X-API-Key when a real key is stored', async () => {
      seedKeenable();
      addKey('keenable', 'real-keenable-key');
      const fn = mockFetch(() => json(hits));
      const out = await runSearch('q', { maxResults: 1 });
      const [url, init] = calls(fn)[0];
      expect(url).toBe('https://api.keenable.ai/v1/search');
      expect((init.headers as Record<string, string>)['X-API-Key']).toBe('real-keenable-key');
      expect(bodyOf(calls(fn)[0])).toEqual({ query: 'q', max_results: 1 });
      expect(out.results).toHaveLength(1);
    });

    it('cools a rate-limited keyless row down and fails over to the next engine', async () => {
      seedKeenable();
      addKey('keenable', 'no-key');
      addKey('tavily');
      updateSearchEngine(listSearchEngines().find(e => e.engineId === 'keenable-search')!.id, { priority: 0 });
      const fn = mockFetch(url => url.startsWith('https://api.keenable.ai')
        ? json({ error: 'Too many requests' }, 429, { 'retry-after': '30' })
        : json({ results: [{ title: 'T', url: 'https://t', content: 'c' }] }));
      expect((await runSearch('q')).provider).toBe('tavily');
      // The benched Keenable row is skipped on the next search.
      await runSearch('q2');
      expect(calls(fn).map(c => new URL(c[0]).host)).toEqual(['api.keenable.ai', 'api.tavily.com', 'api.tavily.com']);
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
    addKey('tavily');
    addKey('exa');
    const fn = mockFetch(url => url.includes('tavily')
      ? json({ detail: 'slow down' }, 429, { 'retry-after': '120' })
      : json({ results: [{ title: 'E', url: 'https://e', text: 'x' }] }));
    expect((await runSearch('q')).provider).toBe('exa');
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

  it('reads a back-off stated in the error body when there is no header', async () => {
    addKey('tavily');
    // Tavily states its cap in prose; Exa in a RetryInfo-shaped field. With no
    // Retry-After header, the chain used to fall back to the 60s heuristic.
    mockFetch(() => new Response('too many requests, try again in 15 seconds', { status: 429 }));
    const err = await runSearch('q').catch(e => e) as SearchError;
    expect(err).toBeInstanceOf(SearchError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(15_000);
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
  it('leaves lone-surrogate entities verbatim instead of corrupting the string', () => {
    // Obfuscated-email bait on scraped pages renders as a lone surrogate
    // entity. String.fromCodePoint happily "decodes" it, producing a string
    // that is not valid UTF-16: JSON.stringify turns it into U+FFFD escapes
    // and strict encoders/serialisers choke on it. The entity must survive
    // untouched, exactly like the out-of-range case (&#x110000;).
    expect(decodeEntities('contact &#xD800; us')).toBe('contact &#xD800; us');
    expect(decodeEntities('tail &#xDFFF; end')).toBe('tail &#xDFFF; end');
    expect(decodeEntities('&#65533;?')).toBe('\uFFFD?'); // real replacement char still decodes
    expect(decodeEntities('&#x110000; too big')).toBe('&#x110000; too big');
    expect(decodeEntities('&#x1F600; emoji')).toBe('\u{1F600} emoji');
  });
});

describe('search status and the no-engine message', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedSearchEngines();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  });

  const addEngine = (platform: string, engineId: string, enabled = 1) => getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES (?, ?, ?, 'search', 10, ?, 'free')
  `).run(platform, engineId, engineId, enabled);

  it('covers every search platform and matches each provider\'s keyless flag', () => {
    expect(Object.keys(SEARCH_PLATFORM_INFO).sort()).toEqual([...SEARCH_PLATFORMS].sort());
    for (const p of SEARCH_PLATFORMS) {
      expect(Boolean(SEARCH_PLATFORM_INFO[p]!.keyless), p).toBe(Boolean(getProvider(p)?.keyless));
    }
  });

  it('separates keyless keys whose engine is missing from the installed catalog', async () => {
    // Free catalog without Parallel or Keenable rows, both set up keyless.
    addKey('parallel', 'no-key');
    addKey('keenable', 'no-key');
    const s = searchStatus();
    expect(s.status).toBe('needs_configuration');
    expect(s.missing_from_catalog).toEqual(['parallel', 'keenable']);
    expect(s.engines.map(e => e.state)).toEqual(['needs_key', 'needs_key', 'needs_key', 'needs_key']);
    const msg = noSearchMessage(s);
    expect(msg).toContain('Parallel and Keenable are set up on the Keys page, but the installed catalog has no engines for them yet');
    expect(msg).toContain('add a Tavily, Exa, Firecrawl or Linkup key');
    expect(msg).not.toContain('no key needed');
    await expect(runSearch('q')).rejects.toMatchObject({ status: 503, code: 'no_search_keys', message: msg });
  });

  it('offers a keyless engine only when the installed catalog has it', () => {
    addEngine('keenable', 'keenable-search');
    expect(noSearchMessage()).toContain('add Keenable (no key needed), or add a Tavily, Exa, Firecrawl or Linkup key on the Keys page');
    expect(searchStatus().missing_from_catalog).toEqual([]);
  });

  it('reports failed keys, turned-off engines and cooldowns per engine', () => {
    const exa = addKey('exa');
    getDb().prepare("UPDATE api_keys SET status = 'invalid' WHERE platform = 'exa'").run();
    addKey('linkup');
    getDb().prepare("UPDATE media_models SET enabled = 0 WHERE platform = 'linkup'").run();
    const tavily = addKey('tavily');
    setCooldown('tavily', 'tavily-search', tavily, 60_000);
    const s = searchStatus();
    expect(Object.fromEntries(s.engines.map(e => [e.platform, e.state]))).toEqual({
      tavily: 'cooling_down', exa: 'key_error', firecrawl: 'needs_key', linkup: 'disabled',
    });
    expect(s.status).toBe('cooling_down');
    const msg = noSearchMessage(s);
    expect(msg).toContain('The Exa key failed its last check');
    expect(msg).toContain('Turned off under Models → Search: Linkup.');
    expect(exa).toBeGreaterThan(0);
  });

  it('is ready once one engine has a usable key', () => {
    addKey('firecrawl');
    expect(searchStatus().status).toBe('ready');
  });
});
