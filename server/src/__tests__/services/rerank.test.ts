import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runRerank, RerankError } from '../../services/rerank.js';

// Mutable so the scope tests can hand the service different key rows.
let mockRows: Array<{ id: number; platform: string; base_url: string | null; encrypted_key: string; iv: string; auth_tag: string; model_scope_json?: string | null }> = [
  // cohere first in insertion order; the service must still try the
  // custom endpoint first.
  { id: 1, platform: 'cohere', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
  { id: 2, platform: 'custom', base_url: 'https://relay.example/v1', encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
  // a custom row without a base_url is not a candidate
  { id: 3, platform: 'custom', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
];

vi.mock('../../db/index.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => mockRows,
      // The monthly-budget gate (#1158) reads api_keys caps and the ledger;
      // no rows here means every key is uncapped (0 = unlimited).
      get: () => undefined,
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

  it('never picks a key scoped to a different model (#657)', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ index: 0, relevance_score: 1 }]));
    mockRows = [
      // scoped to a chat model — must be skipped for the default rerank model
      { id: 4, platform: 'cohere', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a', model_scope_json: '["llama-3.1-8b"]' },
      { id: 5, platform: 'cohere', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a' },
    ];
    const out = await runRerank(undefined, 'q', ['a']);
    expect(out.platform).toBe('cohere');
    // Only the unscoped key may be called — one attempt, not two.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves a requested model through a key scoped exactly to it', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(ok([{ index: 0, relevance_score: 1 }]));
    mockRows = [
      { id: 6, platform: 'cohere', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a', model_scope_json: '["rerank-v3.5"]' },
    ];
    const out = await runRerank('rerank-v3.5', 'q', ['a']);
    expect(out.modelId).toBe('rerank-v3.5');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports no capable key (503) when every key is scoped out', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    mockRows = [
      { id: 7, platform: 'cohere', base_url: null, encrypted_key: 'e', iv: 'i', auth_tag: 'a', model_scope_json: '["some-other-model"]' },
    ];
    await expect(runRerank(undefined, 'q', ['a'])).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
