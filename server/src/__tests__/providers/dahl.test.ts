import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { DahlProvider, DAHL_BALANCE_URL, DAHL_BASE_URL } from '../../providers/dahl.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { getDb, initDb } from '../../db/index.js';

const model = 'MiniMaxAI/MiniMax-M2.7';
const completion = (content: string) => ({
  id: 'dahl-test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 45, completion_tokens: 12, total_tokens: 57 },
});
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const invalidKey = { error: { code: 'invalid_api_key', message: 'invalid API token', type: 'authentication_error' } };

describe('Gonka DAHL provider', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });
  afterEach(() => vi.restoreAllMocks());

  it('registers a keyed provider and recognizes DAHL key files and auth JSON', () => {
    expect(getProvider('dahl')).toBeInstanceOf(DahlProvider);
    expect(getProvider('dahl')!.keyless).toBe(false);
    expect(getProvider('dahl')!.hasQuotaProbe).toBe(true);
    expect(parseKeysFromFile('DAHL_API_KEY=dahl_test_not_a_real_key', 'keys.env').keys[0].platform).toBe('dahl');
    expect(AUTH_JSON_PROVIDER_MAP.dahl).toBe('dahl');
  });

  it('sends chat to the DAHL base URL and keeps parameters, usage and attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('OK')));
    const response = await getProvider('dahl')!.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model, {
      max_tokens: 128, temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    });
    expect(fetch.mock.calls[0][0]).toBe(`${DAHL_BASE_URL}/chat/completions`);
    const init = fetch.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2, tools: [{ function: { name: 'lookup' } }] });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion('OK').usage);
    expect(response._routed_via).toEqual({ platform: 'dahl', model });
  });

  it('moves the inline <think> block MiniMax returns into reasoning_content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('<think>\nThe user wants one word.\n</think>\n\nok')));
    const response = await getProvider('dahl')!.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model);
    expect(response.choices[0].message.content).toBe('ok');
    expect(response.choices[0].message.reasoning_content).toContain('The user wants one word.');
  });

  it('streams OpenAI SSE that ends with a DONE sentinel', async () => {
    const chunks = [
      { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'O' }, finish_reason: null }] },
      { id: 's', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'K' }, finish_reason: 'stop' }] },
    ];
    const body = `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const output: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('dahl')!.streamChatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model)) output.push(chunk);
    expect(output.flatMap(c => c.choices).map(c => c.delta.content ?? '').join('')).toBe('OK');
    expect(output.some(c => c.choices.some(x => x.finish_reason === 'stop'))).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).stream).toBe(true);
  });

  it('validates against the authenticated key balance, not the public model list', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ available_tokens: 0 }));
    // A key with nothing allocated yet is still a real key: the user fixes it in /account.
    await expect(getProvider('dahl')!.validateKey('test-key')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(DAHL_BALANCE_URL);
    expect(fetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
  });

  it('rejects a missing or invalid key with the upstream reason', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(invalidKey, 401));
    await expect(getProvider('dahl')!.validateKey('invalid')).resolves.toMatchObject({ valid: false });
  });

  it.each([429, 500, 503])('leaves other validation responses inconclusive (%s)', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Something else' } }, status, { 'Retry-After': '10' }));
    await expect(getProvider('dahl')!.validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 10_000 });
  });

  it('does not accept a 200 without a numeric balance', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>maintenance</html>', { status: 200 }));
    await expect(getProvider('dahl')!.validateKey('test-key')).rejects.toMatchObject({ status: 200 });
  });

  it('keeps the model_concurrency 429 and its retry delay so routing can fail over', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({
      error: { code: 'model_concurrency', message: 'This model is at concurrency capacity.', type: 'rate_limit_error' },
    }, 429, { 'Retry-After': '10' }));
    await expect(getProvider('dahl')!.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model))
      .rejects.toMatchObject({ status: 429, retryAfterMs: 10_000 });
  });

  it('surfaces an unallocated or exhausted key as 402', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'available tokens exhausted' } }, 402));
    await expect(getProvider('dahl')!.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model))
      .rejects.toMatchObject({ status: 402 });
  });

  it('records the per-key token balance as a quota_api observation', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ available_tokens: 99_998_765 }));
    await expect(getProvider('dahl')!.fetchQuota('test-key', { platform: 'dahl', keyId: 7 })).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(DAHL_BALANCE_URL);
    const row = getDb().prepare(
      "SELECT metric, limit_value, remaining_value, source FROM provider_quota_state WHERE platform = 'dahl' AND source = 'quota_api'",
    ).get();
    expect(row).toEqual({ metric: 'tokens', limit_value: null, remaining_value: 99_998_765, source: 'quota_api' });
  });
});
