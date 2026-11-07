import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { OnomeoProvider, ONOMEO_BASE_URL } from '../../providers/onomeo.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const modelList = { object: 'list', data: [{ id: 'glm-5.3', object: 'model' }] };
const completion = (model?: string) => ({ id: 'c', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('onomeo registration and import', () => {
  it('registers the adapter, the env import alias and one shared quota pool (#1460)', () => {
    expect(getProvider('onomeo')).toBeInstanceOf(OnomeoProvider);
    expect(getProvider('onomeo')!.keyless).toBe(false);
    expect(parseKeysFromFile('ONOMEO_API_KEY=test-key', 'keys.env').keys[0].platform).toBe('onomeo');
    expect(AUTH_JSON_PROVIDER_MAP.onomeo).toBe('onomeo');
    // One 30-calls/5-hour allowance shared across every free model, so a 429
    // on one model benches the platform, not the model.
    expect(inferPoolForPlatform('onomeo', 'glm-5.3')).toBe(inferPoolForPlatform('onomeo', 'qwen3.8-max'));
  });
});

describe('onomeo key validation', () => {
  it('accepts a model list from the read-only probe', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(modelList));
    await expect(new OnomeoProvider().validateKey('test-key')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`${ONOMEO_BASE_URL}/models`);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
  });

  it('marks 401 bad_key invalid', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { code: 'bad_key', message: 'Invalid API key, or the key has been revoked.' } }, 401));
    await expect(new OnomeoProvider().validateKey('bad-key')).resolves.toMatchObject({ valid: false });
  });

  // The whole point of the override: base validationResult() treats 403 as an
  // invalid key, and onomeo returns 403 account_quota/network_quota for a
  // VALID key that used its 5-hour calls. Auto-disabling there would evict a
  // good key that recovers on its own five hours later.
  it.each([
    [403, { error: { code: 'account_quota' } }],
    [403, { error: { code: 'network_quota' } }],
    [429, { error: { code: 'site_busy' } }],
    [429, { error: { code: 'too_fast' } }],
    [503, { error: { message: 'upstream down' } }],
  ])('keeps quota/throttle/outage %s inconclusive, never invalid', async (status, body) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body, status, { 'Retry-After': '300' }));
    await expect(new OnomeoProvider().validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 300_000 });
  });

  it.each(['{}', 'null', '<html>Sign in</html>'])('rejects malformed probe bodies', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    await expect(new OnomeoProvider().validateKey('test-key')).rejects.toMatchObject({ status: 502 });
  });
});

describe('onomeo chat', () => {
  it.each(['glm-5.2', undefined, '', null, 123])('rejects a substituted or missing completion identity (%s)', async model => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model }));
    await expect(new OnomeoProvider().chatCompletion('test-key', [], 'deepseek-v4-flash'))
      .rejects.toMatchObject({ status: 502, message: 'onomeo returned a different or missing model identity' });
  });

  it.each(['glm-5.2', undefined, '', null])('rejects a stream identity (%s) before emitting any content', async model => {
    const frame = { id: 'c', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Wrong answer', tool_calls: [] }, finish_reason: null }] };
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const stream = new OnomeoProvider().streamChatCompletion('test-key', [], 'deepseek-v4-flash');
    await expect(stream.next()).rejects.toMatchObject({ status: 502 });
  });

  it('rejects identity changes in later stream frames without leaking their content', async () => {
    const frames = ['glm-4.5-flash', 'glm-5.2'].map(model => `data: ${JSON.stringify({
      id: 'c', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: { content: model }, finish_reason: null }],
    })}\n\n`);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(frames.join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const stream = new OnomeoProvider().streamChatCompletion('test-key', [], 'glm-4.5-flash');
    expect((await stream.next()).value?.choices[0].delta.content).toBe('glm-4.5-flash');
    await expect(stream.next()).rejects.toMatchObject({ status: 502 });
  });

  it('preserves tool-call frames with an exact identity, including a namespaced route', async () => {
    const model = 'stealth/glyph-cluster';
    const tool_calls = [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }];
    const frame = { id: 'c', object: 'chat.completion.chunk', created: 1, model,
      choices: [{ index: 0, delta: { tool_calls }, finish_reason: 'tool_calls' }] };
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const stream = new OnomeoProvider().streamChatCompletion('test-key', [], model);
    expect((await stream.next()).value).toMatchObject(frame);
    expect((await stream.next()).done).toBe(true);
  });

  it('forwards OpenAI-shape completions with attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('glm-5.3')));
    const result = await new OnomeoProvider().chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'glm-5.3', { max_tokens: 512 });
    expect(fetch.mock.calls[0][0]).toBe(`${ONOMEO_BASE_URL}/chat/completions`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'glm-5.3', max_tokens: 512 });
    expect(result.choices[0].message.content).toBe('OK');
    expect(result._routed_via).toEqual({ platform: 'onomeo', model: 'glm-5.3' });
  });

  it('strips the free-tier "— via onomeo.com" signature from a completion', async () => {
    const body = completion('glm-5.2');
    body.choices[0].message.content = '12\nGLM\n\n— via onomeo.com';
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    const result = await new OnomeoProvider().chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'glm-5.2');
    expect(result.choices[0].message.content).toBe('12\nGLM');
  });

  it.each([
    ['as its own final delta (live shape)', ['Hello', ', my friend.', '\n\n— via onomeo.com']],
    ['split across deltas', ['Hello, my friend.', '\n\n— via', ' onomeo.com']],
  ])('strips the signature from a stream %s', async (_name, pieces) => {
    const frames = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      ...pieces.map(content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ].map(f => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', ...f })}\n\n`);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(frames.join('') + 'data: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }));
    const chunks = [];
    for await (const c of new OnomeoProvider().streamChatCompletion('test-key', [], 'deepseek-v4-flash')) chunks.push(c);
    expect(chunks.map(c => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hello, my friend.');
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe('stop');
  });

  it('keeps a stream that only looks like the start of the signature', async () => {
    const frames = ['Use a dash ', '\n—', ' or a comma.'].map(content =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(frames.join('') + 'data: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }));
    const chunks = [];
    for await (const c of new OnomeoProvider().streamChatCompletion('test-key', [], 'm')) chunks.push(c);
    expect(chunks.map(c => c.choices[0]?.delta?.content ?? '').join('')).toBe('Use a dash \n— or a comma.');
  });

  it.each([403, 429])('preserves inference quota HTTP %s as failover-able, not key-fatal', async status => {
    const code = status === 403 ? 'account_quota' : 'site_busy';
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { code } }, status, { 'Retry-After': '60' }));
    await expect(new OnomeoProvider().chatCompletion('test-key', [], 'glm-5.3')).rejects.toMatchObject({ status, retryAfterMs: 60_000 });
  });
});

describe('onomeo catalog gate', () => {
  it('does not seed or discover models; only ingests tier-selected catalog rows', () => {
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM models WHERE platform=?').get('onomeo')).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(db, 'onomeo')).toBe(false);
    const result = applyCatalog(db, { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: [{ platform: 'onomeo', modelId: 'glm-5.3', displayName: 'GLM 5.3', intelligenceRank: 50, speedRank: 50, sizeLabel: '',
        limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: '30 calls / 5 h, shared', contextWindow: 128000,
        enabled: true, supportsTools: true, supportsVision: false }] });
    expect(result.skippedUnknownPlatform).toBe(0);
    expect(db.prepare('SELECT model_id FROM models WHERE platform=?').all('onomeo')).toEqual([{ model_id: 'glm-5.3' }]);
  });
});
