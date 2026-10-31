import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { NabhProvider, NABH_BASE_URL } from '../../providers/nabh.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';

const model = 'gpt-oss-20b';
const messages = [{ role: 'user' as const, content: 'Hi' }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const completion = (returned: string | undefined = model) => ({ id: 'test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
const sse = (returned: string | null = model) => new Response(
  `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1,
    ...(returned ? { model: returned } : {}), choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] })}\n\n` +
  'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('nabh registration', () => {
  it('registers credential imports and one shared account allowance without seeding models', () => {
    expect(getProvider('nabh')).toBeInstanceOf(NabhProvider);
    expect(getProvider('nabh')!.keyless).toBe(false);
    expect(parseKeysFromFile('NABH_API_KEY=test-key', 'keys.env').keys[0].platform).toBe('nabh');
    expect(AUTH_JSON_PROVIDER_MAP.nabh).toBe('nabh');
    expect(AUTH_JSON_PROVIDER_MAP['nabh.cloud']).toBe('nabh');
    expect(inferPoolForPlatform('nabh', model)).toBe('nabh::monthly-credit');
    expect(inferPoolForPlatform('nabh', 'another-model')).toBe('nabh::monthly-credit');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='nabh'").get()).toEqual({ n: 0 });
  });
});

describe('nabh key validation', () => {
  it('uses the authenticated read-only model list, not billed inference', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ id: model }] }));
    await expect(new NabhProvider().validateKey('test-key')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`${NABH_BASE_URL}/models`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer test-key' } });
  });
  it.each([401, 403])('preserves an authentication failure (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid API key' } }, status));
    await expect(new NabhProvider().validateKey('bad')).resolves.toMatchObject({ valid: false });
  });
  it.each([402, 429, 500])('treats a transient/balance response (%s) as inconclusive', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'unavailable' } }, status));
    await expect(new NabhProvider().validateKey('test-key')).rejects.toMatchObject({ status });
  });
  it.each(['OK', '{}', '{"error":"down"}'])('does not accept malformed or parked responses: %s', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    await expect(new NabhProvider().validateKey('test-key')).rejects.toMatchObject({ status: 502 });
  });
});

describe('nabh completions', () => {
  it('forwards credentials, messages and generation options with attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await new NabhProvider().chatCompletion('test-key', messages, model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe(`${NABH_BASE_URL}/chat/completions`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer test-key' } });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, messages, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response._routed_via).toEqual({ platform: 'nabh', model });
  });
  it.each([401, 402, 403, 429, 503])('preserves HTTP %s for normal router fallback', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'upstream unavailable' } }, status));
    await expect(new NabhProvider().chatCompletion('test-key', messages, model)).rejects.toMatchObject({ status });
  });
  it.each(['different-model', ''])('rejects a substituted or missing identity: %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(returned)));
    await expect(new NabhProvider().chatCompletion('test-key', messages, model)).rejects.toMatchObject({ status: 502 });
  });
  it('streams a matching model through the shared transport', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(sse());
    const chunks = [];
    for await (const chunk of new NabhProvider().streamChatCompletion('test-key', messages, model)) chunks.push(chunk);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, stream: true });
  });
  it.each(['different-model', null])('blocks a streaming identity mismatch before emitting content: %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse(returned));
    const stream = new NabhProvider().streamChatCompletion('test-key', messages, model);
    await expect(stream.next()).rejects.toMatchObject({ status: 502 });
  });
});
