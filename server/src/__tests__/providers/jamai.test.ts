import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk, ChatMessage } from '@freellmapi/shared/types.js';
import { JamaiProvider, jamaiHeaders } from '../../providers/jamai.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { supportedParametersFor } from '../../lib/sampling-params.js';

const key = 'proj_example:jamai_pat_testsecret';
const model = 'ellm/Qwen/Qwen3.6-35B-A3B';
const messages: ChatMessage[] = [{ role: 'user', content: 'Say OK' }];
const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
const completion = () => ({ id: 'test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
const frame = (delta: unknown, finish_reason: string | null = null) => ({ id: 'test', object: 'chat.completion.chunk', created: 1, model,
  choices: [{ index: 0, delta, finish_reason }] });
const sse = (frames: unknown[]) => new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n');
async function collect(source: AsyncGenerator<ChatCompletionChunk>) {
  const out: ChatCompletionChunk[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

describe('JamAI project-scoped adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers and imports paired and composite credentials, never a project ID alone', () => {
    expect(getProvider('jamai')).toBeInstanceOf(JamaiProvider);
    expect(AUTH_JSON_PROVIDER_MAP.jamai).toBe('jamai');
    expect(parseKeysFromFile(`JAMAI_API_KEY=jamai_pat_testsecret\nJAMAI_PROJECT_ID=proj_example`, 'keys.env').keys)
      .toMatchObject([{ platform: 'jamai', rawKey: `JAMAI_API_KEY=${key}` }]);
    expect(parseKeysFromFile('JAMAI_PROJECT_ID=proj_example', 'keys.env').keys).toEqual([]);
    expect(parseKeysFromFile(`JAMAI_KEY=${key}`, 'keys.env').keys[0]?.rawKey).toBe(`JAMAI_KEY=${key}`);
    expect(supportedParametersFor('jamai', { tools: true })).toContain('tool_choice');
    expect(supportedParametersFor('jamai', { tools: true })).not.toEqual(expect.arrayContaining(['parallel_tool_calls', 'response_format']));
  });

  it.each(['', 'jamai_pat_only', 'proj_example:', ':jamai_pat_testsecret', 'proj_example:jamai_pat_testsecret\r\nX-Evil: true'])('rejects malformed credentials before network: %j', async credential => {
    const fetch = vi.spyOn(global, 'fetch');
    expect(() => jamaiHeaders(credential)).toThrow('project ID');
    await expect(new JamaiProvider().validateKey(credential)).resolves.toMatchObject({ valid: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends the PAT and project only to the pinned origin and validates without inference', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ id: model }] }));
    await expect(new JamaiProvider().validateKey(key)).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.jamaibase.com/api/v1/models');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: {
      Authorization: 'Bearer jamai_pat_testsecret', 'X-PROJECT-ID': 'proj_example',
    } });
  });

  it('keeps outages and challenges inconclusive without exposing echoed request headers', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ request_headers: { authorization: key } }, 401))
      .mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({}, 403, { 'cf-mitigated': 'challenge' }))
      .mockResolvedValueOnce(json({ nope: [] }));
    const provider = new JamaiProvider();
    expect(JSON.stringify(await provider.validateKey(key))).not.toContain('testsecret');
    await expect(provider.validateKey(key)).rejects.toMatchObject({ status: 429 });
    await expect(provider.validateKey(key)).rejects.toMatchObject({ status: 403 });
    await expect(provider.validateKey(key)).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('preserves native image/audio and tool history, strips internals, forwards only documented options', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const input: ChatMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }, { type: 'input_audio', input_audio: { data: 'YWJj', format: 'wav' } }] },
      { role: 'assistant', content: null, reasoning_content: 'private', tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't', content: 'OK' },
    ];
    const out = await new JamaiProvider().chatCompletion(key, input, model, { temperature: 0, max_tokens: 1024, contextBudget: 128, seed: 1, stop: 'END' });
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ max_tokens: 128, temperature: 0, stop: ['END'], stream: false });
    expect(body.seed).toBeUndefined();
    expect(body.messages[0]).toEqual(input[0]);
    expect(body.messages[1].reasoning_content).toBeUndefined();
    expect(body.messages[1].tool_calls).toEqual(input[1].tool_calls);
    expect(out._routed_via).toEqual({ platform: 'jamai', model });
  });

  it('accepts a tool-only completion and rejects unsupported structured output', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), choices: [{ index: 0, message: { role: 'assistant', content: null,
      tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    await expect(new JamaiProvider().chatCompletion(key, messages, model)).resolves.toHaveProperty('model', model);
    await expect(new JamaiProvider().chatCompletion(key, messages, model, { response_format: { type: 'json_object' } })).rejects.toMatchObject({ status: 422 });
  });

  it.each([{ model: 'substituted' }, { model: undefined }, { choices: [] }, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }])('rejects invalid completions: %j', async override => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), ...override }));
    await expect(new JamaiProvider().chatCompletion(key, messages, model)).rejects.toMatchObject({ status: 502 });
  });

  it('streams native chunks but rejects substituted, incomplete and error streams', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sse([frame({ content: 'OK' }), frame({}, 'stop')]))
      .mockResolvedValueOnce(sse([{ ...frame({ content: 'wrong' }), model: 'wrong' }]))
      .mockResolvedValueOnce(sse([frame({ content: 'partial' })]))
      .mockResolvedValueOnce(sse([{ error: { request_headers: key } }]));
    const provider = new JamaiProvider();
    expect(await collect(provider.streamChatCompletion(key, messages, model))).toHaveLength(2);
    for (let i = 0; i < 3; i++) {
      const error = await collect(provider.streamChatCompletion(key, messages, model)).catch(e => e);
      expect(error.status).toBe(502);
      expect(String(error)).not.toContain('testsecret');
    }
  });

  it('preserves Retry-After without echoing upstream secrets', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ detail: key, request_headers: { authorization: key } }, 429, { 'Retry-After': '12' }));
    const error = await new JamaiProvider().chatCompletion(key, messages, model).catch(e => e);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 12000 });
    expect(String(error)).not.toContain('testsecret');
  });
});
