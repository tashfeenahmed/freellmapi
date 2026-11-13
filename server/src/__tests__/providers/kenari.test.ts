import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KenariProvider } from '../../providers/kenari.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'qwen3-8-omni-flash:free';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (content: string | null = 'OK', returned = model) => ({
  id: 'test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const frame = (delta: object, returned = model) => ({ id: 'test', object: 'chat.completion.chunk', created: 1,
  model: returned, choices: [{ index: 0, delta, finish_reason: null }] });
const stream = (...events: unknown[]) => new Response(events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n');

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Kenari provider', () => {
  it('is registered without bundled models or free-tier discovery bypass', () => {
    expect(getProvider('kenari')).toBeInstanceOf(KenariProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='kenari'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'kenari')).toBe(false);
  });
  it('validates a zero balance through the authenticated account endpoint, not public models', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ object: 'account.balance', available_micro_idr: 0 }));
    await expect(new KenariProvider().validateKey('unit-test')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://kenari.id/v1/account/balance');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer unit-test');
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('rejects invalid credentials', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, 401));
    await expect(new KenariProvider().validateKey('invalid')).resolves.toMatchObject({ valid: false });
  });
  it.each([403, 429, 500])('leaves HTTP %s credential checks inconclusive', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, status, { 'Retry-After': '20' }));
    await expect(new KenariProvider().validateKey('unit-test')).rejects.toMatchObject({ status, retryAfterMs: 20_000 });
  });
  it.each([null, {}, { object: 'account.balance', available_micro_idr: '0' }])('rejects malformed balance %j', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(new KenariProvider().validateKey('unit-test')).rejects.toMatchObject({ status: 502 });
  });
  it('preserves the exact free route and sampling options', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new KenariProvider().chatCompletion('unit-test', [{ role: 'user', content: 'OK' }], model, { max_tokens: 64 })).resolves.toMatchObject({ model });
    expect(fetch.mock.calls[0][0]).toBe('https://kenari.id/v1/chat/completions');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 64 });
  });
  it.each(['', 'another-model'])('rejects missing or substituted identity %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('OK', returned)));
    await expect(new KenariProvider().chatCompletion('unit-test', [], model)).rejects.toMatchObject({ status: 502 });
  });
  it('rejects an empty completion but permits tool-only answers', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(completion('')));
    await expect(new KenariProvider().chatCompletion('unit-test', [], model)).rejects.toMatchObject({ status: 502 });
    fetch.mockResolvedValue(json({ ...completion(null), choices: [{ index: 0, message: { role: 'assistant', content: null,
      tool_calls: [{ id: 't', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    await expect(new KenariProvider().chatCompletion('unit-test', [], model)).resolves.toMatchObject({ model });
  });
  it('rejects a paid ID without any request', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(new KenariProvider().chatCompletion('unit-test', [], 'qwen3-8-omni-flash')).rejects.toMatchObject({ status: 400 });
    await expect(new KenariProvider().streamChatCompletion('unit-test', [], 'qwen3-8-omni-flash').next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('holds an empty stream before yielding so failover remains possible', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ role: 'assistant' }), frame({ content: '' })));
    await expect(new KenariProvider().streamChatCompletion('unit-test', [], model).next()).rejects.toMatchObject({ status: 502 });
  });
  it('streams exact-route content and a model-less usage trailer', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ role: 'assistant' }), frame({ content: 'OK' }), { choices: [], usage: { total_tokens: 2 } }));
    const chunks = [];
    for await (const chunk of new KenariProvider().streamChatCompletion('unit-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(3);
    expect(chunks[1].choices[0].delta.content).toBe('OK');
  });
  it.each([frame({ content: 'OK' }, 'other'), { error: { message: 'failed' } }])('rejects invalid SSE before content is committed', async event => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ role: 'assistant' }), event));
    await expect(new KenariProvider().streamChatCompletion('unit-test', [], model).next()).rejects.toMatchObject({ status: 502 });
  });
  it.each([402, 429, 503])('preserves HTTP %s without a paid-alias retry', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'unavailable' } }, status, { 'Retry-After': '15' }));
    await expect(new KenariProvider().chatCompletion('unit-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
