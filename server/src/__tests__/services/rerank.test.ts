import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runRerank, RerankError } from '../../services/rerank.js';

vi.mock('../../db/index.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [
        // cohere first in insertion order; the service must still try the
        // custom endpoint first.
        { id: 1, platform: 'cohere', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
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

const ok = (results: unknown) => new Response(JSON.stringify({ results }), { status: 200 });

describe('runRerank', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('walks candidates custom-first and takes the first success', async () => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(ok([{ index: 1, relevance_score: 0.9 }]));
    const out = await runRerank(undefined, 'q', ['a', 'b'], 1);
    expect((fetch.mock.calls[0][0] as string)).toBe('https://relay.example/v1/rerank');
    expect(out.platform).toBe('cohere');
    expect(out.results).toEqual([{ index: 1, relevanceScore: 0.9, document: 'b' }]);
  });

  it('rejects an out-of-range index and reports chain exhaustion', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ index: 9, relevance_score: 1 }]));
    await expect(runRerank(undefined, 'q', ['a'])).rejects.toBeInstanceOf(RerankError);
  });
});
