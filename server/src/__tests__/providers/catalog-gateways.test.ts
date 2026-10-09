import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InferbaseProvider, INFERBASE_BASE_URL } from '../../providers/inferbase.js';
import { SimpleLLMProvider, SIMPLELLM_BASE_URL } from '../../providers/simplellm.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';
import { getDb, initDb } from '../../db/index.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const configs = [
  { platform: 'inferbase' as const, provider: InferbaseProvider, base: INFERBASE_BASE_URL, validate: 'https://api.inferbase.ai/api/v1/inference/credits', account: { balance_micros: 0 }, model: 'deepseek-v4-flash', returned: 'deepseek-v4-flash' },
  { platform: 'simplellm' as const, provider: SimpleLLMProvider, base: SIMPLELLM_BASE_URL, validate: `${SIMPLELLM_BASE_URL}/rate-limit`, account: { limit_rpm: 1000 }, model: 'free-gemma-4-E4B', returned: 'gemma-4-E4B' },
];
const completion = (model?: string) => ({ id: 'c', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
const stream = (model?: string) => new Response([
  { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
  { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 's', object: 'chat.completion.chunk', created: 1, choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');

describe.each(configs)('$platform catalog-only adapter', config => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

  it('registers keys, explicit import aliases and one shared quota pool', () => {
    expect(getProvider(config.platform)).toBeInstanceOf(config.provider);
    expect(getProvider(config.platform)!.keyless).toBe(false);
    expect(parseKeysFromFile(`${config.platform.toUpperCase()}_API_KEY=test-key`, 'keys.env').keys[0].platform).toBe(config.platform);
    expect(AUTH_JSON_PROVIDER_MAP[config.platform]).toBe(config.platform);
    expect(inferPoolForPlatform(config.platform, 'model-one')).toBe(inferPoolForPlatform(config.platform, 'model-two'));
  });

  it('authenticates read-only account metadata without requiring purchased credits', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(config.account));
    await expect(new config.provider().validateKey('test-key')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(config.validate);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('rejects authentication failure %s', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid key' } }, status));
    await expect(new config.provider().validateKey('bad-key')).resolves.toMatchObject({ valid: false });
  });

  it.each([402, 429, 503])('treats validation HTTP %s as inconclusive and preserves retry hints', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, status, { 'Retry-After': '12' }));
    await expect(new config.provider().validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 12_000 });
  });

  it.each(['{}', 'null', '<html>Sign in</html>'])('rejects malformed account responses', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    await expect(new config.provider().validateKey('test-key')).rejects.toMatchObject({ status: 502 });
  });

  it('preserves exact requests, tool parameters, output and attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion(config.returned)));
    const tools = [{ type: 'function' as const, function: { name: 'lookup', parameters: { type: 'object' } } }];
    const result = await new config.provider().chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], config.model,
      { max_tokens: 512, temperature: 0.2, stop: 'END', tools, tool_choice: 'auto', response_format: { type: 'json_object' } });
    expect(fetch.mock.calls[0][0]).toBe(`${config.base}/chat/completions`);
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: config.model, max_tokens: 512, tools, response_format: { type: 'json_object' }, stop: config.platform === 'simplellm' ? ['END'] : 'END' });
    expect(result.choices[0].message.content).toBe('OK');
    expect(result.usage?.total_tokens).toBe(4);
    expect(result._routed_via).toEqual({ platform: config.platform, model: config.model });
  });

  it('streams matching identity and usage-only terminal frames', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(stream(config.returned));
    const chunks = [];
    for await (const chunk of new config.provider().streamChatCompletion('test-key', [], config.model, { max_tokens: 64, stop: 'END', stream_options: { include_usage: true } })) chunks.push(chunk);
    expect(chunks.map(c => c.choices[0]?.delta.content ?? '').join('')).toBe('OK');
    expect(chunks.at(-1)?.usage?.total_tokens).toBe(4);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it.each(['another-model', undefined])('rejects substituted/missing model identity in chat and SSE', async returned => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(completion(returned))).mockResolvedValueOnce(stream(returned));
    await expect(new config.provider().chatCompletion('test-key', [], config.model)).rejects.toMatchObject({ status: 502 });
    const collect = async () => { for await (const _ of new config.provider().streamChatCompletion('test-key', [], config.model)) { /* drain */ } };
    await expect(collect()).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([402, 429, 503])('preserves inference error HTTP %s without retrying paid fallback', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Unavailable' } }, status, { 'Retry-After': '17' }));
    await expect(new config.provider().chatCompletion('test-key', [], config.model)).rejects.toMatchObject({ status, retryAfterMs: 17_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not seed or discover models; only ingests tier-selected catalog rows', () => {
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM models WHERE platform=?').get(config.platform)).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(db, config.platform)).toBe(false);
    const result = applyCatalog(db, { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [], models: [{ platform: config.platform, modelId: config.model, displayName: 'Test model', intelligenceRank: 50, speedRank: 50, sizeLabel: '', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared free allowance', contextWindow: 8192, enabled: true, supportsTools: false, supportsVision: false }] });
    expect(result.skippedUnknownPlatform).toBe(0);
    expect(db.prepare('SELECT model_id FROM models WHERE platform=?').all(config.platform)).toEqual([{ model_id: config.model }]);
  });
});

describe('Inferbase wire-format guards and documented free output ceiling', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); getDb().close(); });
  it('filters provider routing/usage receipts while retaining standard completion and usage chunks', async () => {
    const model = 'deepseek-v4-flash';
    const body = `data: ${JSON.stringify({ object: 'routing', model })}\n\n` +
      (await stream(model).text()).replace('data: [DONE]', `data: ${JSON.stringify({ object: 'usage', model, cost_micros: 0 })}\n\ndata: [DONE]`);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    const chunks = [];
    for await (const chunk of new InferbaseProvider().streamChatCompletion('test-key', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(c => Array.isArray(c.choices))).toBe(true);
    expect(chunks.at(-1)?.usage?.total_tokens).toBe(4);
  });
  it.each(['routing', 'usage'])('does not silently accept a substituted identity in a %s receipt', async object => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify({ object, model: 'another-model' })}\n\ndata: [DONE]\n\n`));
    const collect = async () => { for await (const _ of new InferbaseProvider().streamChatCompletion('test-key', [], 'deepseek-v4-flash')) { /* drain */ } };
    await expect(collect()).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ object: 'error', error: { message: 'Upstream unavailable' } }, { object: 'chat.completion.chunk' }])('rejects malformed and in-band error events after a valid chunk', async event => {
    const first = { id: 's', object: 'chat.completion.chunk', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response([first, event].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'));
    const collect = async () => { for await (const _ of new InferbaseProvider().streamChatCompletion('test-key', [], 'deepseek-v4-flash')) { /* drain */ } };
    await expect(collect()).rejects.toMatchObject({ status: 502 });
  });
  it.each([undefined, 32768, 128])('normalizes max_tokens=%s without requesting paid capacity', async max_tokens => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('deepseek-v4-flash')));
    await new InferbaseProvider().chatCompletion('test-key', [], 'deepseek-v4-flash', { max_tokens });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).max_tokens).toBe(max_tokens === 128 ? 128 : 1024);
  });
});
