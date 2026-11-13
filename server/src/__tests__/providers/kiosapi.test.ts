import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KiosAPIProvider } from '../../providers/kiosapi.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { detectPlatform } from '../../lib/key-parser.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const routes = [
  ['meta/llama-3.1-8b', '@cf/meta/llama-3.1-8b-instruct-fp8'],
  ['qwen/qwen3-30b', '@cf/qwen/qwen3-30b-a3b-fp8'],
  ['zai/glm-4.7-flash', '@cf/zai-org/glm-4.7-flash'],
  ['google/gemma-4-26b', '@cf/google/gemma-4-26b-a4b-it'],
  ['aisingapore/sea-lion-27b', '@cf/aisingapore/gemma-sea-lion-v4-27b-it'],
];
const model = routes[0][0];
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model, content: string | null = 'OK') => ({
  id: 'test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});
const frame = (content: string, returned = model) => ({ id: 'test', object: 'chat.completion.chunk', created: 1,
  model: returned, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const stream = (...events: unknown[]) => new Response(events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n');
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('KiosAPI free routes', () => {
  it('registers without seeding or discovery and imports named keys', () => {
    expect(getProvider('kiosapi')).toBeInstanceOf(KiosAPIProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='kiosapi'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'kiosapi')).toBe(false);
    expect(detectPlatform('KIOSAPI_')).toBe('kiosapi');
  });
  it('does not burn quota or mistake the public roster for credential validation', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    const p = new KiosAPIProvider();
    expect(p.supportsKeyValidation).toBe(false);
    await expect(p.validateKey('test')).rejects.toThrow('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(routes)('accepts only the exact observed alias for %s in both modes', async (requested, alias) => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(completion(alias)))
      .mockResolvedValueOnce(stream(frame('  ', alias), frame('OK', alias), { choices: [], usage: { total_tokens: 2 } }));
    const p = new KiosAPIProvider();
    expect((await p.chatCompletion('unit-test', [], requested, { max_tokens: 32 })).model).toBe(requested);
    const chunks = [];
    for await (const chunk of p.streamChatCompletion('unit-test', [], requested)) chunks.push(chunk);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(c => c.model === requested)).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.kiosapi.id/v1/chat/completions');
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer unit-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: requested, max_tokens: 32 });
  });
  it.each(['', '@cf/unrelated/model'])('rejects a missing or substituted model before yielding %s', async returned => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(completion(returned)))
      .mockResolvedValueOnce(stream(frame(''), frame('OK', returned)));
    const p = new KiosAPIProvider();
    await expect(p.chatCompletion('test', [], model)).rejects.toMatchObject({ status: 502 });
    await expect(p.streamChatCompletion('test', [], model).next()).rejects.toMatchObject({ status: 502 });
  });
  it('rejects empty output in both modes but permits tool calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(completion(model, ' ')))
      .mockResolvedValueOnce(stream(frame(' ')))
      .mockResolvedValueOnce(json({ ...completion(model, null), choices: [{ message: { tool_calls: [{ id: 'tool' }] } }] }));
    const p = new KiosAPIProvider();
    await expect(p.chatCompletion('test', [], model)).rejects.toMatchObject({ status: 502 });
    await expect(p.streamChatCompletion('test', [], model).next()).rejects.toMatchObject({ status: 502 });
    await expect(p.chatCompletion('test', [], model)).resolves.toMatchObject({ model });
  });
  it('buffers a long reasoning preamble without rejecting a valid Qwen answer', async () => {
    const [requested, alias] = routes[1];
    const reasoning = { ...frame('', alias), choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] };
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(...Array.from({ length: 100 }, () => reasoning), frame('42', alias)));
    const chunks = [];
    for await (const c of new KiosAPIProvider().streamChatCompletion('test', [], requested)) chunks.push(c);
    expect(chunks.at(-1)?.choices[0].delta.content).toBe('42');
    expect(chunks.every(c => c.model === requested)).toBe(true);
  });
  it('rejects an excessive reasoning-only preamble before yielding', async () => {
    const reasoning = { ...frame(''), choices: [{ index: 0, delta: { reasoning_content: 'x'.repeat(270_000) }, finish_reason: null }] };
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(reasoning));
    await expect(new KiosAPIProvider().streamChatCompletion('test', [], model).next()).rejects.toMatchObject({ status: 502 });
  });
  it.each(['paid/model', '__proto__', '@cf/meta/llama-3.1-8b-instruct-fp8'])('rejects non-catalog free IDs: %s', async paid => {
    const fetch = vi.spyOn(global, 'fetch');
    const p = new KiosAPIProvider();
    await expect(p.chatCompletion('test', [], paid)).rejects.toMatchObject({ status: 400 });
    await expect(p.streamChatCompletion('test', [], paid).next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 402, 429, 503])('preserves HTTP %s for normal failover without a paid retry', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new KiosAPIProvider().chatCompletion('test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
