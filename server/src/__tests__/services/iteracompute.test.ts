import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { IteraComputeProvider, ITERACOMPUTE_BASE_URL } from '../../providers/iteracompute.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const completion = (model?: string) => ({ id: 'c', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('iteracompute registration and import (#1649)', () => {
  it('registers the adapter, the env import alias and one shared monthly pool', () => {
    expect(getProvider('iteracompute')).toBeInstanceOf(IteraComputeProvider);
    expect(getProvider('iteracompute')!.keyless).toBe(false);
    expect(parseKeysFromFile('ITERACOMPUTE_API_KEY=test-key', 'keys.env').keys[0].platform).toBe('iteracompute');
    expect(AUTH_JSON_PROVIDER_MAP.iteracompute).toBe('iteracompute');
    // One 30M-token monthly allowance shared across every free model, so a 429
    // on one model benches the platform, not the model.
    expect(inferPoolForPlatform('iteracompute', 'qwen/qwen3.8-27b'))
      .toBe(inferPoolForPlatform('iteracompute', 'qwen/qwen3.9-30b'));
  });
});

describe('iteracompute key validation (#1649)', () => {
  // GET /models is anonymous (a bogus Bearer header still returns 200, verified
  // live 2026-10-22) and /chat/completions reserves monthly allowance per
  // request, so there is no free credential probe — same stance as freeai
  // (#1459): inconclusive, never a false verdict, never quota spent.
  it('never probes: validation is inconclusive by design', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    const provider = new IteraComputeProvider();
    expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('test-key')).rejects.toThrow(/no free credential-validation endpoint/i);
    // The probe must never hit the network: no free credential endpoint exists.
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('iteracompute chat', () => {
  it('forwards OpenAI-shape completions with attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('qwen/qwen3.8-27b')));
    const result = await new IteraComputeProvider().chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'qwen/qwen3.8-27b', { max_tokens: 512 });
    expect(fetch.mock.calls[0][0]).toBe(`${ITERACOMPUTE_BASE_URL}/chat/completions`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'qwen/qwen3.8-27b', max_tokens: 512 });
    expect(result.choices[0].message.content).toBe('OK');
    expect(result._routed_via).toEqual({ platform: 'iteracompute', model: 'qwen/qwen3.8-27b' });
  });

  // A bad key is only discovered at request time (validation is off), so the
  // 401 must surface as an invalid-key verdict through the normal error path.
  it('surfaces the live 401 invalid_api_key shape as an upstream error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'IteraCompute authentication failed', type: 'authentication_error', code: 'invalid_api_key' } }, 401));
    await expect(new IteraComputeProvider().chatCompletion('bad-key', [{ role: 'user', content: 'Hi' }], 'qwen/qwen3.8-27b'))
      .rejects.toMatchObject({ status: 401 });
  });

  // Full/timed-out free queues answer 429 + Retry-After per the free-tier
  // terms; the status must reach the fallback loop intact.
  it('surfaces a 429 queue rejection as a retryable upstream error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'queue full' } }, 429));
    await expect(new IteraComputeProvider().chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'qwen/qwen3.8-27b'))
      .rejects.toMatchObject({ status: 429 });
  });
});
