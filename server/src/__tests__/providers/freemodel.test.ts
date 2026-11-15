import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { FreeModelProvider, FREEMODEL_BASE_URL } from '../../providers/freemodel.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform, parseQuotaObservationsFromResponse } from '../../services/provider-quota.js';

const model = 'deepseek-v4.1-flash', messages = [{ role: 'user' as const, content: 'Hi' }];
const completion = (returned = model, content = 'OK') => ({ id: 'test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
const chunk = (returned: string | null = model, content = 'OK') => ({ id: 'test', object: 'chat.completion.chunk', created: 1,
  ...(returned ? { model: returned } : {}), choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] });
const sse = (...chunks: unknown[]) => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } });
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('FreeModel registration and health', () => {
  it('observes rate headers without inventing a monthly reset or model-specific budget', () => {
    const observations = parseQuotaObservationsFromResponse(new Response('', { headers: {
      'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59',
      'x-ratelimit-limit-tokens': '1000000', 'x-ratelimit-remaining-tokens': '999999',
    } }), { platform: 'freemodel', modelId: model });
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'requests', limit: 60, remaining: 59, resetAt: null, resetStrategy: 'provider_reported' }),
      expect.objectContaining({ metric: 'tokens', limit: 1000000, remaining: 999999, resetAt: null, resetStrategy: 'provider_reported' }),
    ]));
  });
  it('registers BYOK key imports and one shared pool without seeding gated rows', () => {
    expect(getProvider('freemodel')).toBeInstanceOf(FreeModelProvider);
    expect(getProvider('freemodel')!.keyless).toBe(false);
    expect(parseKeysFromFile('FREEMODEL_API_KEY=test-key', 'keys.env').keys[0].platform).toBe('freemodel');
    expect(AUTH_JSON_PROVIDER_MAP['freemodel.in']).toBe('freemodel');
    expect(inferPoolForPlatform('freemodel', model)).toBe('freemodel::account-free');
    expect(inferPoolForPlatform('freemodel', 'kimi-k3')).toBe('freemodel::account-free');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='freemodel'").get()).toEqual({ n: 0 });
  });
  it('does not mistake the public roster for authentication or spend tokens probing keys', async () => {
    const fetch = vi.spyOn(global, 'fetch'); const provider = new FreeModelProvider();
    expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('test-key')).rejects.toThrow('no verified credential-validation endpoint');
    await expect(provider.validateKey('')).resolves.toMatchObject({ valid: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('FreeModel chat', () => {
  it('uses bearer auth, explicit stream=false, no redirects and the requested token cap', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion()));
    const result = await new FreeModelProvider().chatCompletion('test-key', messages, model, { max_tokens: 128 });
    expect(fetch.mock.calls[0][0]).toBe(`${FREEMODEL_BASE_URL}/chat/completions`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer test-key' } });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, messages, stream: false, max_tokens: 128 });
    expect(result.choices[0].message.content).toBe('OK');
    expect(result._routed_via).toEqual({ platform: 'freemodel', model });
  });
  it('does not hardcode a discovery roster; signed catalog selects the model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion('new-catalog-route')));
    await expect(new FreeModelProvider().chatCompletion('test-key', messages, 'new-catalog-route')).resolves.toMatchObject({ model: 'new-catalog-route' });
  });
  it('streams valid content, accepting a terminal usage-only event without identity', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(sse(chunk(model, ''), chunk(), { choices: [], usage: { total_tokens: 4 } }));
    const chunks = [];
    for await (const c of new FreeModelProvider().streamChatCompletion('test-key', messages, model)) chunks.push(c);
    expect(chunks).toHaveLength(3);
    expect(chunks[1].choices[0].delta.content).toBe('OK');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, stream: true });
  });
  it.each(['', 'no-key', '   '])('rejects missing key %s for both modes without fetching', async key => {
    const fetch = vi.spyOn(global, 'fetch'); const provider = new FreeModelProvider();
    await expect(provider.chatCompletion(key, messages, model)).rejects.toMatchObject({ status: 401 });
    await expect(provider.streamChatCompletion(key, messages, model).next()).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['different-model', ''])('rejects wrong completion identity: %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion(returned)));
    await expect(new FreeModelProvider().chatCompletion('test-key', messages, model)).rejects.toMatchObject({ status: 502 });
  });
  it('rejects an empty completion', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion(model, '')));
    await expect(new FreeModelProvider().chatCompletion('test-key', messages, model)).rejects.toMatchObject({ status: 502 });
  });
  it.each(['different-model', null])('rejects wrong streaming identity without yielding its preamble: %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse(chunk(model, ''), chunk(returned)));
    await expect(new FreeModelProvider().streamChatCompletion('test-key', messages, model).next()).rejects.toMatchObject({ status: 502 });
  });
  it.each([0, 1, 64])('rejects empty streams (%s frames) before committing client output', async frames => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse(...Array.from({ length: frames }, () => chunk(model, ''))));
    await expect(new FreeModelProvider().streamChatCompletion('test-key', messages, model).next()).rejects.toMatchObject({ status: 502 });
  });
  it.each([401, 402, 403, 429, 503])('preserves HTTP %s and backoff for failover', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ error: { message: 'Unavailable' } }, { status, headers: { 'Retry-After': '25' } }));
    await expect(new FreeModelProvider().chatCompletion('test-key', messages, model)).rejects.toMatchObject({ status, retryAfterMs: 25000 });
    await expect(new FreeModelProvider().streamChatCompletion('test-key', messages, model).next()).rejects.toMatchObject({ status, retryAfterMs: 25000 });
  });
});
