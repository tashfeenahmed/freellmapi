import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { SilvrProvider, SILVR_BASE_URL } from '../../providers/silvr.js';
import { parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';
const model = 'glm-5-3', messages = [{ role: 'user' as const, content: 'Hi' }];
const completion = (identity: unknown = model, content: unknown = 'OK') => ({ id: 'test', object: 'chat.completion', created: 1, model: identity, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const event = (identity: unknown = model) => ({ id: 'test', object: 'chat.completion.chunk', created: 1, model: identity, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });
describe('SilvR catalog-only chat', () => {
  it('registers the adapter and importer without discovery, quota-spending probes or model seeds', async () => {
    const provider = getProvider('silvr')!; const fetch = vi.spyOn(global, 'fetch');
    expect(provider).toBeInstanceOf(SilvrProvider); expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('test')).rejects.toThrow('first completion'); expect(fetch).not.toHaveBeenCalled();
    expect(isBuiltinDiscoveryEligible(getDb(), 'silvr')).toBe(false);
    expect(parseKeysFromFile('SILVR_API_KEY=synthetic', 'keys.env').keys[0]).toMatchObject({ platform: 'silvr', rawKey: 'SILVR_API_KEY=synthetic' });
    expect(inferPoolForPlatform('silvr', model)).toBe('silvr::daily-free');
    expect(inferPoolForPlatform('silvr', 'another')).toBe(inferPoolForPlatform('silvr', model));
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='silvr'").get()).toEqual({ n: 0 });
  });
  it('pins the identity, forwards options and keeps credentials on the fixed host', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion()));
    expect(await new SilvrProvider().chatCompletion('synthetic-key', messages, model, { temperature: 0.2, max_tokens: 128 })).toMatchObject({ model, _routed_via: { platform: 'silvr', model } });
    expect(fetch.mock.calls[0][0]).toBe(`${SILVR_BASE_URL}/chat/completions`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic-key' } });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, messages, temperature: 0.2, max_tokens: 128 });
  });
  it.each(['glm-5.2', '', null])('rejects a substituted or missing completion identity: %j', async id => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion(id)));
    await expect(new SilvrProvider().chatCompletion('test', messages, model)).rejects.toMatchObject({ status: 502 });
  });
  it('rejects an empty completion for normal failover', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(completion(model, '')));
    await expect(new SilvrProvider().chatCompletion('test', messages, model)).rejects.toMatchObject({ status: 502 });
  });
  it.each([401, 402, 403, 429, 503])('preserves HTTP %s without retrying a paid model', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ error: { message: 'unavailable' } }, { status }));
    await expect(new SilvrProvider().chatCompletion('test', messages, model)).rejects.toMatchObject({ status }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts matching SSE followed by a usage-only frame', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(event())}\n\ndata: ${JSON.stringify({ choices: [], usage: { total_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    const chunks = []; for await (const chunk of new SilvrProvider().streamChatCompletion('test', messages, model)) chunks.push(chunk);
    expect(chunks[0].choices[0].delta.content).toBe('OK'); expect(chunks.some(c => c.usage?.total_tokens === 10)).toBe(true);
  });
  it.each([event('glm-5.2'), { error: { message: 'free quota exhausted' } }])('rejects a substituted or error SSE frame before content: %j', async frame => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(new SilvrProvider().streamChatCompletion('test', messages, model).next()).rejects.toMatchObject({ status: 502 });
  });
});
