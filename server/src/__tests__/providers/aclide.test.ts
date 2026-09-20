import { afterEach, describe, expect, it, vi } from 'vitest';
import { AclideProvider } from '../../providers/aclide.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform } from '../../lib/key-parser.js';

const model = 'z-ai/glm-4.7-flashx';
const messages = [{ role: 'user' as const, content: 'Say OK' }];
const completed = () => ({
  id: 'resp_test', model, status: 'completed', created_at: 123,
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('ACLIDE Responses adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers the adapter and recognizes imported keys', () => {
    expect(getProvider('aclide')).toBeInstanceOf(AclideProvider);
    expect(detectPlatform('ACLIDE_')).toBe('aclide');
    expect(AUTH_JSON_PROVIDER_MAP.aclide).toBe('aclide');
  });

  it('uses Responses, preserves zero options and normalizes usage', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completed()));
    const result = await new AclideProvider().chatCompletion('test-key', messages, model,
      { max_tokens: 512, temperature: 0, top_p: 0, reasoning_effort: 'low' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://aclide.com/v1/responses');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init?.body))).toEqual({ model, input: messages, store: false, stream: false,
      max_output_tokens: 512, temperature: 0, top_p: 0, reasoning: { effort: 'low' } });
    expect(result.choices[0]).toEqual({ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' });
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } });
    expect(result._routed_via).toEqual({ platform: 'aclide', model });
  });

  it('preserves multimodal input, tool history and JSON schema', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completed(), output: [
      { type: 'function_call', call_id: 'call_2', name: 'weather', arguments: '{}' },
    ] }));
    const result = await new AclideProvider().chatCompletion('k', [
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: ['look', { text: 'here' }, { type: 'image_url', image_url: { url: 'https://example.com/test.png', detail: 'low' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'rain' },
    ], model, { tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' }, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: false,
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' }, strict: true } },
    });
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.input).toEqual([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_text', text: 'here' },
        { type: 'input_image', image_url: 'https://example.com/test.png', detail: 'low' }] },
      { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'rain' },
    ]);
    expect(body.tools).toEqual([{ type: 'function', name: 'weather', parameters: { type: 'object' }, strict: true }]);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'weather' });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.text.format).toEqual({ type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true });
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it.each([
    { model: 'wrong-model' }, { model: undefined }, { output: [] }, { status: 'queued' },
    { status: 'failed', error: { message: 'outage' } },
    { output: [{ type: 'function_call', name: 'missing_call_id' }] },
    { status: 'incomplete', incomplete_details: { reason: 'unknown' } },
  ])('rejects invalid/empty/substituted responses: %j', async override => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completed(), ...override }));
    await expect(new AclideProvider().chatCompletion('k', messages, model)).rejects.toMatchObject({ status: 502 });
  });

  it.each([['max_output_tokens', 'length'], ['content_filter', 'content_filter']])('maps %s to %s', async (reason, finish) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completed(), status: 'incomplete', incomplete_details: { reason } }));
    expect((await new AclideProvider().chatCompletion('k', messages, model)).choices[0].finish_reason).toBe(finish);
  });

  it('maps refusal text without treating it as empty', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completed(), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help.' }] }] }));
    expect((await new AclideProvider().chatCompletion('k', messages, model)).choices[0].message.content).toBe('Cannot help.');
  });

  it('synthesizes indexed tool chunks and opt-in final usage', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => json({ ...completed(), output: [
      ...completed().output, { type: 'function_call', call_id: 'call_a', name: 'weather', arguments: '{}' },
    ] }));
    const chunks = [];
    for await (const chunk of new AclideProvider().streamChatCompletion('k', messages, model, { stream_options: { include_usage: true } })) chunks.push(chunk);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(chunks[2].choices[0].delta.tool_calls?.[0]).toMatchObject({ index: 0, id: 'call_a' });
    expect(chunks.at(-2)?.choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { total_tokens: 15 } });
    const withoutUsage = [];
    for await (const chunk of new AclideProvider().streamChatCompletion('k', messages, model)) withoutUsage.push(chunk);
    expect(withoutUsage.every(chunk => chunk.usage === undefined)).toBe(true);
  });

  it('preserves rate-limit status/backoff for HTML errors', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Unavailable', { status: 429, headers: { 'Retry-After': '25' } }));
    await expect(new AclideProvider().chatCompletion('k', messages, model)).rejects.toMatchObject({ status: 429, retryAfterMs: 25_000 });
  });

  it('validates authenticated rosters and keeps temporary failures inconclusive', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [{ id: model }] }))
      .mockResolvedValueOnce(json({ error: { message: 'Invalid key' } }, 401))
      .mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}));
    const provider = new AclideProvider();
    await expect(provider.validateKey('k')).resolves.toBe(true);
    await expect(provider.validateKey('k')).resolves.toMatchObject({ valid: false, error: expect.stringContaining('Invalid key') });
    await expect(provider.validateKey('k')).rejects.toMatchObject({ status: 503 });
    await expect(provider.validateKey('k')).rejects.toMatchObject({ status: 502 });
  });

  it('cancels body reads on client disconnect or whole-request timeout', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        if (init?.signal?.aborted) controller.error(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    })));
    const controller = new AbortController();
    const pending = new AclideProvider().chatCompletion('k', messages, model, { signal: controller.signal });
    controller.abort(new Error('client disconnected'));
    await expect(pending).rejects.toThrow('client disconnected');
    await expect(new AclideProvider().chatCompletion('k', messages, model, { timeoutMs: 10 })).rejects.toThrow();
  });

  it('rejects unsupported content instead of dropping it', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(new AclideProvider().chatCompletion('k', [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }], model)).rejects.toThrow('content block');
    expect(fetch).not.toHaveBeenCalled();
  });
});
