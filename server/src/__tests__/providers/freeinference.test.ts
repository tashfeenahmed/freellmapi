import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { FreeInferenceProvider, FREEINFERENCE_BASE_URL } from '../../providers/freeinference.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';

const model = 'qwen3.6-35b', models = [model, 'deepseek-v4-flash'];
const messages = [{ role: 'user' as const, content: 'Hi' }];
const completion = (returned = model) => ({ id: 'test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
const sse = (returned: string | null = model) => new Response(
  `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1,
    ...(returned ? { model: returned } : {}), choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\n` +
  'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('FreeInference registration and health', () => {
  it('registers key imports and one daily pool without seeding gated rows', () => {
    expect(getProvider('freeinference')).toBeInstanceOf(FreeInferenceProvider);
    expect(getProvider('freeinference')!.keyless).toBe(false);
    expect(parseKeysFromFile('FREEINFERENCE_API_KEY=test-key', 'keys.env').keys[0].platform).toBe('freeinference');
    expect(AUTH_JSON_PROVIDER_MAP['freeinference.org']).toBe('freeinference');
    expect(inferPoolForPlatform('freeinference', model)).toBe('freeinference::daily-free');
    expect(inferPoolForPlatform('freeinference', 'deepseek-v4-flash')).toBe('freeinference::daily-free');
    expect(inferPoolForPlatform('freeinference', 'bge-m3')).toBe('freeinference::daily-free');
    for (const table of ['models', 'embedding_models']) expect(getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE platform='freeinference'`).get()).toEqual({ n: 0 });
  });
  it('never treats the public model list as key validation or spends inference on a probe', async () => {
    const fetch = vi.spyOn(global, 'fetch'); const provider = new FreeInferenceProvider();
    expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('test-key')).rejects.toThrow('no verified credential-validation endpoint');
    await expect(provider.validateKey('')).resolves.toMatchObject({ valid: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('FreeInference chat', () => {
  it.each(models)('uses the tested endpoint, bearer auth and explicit non-streaming mode for %s', async model => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion(model)));
    const result = await new FreeInferenceProvider().chatCompletion('test-key', messages, model, { max_tokens: 128 });
    expect(fetch.mock.calls[0][0]).toBe(`${FREEINFERENCE_BASE_URL}/chat/completions`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer test-key' } });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, messages, stream: false, max_tokens: 128 });
    expect(result.choices[0].message.content).toBe('OK');
    expect(result._routed_via).toEqual({ platform: 'freeinference', model });
  });
  it.each(models)('streams through the shared parser and retains the requested identity for %s', async model => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(sse(model)); const chunks = [];
    for await (const chunk of new FreeInferenceProvider().streamChatCompletion('test-key', messages, model)) chunks.push(chunk);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, stream: true });
  });
  it.each(['bge-m3', 'glm-5.3', 'paid-model', 'deepseek-v4-flash:paid', 'DEEPSEEK-V4-FLASH'])('rejects untested/non-chat route %s before a request', async id => {
    const fetch = vi.spyOn(global, 'fetch'); const provider = new FreeInferenceProvider();
    await expect(provider.chatCompletion('test-key', messages, id)).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion('test-key', messages, id).next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['', 'no-key'])('requires a real configured key: %s', async key => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(new FreeInferenceProvider().chatCompletion(key, messages, model)).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['different-model', ''])('rejects substituted or missing completion identity: %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion(returned)));
    await expect(new FreeInferenceProvider().chatCompletion('test-key', messages, model)).rejects.toMatchObject({ status: 502 });
  });
  it.each(['different-model', null])('rejects wrong streaming identity before emitting content: %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse(returned));
    await expect(new FreeInferenceProvider().streamChatCompletion('test-key', messages, model).next()).rejects.toMatchObject({ status: 502 });
  });
  it.each(models)('rejects substitution by the other allowlisted model when requesting %s', async requested => {
    const substituted = models.find(id => id !== requested)!;
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json(completion(substituted))).mockResolvedValueOnce(sse(substituted));
    const provider = new FreeInferenceProvider();
    await expect(provider.chatCompletion('test-key', messages, requested)).rejects.toMatchObject({ status: 502 });
    await expect(provider.streamChatCompletion('test-key', messages, requested).next()).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects an empty stream', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('data: [DONE]\n\n'));
    await expect(new FreeInferenceProvider().streamChatCompletion('test-key', messages, model).next()).rejects.toMatchObject({ status: 502 });
  });
  it.each([401, 403, 429, 503])('preserves HTTP %s and backoff for routing', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ error: { message: 'Unavailable' } }, { status, headers: { 'Retry-After': '25' } }));
    await expect(new FreeInferenceProvider().chatCompletion('test-key', messages, model)).rejects.toMatchObject({ status, retryAfterMs: 25000 });
  });
});
