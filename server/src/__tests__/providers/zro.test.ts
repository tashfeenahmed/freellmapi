import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { ZroProvider, ZRO_BASE_URL } from '../../providers/zro.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';

const model = 'deepseek-v4.1-flash';
const messages = [{ role: 'user' as const, content: 'Hi' }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const completion = (returned: unknown = model, content: string | null = 'OK', toolCalls?: unknown[]) => ({
  id: 'test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
});
const stream = (returned: unknown = model, usageOnly = false) => new Response(
  `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1,
    model: returned, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\n` +
  (usageOnly ? `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } })}\n\n` : '') +
  'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Zro registration and quota accounting', () => {
  it('registers a keyed provider without bypassing the hosted catalog age gate', () => {
    expect(getProvider('zro')).toBeInstanceOf(ZroProvider);
    expect(getProvider('zro')!.keyless).toBe(false);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='zro'").get()).toEqual({ n: 0 });
    expect(inferPoolForPlatform('zro', model)).toBe('zro::daily-free');
    expect(inferPoolForPlatform('zro', 'another-model')).toBe('zro::daily-free');
  });

  it.each(['ZRO_API_KEY', 'MOONMATH_API_KEY'])('imports %s as Zro', name => {
    expect(parseKeysFromFile(`${name}=sk-test-key`, 'keys.env').keys[0])
      .toMatchObject({ platform: 'zro', rawKey: `${name}=sk-test-key` });
  });

  it.each(['zro', 'moonmath', 'zro.moonmath.ai', 'moonmath.ai'])('maps the JSON provider name %s', name => {
    expect(AUTH_JSON_PROVIDER_MAP[name]).toBe('zro');
  });
});

describe('Zro key validation', () => {
  it('uses only the authenticated, read-only model endpoint', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ id: model }] }));
    await expect(new ZroProvider().validateKey('sk-test-key')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`${ZRO_BASE_URL}/models`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer sk-test-key' } });
  });

  it.each(['', '   ', 'no-key'])('requires an actual credential: %j', async key => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(new ZroProvider().validateKey(key)).resolves.toMatchObject({ valid: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403])('reports HTTP %s without exposing an upstream key echo', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Received API Key = sk-private-value' } }, status));
    const result = await new ZroProvider().validateKey('sk-private-value');
    expect(result).toMatchObject({ valid: false });
    expect(JSON.stringify(result)).not.toContain('sk-private-value');
  });

  it.each([402, 429, 500, 503])('treats HTTP %s as inconclusive rather than an invalid key', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'unavailable' } }, status));
    await expect(new ZroProvider().validateKey('sk-test-key')).rejects.toMatchObject({ status });
  });

  it.each(['OK', '{}', '{"error":"down"}', '{"data":[null]}', '{"data":[{"id":42}]}'])('rejects a parked or malformed model list: %s', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    await expect(new ZroProvider().validateKey('sk-test-key')).rejects.toMatchObject({ status: 502 });
  });
});

describe('Zro completions', () => {
  it('forwards sampling, JSON and tool options through the normal adapter', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const tools = [{ type: 'function' as const, function: { name: 'report_status', parameters: { type: 'object', properties: {} } } }];
    const response = await new ZroProvider().chatCompletion('sk-test-key', messages, model,
      { max_tokens: 128, temperature: 0.2, response_format: { type: 'json_object' }, tools, tool_choice: 'auto' });
    expect(fetch.mock.calls[0][0]).toBe(`${ZRO_BASE_URL}/chat/completions`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer sk-test-key' } });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, messages,
      max_tokens: 128, temperature: 0.2, response_format: { type: 'json_object' }, tools, tool_choice: 'auto' });
    expect(response._routed_via).toEqual({ platform: 'zro', model });
  });

  it('accepts a tool-only completion instead of rejecting it as empty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(model, null, [
      { id: 'call_test', type: 'function', function: { name: 'report_status', arguments: '{"status":"OK"}' } },
    ])));
    const result = await new ZroProvider().chatCompletion('sk-test-key', messages, model);
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('report_status');
  });

  it.each([[model, `zro/${model}`], [`zro/${model}`, model]])('accepts only the documented namespace alias (%s → %s)', async (requested, returned) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(returned)));
    await expect(new ZroProvider().chatCompletion('sk-test-key', messages, requested)).resolves.toMatchObject({ model: returned });
  });

  it.each(['glm-5.3', 'deepseek-v4-flash-0731', '', null])('blocks a different or missing response identity: %j', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(returned)));
    await expect(new ZroProvider().chatCompletion('sk-test-key', messages, model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects an empty successful completion so normal fallback can run', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(model, '')));
    await expect(new ZroProvider().chatCompletion('sk-test-key', messages, model)).rejects.toMatchObject({ status: 502 });
  });

  it.each([401, 402, 403, 429, 503])('preserves HTTP %s for router fallback without retrying a paid model', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'upstream unavailable' } }, status));
    await expect(new ZroProvider().chatCompletion('sk-test-key', messages, model)).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes matching SSE content and usage-only final frames', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(stream(model, true));
    const chunks = [];
    for await (const chunk of new ZroProvider().streamChatCompletion('sk-test-key', messages, model)) chunks.push(chunk);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
    expect(chunks.some(chunk => chunk.usage?.total_tokens === 11)).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, stream: true });
  });

  it('allows the documented alias in SSE', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(`zro/${model}`));
    const result = new ZroProvider().streamChatCompletion('sk-test-key', messages, model);
    expect((await result.next()).value?.choices[0].delta.content).toBe('OK');
    await result.return();
  });

  it.each(['glm-5.3', '', null])('rejects streaming substitution before emitting content: %j', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(returned));
    await expect(new ZroProvider().streamChatCompletion('sk-test-key', messages, model).next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves streaming HTTP %s for normal failover', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'upstream unavailable' } }, status));
    await expect(new ZroProvider().streamChatCompletion('sk-test-key', messages, model).next()).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('rejects an HTTP-200 SSE error, including after a valid role frame (%s)', async withRole => {
    const role = { id: 'test', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    const body = (withRole ? `data: ${JSON.stringify(role)}\n\n` : '') +
      `data: ${JSON.stringify({ error: { message: 'Free quota exhausted' } })}\n\n` + 'data: [DONE]\n\n';
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = new ZroProvider().streamChatCompletion('sk-test-key', messages, model);
    if (withRole) await result.next();
    await expect(result.next()).rejects.toMatchObject({ status: 502 });
  });
});
