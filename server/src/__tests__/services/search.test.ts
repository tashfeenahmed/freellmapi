import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runSearch, SearchError } from '../../services/search.js';

vi.mock('../../db/index.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [
        // tavily first in insertion order; the service must still try the
        // custom endpoint first.
        { id: 1, platform: 'tavily', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
        { id: 2, platform: 'custom', base_url: 'https://relay.example/v1', encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
        // a custom row without a base_url is not a candidate
        { id: 3, platform: 'custom', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
      ],
    }),
  }),
}));
vi.mock('../../lib/crypto.js', () => ({
  decrypt: () => 'test-key',
}));

const ok = (results: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ results, ...extra }), { status: 200 });

describe('runSearch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('walks candidates custom-first and takes the first success', async () => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(ok([{ title: 'T', url: 'https://x', content: 'c', score: 0.9 }]));
    const out = await runSearch('q', { maxResults: 5 });
    expect(fetch.mock.calls[0][0]).toBe('https://relay.example/v1/search');
    expect(out.provider).toBe('tavily');
    expect(out.results).toEqual([{ title: 'T', url: 'https://x', content: 'c', score: 0.9 }]);
  });

  it('passes topic and include_answer through and forwards the answer field', async () => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok([{ title: 'N', url: 'https://n', content: 'x', score: 1 }], { answer: '42' }));
    const out = await runSearch('q', { topic: 'news', includeAnswer: true });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({ topic: 'news', include_answer: true, max_results: 5 });
    expect(out.answer).toBe('42');
  });

  it('drops hits without a url and reports chain exhaustion when nothing valid remains', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ title: 'no url', content: 'x' }]));
    await expect(runSearch('q')).rejects.toBeInstanceOf(SearchError);
  });
});
