import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runDecision, DECISION_PLATFORMS } from '../../services/decision.js';
import { runSearch, SEARCH_ENGINE_PLATFORMS } from '../../services/search.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { checkAllKeys, checkKeyHealth, probeKeyValidity } from '../../services/health.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const request = { state: 'Invoice charged twice', questions: { billing: { type: 'noul' as const, instructions: 'Billing issue?' } } };
const answers = { billing: { type: 'noul', noul: 0.98 } };
function seed(platform: string, id: string, modality: string) {
  const { encrypted, iv, authTag } = encrypt('unit-test-key');
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'test', ?, ?, ?, 'healthy', 1)`)
    .run(platform, encrypted, iv, authTag);
  getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label) VALUES (?, ?, ?, ?, 0, 1, 'test')`)
    .run(platform, id, id, modality);
}
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  clearAllCooldowns(Number.MAX_SAFE_INTEGER);
});
afterEach(() => vi.restoreAllMocks());

describe('BeatAPI decision dispatch', () => {
  it.each(['jev-1.13-free', 'jev-1.14-free'])('uses the tested System One contract for %s', async model => {
    seed('beatapi', model, 'decision');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model, answers, usage: { input_tokens: 335, output_tokens: 47 } }));
    expect(DECISION_PLATFORMS.has('beatapi')).toBe(true);
    expect(await runDecision(request, { model })).toEqual({ provider: 'beatapi', model, answers, usage: { input_tokens: 335, output_tokens: 47 } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.beatapi.io/v1/systemone');
    expect(JSON.parse(String(init?.body))).toEqual({ model, ...request });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-test-key');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'beatapi'").get()).toEqual({ n: 0 });
  });

  it.each([
    { model: 'other', answers }, { answers }, { model: 'jev-1.14-free', answers: {} },
    { model: 'jev-1.14-free', answers: { billing: { type: 'noul', noul: 'yes' } } },
    { model: 'jev-1.14-free', answers, error: { message: 'failed' } },
  ])('fails closed on substituted, incomplete or malformed decisions', async body => {
    seed('beatapi', 'jev-1.14-free', 'decision');
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runDecision(request, { model: 'jev-1.14-free' })).rejects.toMatchObject({ status: 502 });
  });

  it('preserves BeatAPI body-stated account throttling', async () => {
    seed('beatapi', 'jev-1.14-free', 'decision');
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { retry_after_seconds: 60 } }, 429));
    await expect(runDecision(request, { model: 'jev-1.14-free' })).rejects.toMatchObject({ status: 429, retryAfterMs: 60_000 });
  });
});

// #1599: SerpSearch's maintainer asked for no empty-query requests, so no
// health path may send one, and a real search is what marks the key working.
it('never sends a request to check a SerpSearch key, and a real search marks it healthy', async () => {
  seed('serpsearch', 'serpsearch-search', 'search');
  const db = getDb();
  db.prepare("UPDATE api_keys SET status = 'unknown' WHERE platform = 'serpsearch'").run();
  const { id } = db.prepare("SELECT id FROM api_keys WHERE platform = 'serpsearch'").get() as { id: number };
  const fetch = vi.spyOn(global, 'fetch');
  vi.spyOn(console, 'log').mockImplementation(() => {});

  expect(await checkKeyHealth(id)).toBe('unknown');
  await checkAllKeys({ force: true, manual: true });
  expect(await probeKeyValidity(id)).toBe('error');
  expect(fetch).not.toHaveBeenCalled();

  fetch.mockResolvedValue(json({ organic_results: [{ title: 'Cats', url: 'https://example.com/cats', description: 'Cats.' }] }));
  await runSearch('cats', { engine: 'serpsearch-search', maxResults: 1 });
  expect(String(fetch.mock.calls[0][0])).toContain('query=cats');
  expect(db.prepare('SELECT status FROM api_keys WHERE id = ?').get(id)).toEqual({ status: 'healthy' });
});

describe('SerpSearch dispatch', () => {
  beforeEach(() => seed('serpsearch', 'serpsearch-search', 'search'));

  it('encodes the query, normalizes organic results and respects maxResults', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ organic_results: [
      { title: 'A &amp; B', url: 'https://example.com/a', description: 'snippet' },
      { title: 'Unsafe', url: 'javascript:alert(1)' },
      { title: 'C', url: 'https://example.com/c' },
    ] }));
    const result = await runSearch('cats & dogs #1', { engine: 'serpsearch-search', maxResults: 1 });
    expect(SEARCH_ENGINE_PLATFORMS.has('serpsearch')).toBe(true);
    expect(result.results).toEqual([{ title: 'A & B', url: 'https://example.com/a', content: 'snippet', score: 1 }]);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('query')).toBe('cats & dogs #1');
    expect(new URL(String(url)).pathname).toBe('/api/v1/search');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-test-key');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('flattens news groups without inventing summaries', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json([{ group_name: 'Ungrouped', articles: [{ title: 'News', url: 'https://example.com/news', created_at: 1792145760 }] }]));
    const out = await runSearch('AI', { engine: 'serpsearch-search', topic: 'news' });
    expect(String(fetch.mock.calls[0][0])).toContain('/api/v1/news?query=AI');
    expect(out.results[0]).toEqual({ title: 'News', url: 'https://example.com/news', content: '', score: 1 });
  });

  it.each([null, { error: 'failed' }, { organic_results: 'bad' }])('rejects malformed successful responses', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runSearch('AI', { engine: 'serpsearch-search' })).rejects.toMatchObject({ status: 502 });
  });

  it('passes an empty SERP to the existing no-hits fallback policy', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ search_info: { total_results: '0' } }));
    await expect(runSearch('no results', { engine: 'serpsearch-search' })).rejects.toThrow('upstream returned no valid search hits');
  });

  it('honors the one-second upstream retry hint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { code: 'RATE_LIMIT_EXCEEDED' } }, 429, { 'Retry-After': '1' }));
    await expect(runSearch('AI', { engine: 'serpsearch-search' })).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
  });
});

it('loads new modalities only from the catalog, idempotently preserving premiumSince', () => {
  const db = getDb();
  expect(db.prepare("SELECT COUNT(*) n FROM media_models WHERE platform IN ('beatapi', 'serpsearch')").get()).toEqual({ n: 0 });
  const premiumSince = '2026-10-18T12:00:00.000Z';
  const catalog = {
    version: '2099.01.01', generatedAt: premiumSince, tier: 'live' as const, models: [], quirks: [],
    decisionModels: ['jev-1.13-free', 'jev-1.14-free'].map(modelId => ({
      platform: 'beatapi', modelId, displayName: modelId, priority: 10, enabled: true,
      quotaLabel: 'Temporary free offer', contextWindow: 32768, premiumSince,
    })),
    searchEngines: [{ platform: 'serpsearch', engineId: 'serpsearch-search', displayName: 'SerpSearch',
      priority: 10, enabled: true, quotaLabel: '1,000 requests/month', creditsPerQuery: 1,
      features: { news: true, answer: false, fullContent: false }, premiumSince }],
  };
  expect(applyCatalog(db, catalog).skippedUnknownPlatform).toBe(0);
  expect(applyCatalog(db, catalog).inserted).toBe(0);
  const rows = db.prepare("SELECT platform, modality, meta_json FROM media_models WHERE platform IN ('beatapi', 'serpsearch')").all() as Array<{ platform: string; modality: string; meta_json: string }>;
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.modality).toBe(row.platform === 'beatapi' ? 'decision' : 'search');
    expect(JSON.parse(row.meta_json).premiumSince).toBe(premiumSince);
  }
  expect(db.prepare("SELECT COUNT(*) n FROM models WHERE platform IN ('beatapi', 'serpsearch')").get()).toEqual({ n: 0 });
});
