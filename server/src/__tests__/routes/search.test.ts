import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns, setCooldown } from '../../services/ratelimit.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { seedSearchEngines } from '../helpers/search-engines.js';

// HTTP surface of web search (#1174): POST /v1/search and GET
// /v1/search/engines for API callers, /api/search/engines and
// /api/analytics/search for the dashboard, and the 'search' kind on the
// provider checklist.

const realFetch = globalThis.fetch;
let dashToken = '';

function addKey(platform: string): number {
  const { encrypted, iv, authTag } = encrypt(`${platform}-key`);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
  return Number(row.lastInsertRowid);
}

async function call(app: Express, method: string, path: string, opts: { body?: unknown; auth?: 'dash' | 'api' | null } = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = opts.auth === undefined ? (path.startsWith('/api') ? 'dash' : 'api') : opts.auth;
  if (auth === 'dash') headers.Authorization = `Bearer ${dashToken}`;
  if (auth === 'api') headers.Authorization = `Bearer ${getUnifiedApiKey()}`;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body, headers: res.headers };
}

function mockUpstream(handler: (url: string) => Response) {
  globalThis.fetch = vi.fn((url: string) => Promise.resolve(handler(String(url)))) as unknown as typeof fetch;
}

describe('search routes', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedSearchEngines();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('POST /v1/search requires the gateway key', async () => {
    const { status } = await call(app, 'POST', '/v1/search', { body: { query: 'q' }, auth: null });
    expect(status).toBe(401);
  });

  it('authenticates dashboard search diagnostics', async () => {
    expect((await call(app, 'GET', '/api/search/status', { auth: null })).status).toBe(401);
  });

  it('distinguishes missing engines from missing keys without making upstream calls', async () => {
    addKey('parallel'); addKey('keenable');
    setSetting('catalog_applied_tier', 'monthly'); setSetting('catalog_applied_version', 'test-free');
    setSetting('catalog_last_error', 'catalog signature verification failed');
    const upstream = vi.fn(); globalThis.fetch = upstream;
    const response = await call(app, 'GET', '/api/search/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.body).toMatchObject({ status: 'needs_configuration', missing_from_catalog: ['parallel', 'keenable'],
      catalog: { appliedTier: 'monthly', appliedVersion: 'test-free', lastError: 'catalog signature verification failed' } });
    expect(response.body.engines.every((e: any) => e.state === 'needs_key')).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform IN ('parallel','keenable')").get()).toEqual({ n: 0 });
  });

  it('updates readiness after key add, cooldown, disable and delete', async () => {
    const key = addKey('tavily');
    expect((await call(app, 'GET', '/api/search/status')).body.status).toBe('ready');
    setCooldown('tavily', 'tavily-search', key, 60_000);
    expect((await call(app, 'GET', '/api/search/status')).body.status).toBe('cooling_down');
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    getDb().prepare('UPDATE api_keys SET enabled=0 WHERE id=?').run(key);
    expect((await call(app, 'GET', '/api/search/status')).body.status).toBe('needs_configuration');
    getDb().prepare('DELETE FROM api_keys WHERE id=?').run(key);
    expect((await call(app, 'GET', '/api/search/status')).body.status).toBe('needs_configuration');
  });

  it('POST /v1/search returns a 503 with a code when no search key exists', async () => {
    const { status, body } = await call(app, 'POST', '/v1/search', { body: { query: 'q' } });
    expect(status).toBe(503);
    expect(body.error.code).toBe('no_search_keys');
  });

  it('POST /v1/search serves hits with provider and engine', async () => {
    addKey('tavily');
    mockUpstream(() => new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://t', content: 'c', score: 0.5 }] }), { status: 200 }));
    const { status, body } = await call(app, 'POST', '/v1/search', { body: { query: 'q', max_results: 2 } });
    expect(status).toBe(200);
    expect(body).toEqual({
      query: 'q',
      results: [{ title: 'T', url: 'https://t', content: 'c', score: 0.5 }],
      provider: 'tavily',
      engine: 'tavily-search',
    });
  });

  it('POST /v1/search forwards Retry-After when every engine is rate limited', async () => {
    addKey('tavily');
    mockUpstream(() => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }));
    const { status, headers, body } = await call(app, 'POST', '/v1/search', { body: { query: 'q' } });
    expect(status).toBe(429);
    expect(headers.get('retry-after')).toBe('7');
    expect(body.error.type).toBe('rate_limit_error');
  });

  it('GET /v1/search/engines lists the enabled engines and whether each is usable', async () => {
    addKey('exa');
    const { status, body } = await call(app, 'GET', '/v1/search/engines');
    expect(status).toBe(200);
    expect(body.data.map((e: any) => e.id)).toEqual(['tavily-search', 'exa-search', 'firecrawl-search', 'linkup-search']);
    expect(body.data.find((e: any) => e.id === 'exa-search').available).toBe(true);
    expect(body.data.find((e: any) => e.id === 'tavily-search').available).toBe(false);
  });

  it('GET/PATCH /api/search/engines lists, reorders and toggles engines', async () => {
    const list = await call(app, 'GET', '/api/search/engines');
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ engineId: 'tavily-search', priority: 0, enabled: true, keyCount: 0, isCustom: false });
    const firecrawl = list.body.find((e: any) => e.engineId === 'firecrawl-search');

    const moved = await call(app, 'PATCH', `/api/search/engines/${firecrawl.id}`, { body: { priority: 0, enabled: false } });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ engineId: 'firecrawl-search', priority: 0, enabled: false });

    const bad = await call(app, 'PATCH', `/api/search/engines/${firecrawl.id}`, { body: {} });
    expect(bad.status).toBe(400);
    const missing = await call(app, 'PATCH', '/api/search/engines/999999', { body: { enabled: true } });
    expect(missing.status).toBe(404);
  });

  it('tests a search engine using its search adapter, pinned to the selected row', async () => {
    addKey('tavily');
    addKey('exa');
    getDb().prepare("INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled) VALUES ('exa', 'tavily-search', 'Duplicate ID', 'search', -1, 1)").run();
    let requested = '';
    mockUpstream(url => { requested = url; return new Response(JSON.stringify({ results: [{ title: 'Example', url: 'https://example.com', content: 'ok' }] }), { headers: { 'content-type': 'application/json' } }); });
    const list = await call(app, 'GET', '/api/search/engines');
    const engine = list.body.find((e: any) => e.platform === 'tavily');
    const response = await call(app, 'POST', `/api/search/engines/${engine.id}/test`, { body: { query: 'example' } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ provider: 'tavily', engine: 'tavily-search' });
    expect(requested).toContain('/search');
  });

  it('GET /api/analytics/search returns the search summary', async () => {
    getDb().prepare(`INSERT INTO search_requests (engine_id, platform, status, latency_ms, result_count) VALUES ('exa-search', 'exa', 'ok', 300, 5)`).run();
    const { status, body } = await call(app, 'GET', '/api/analytics/search?range=30d');
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 1, successRate: 100, avgLatencyMs: 300 });
    expect(body.byEngine).toEqual([{ engineId: 'exa-search', displayName: 'Exa Search', count: 1 }]);
  });

  it('marks search platforms on the provider checklist and keeps engines off the media list', async () => {
    const providers = await call(app, 'GET', '/api/keys/providers');
    const kinds = Object.fromEntries(providers.body.providers.map((p: any) => [p.platform, p.kind]));
    expect(kinds).toMatchObject({ tavily: 'search', exa: 'search', firecrawl: 'search', linkup: 'search', groq: 'chat' });

    const media = await call(app, 'GET', '/api/media');
    expect(media.body.models.some((m: any) => m.modality === 'search')).toBe(false);
  });

  it('registers a custom search relay through POST /api/media/custom', async () => {
    const created = await call(app, 'POST', '/api/media/custom', {
      body: { baseUrl: 'https://search.example.com', model: 'my-searxng', modality: 'search', apiKey: 'k' },
    });
    expect(created.status).toBe(201);
    const engines = await call(app, 'GET', '/api/search/engines');
    expect(engines.body.find((e: any) => e.engineId === 'my-searxng')).toMatchObject({ isCustom: true, keyCount: 1 });
  });

  it('serves POST /v1/search from a registered custom relay before any catalog engine (#1777)', async () => {
    // A catalog engine with a key is present on purpose: the custom relay
    // must win the chain, so Tavily must never be called at all.
    addKey('tavily');
    const created = await call(app, 'POST', '/api/media/custom', {
      body: { baseUrl: 'https://relay.example.com/v1', model: 'my-relay', modality: 'search', apiKey: 'relay-secret' },
    });
    expect(created.status).toBe(201);

    const upstreamCalls: Array<{ url: string; body: any; auth: string | null }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      const urlStr = String(url);
      if (!urlStr.startsWith('https://relay.example.com')) {
        throw new Error(`unexpected upstream call to ${urlStr} — the custom relay should have answered first`);
      }
      upstreamCalls.push({
        url: urlStr,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('Authorization'),
      });
      return new Response(JSON.stringify({
        results: [{ title: 'Paris', url: 'https://paris.example', content: 'Capital of France.', score: 0.9 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const { status, body } = await call(app, 'POST', '/v1/search', { body: { query: 'capital of France', max_results: 2 } });
    expect(status).toBe(200);
    expect(body).toEqual({
      query: 'capital of France',
      results: [{ title: 'Paris', url: 'https://paris.example', content: 'Capital of France.', score: 0.9 }],
      provider: 'custom',
      engine: 'my-relay',
    });
    // Exactly one upstream call, Tavily-shaped, to the relay — and only the relay.
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe('https://relay.example.com/v1/search');
    expect(upstreamCalls[0].body).toMatchObject({ query: 'capital of France', max_results: 2 });
    expect(upstreamCalls[0].auth).toBe('Bearer relay-secret');
  });
});
