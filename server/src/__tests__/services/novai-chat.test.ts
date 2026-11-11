import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { NovaiProvider } from '../../providers/novai.js';

const thinking = 'glm-4.1v-thinking-flash';
const flash = 'glm-4.6v-flash';
const messages = [{ role: 'user' as const, content: 'Reply OK' }];
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const response = (content: string, model = thinking) => ({
  id: 'test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (content: string, model = thinking, finish: string | null = null) => ({
  id: 'test', object: 'chat.completion.chunk', created: 1, model,
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});
const sse = (frames: unknown[]) => new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('NovAI daily-free chat', () => {
  it.each([flash, thinking])('forwards %s through the fixed authenticated endpoint', async model => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(response('OK', model)));
    const result = await new NovaiProvider().chatCompletion('unit-test-key', messages, model, { max_tokens: 128 });
    expect(fetch.mock.calls[0][0]).toBe('https://aiapi-pro.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer unit-test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, messages, max_tokens: 128 });
    expect(result.choices[0].message.content).toBe('OK');
    expect(result.usage).toMatchObject({ total_tokens: 6 });
  });

  it.each(['paid-model', 'cogvideox-flash', 'glm-4.7-flash'])('rejects unapproved chat route %s without a request', async model => {
    const fetch = vi.spyOn(global, 'fetch'); const provider = new NovaiProvider();
    await expect(provider.chatCompletion('test', messages, model)).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion('test', messages, model).next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([['<answer>', '</answer>'], ['<|begin_of_box|>', '<|end_of_box|>']])('separates reasoning and normalizes %s', async (open, close) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(response('<think>reasoning</think>\n' + open + 'OK' + close + '\n')));
    const result = await new NovaiProvider().chatCompletion('test', messages, thinking);
    expect(result.choices[0].message).toMatchObject({ content: 'OK', reasoning_content: 'reasoning' });
  });

  it.each(['Plain answer', 'Literal <answer>example</answer> here', '<ans', ' '.repeat(600) + 'OK'])('preserves non-envelope text %j', async content => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(response(content)));
    expect((await new NovaiProvider().chatCompletion('test', messages, thinking)).choices[0].message.content).toBe(content);
  });

  it('does not strip answer tags on other models', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(response('<answer>literal</answer>', flash)));
    expect((await new NovaiProvider().chatCompletion('test', messages, flash)).choices[0].message.content).toBe('<answer>literal</answer>');
  });

  it('normalizes nested answer/box envelopes in both modes', async () => {
    const body = '<think>reasoning</think>\n<answer><|begin_of_box|>OK<|end_of_box|></answer>';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(response(body)))
      .mockResolvedValueOnce(sse([...body].map(c => frame(c)).concat([frame('', thinking, 'stop')])));
    const provider = new NovaiProvider();
    expect((await provider.chatCompletion('test', messages, thinking)).choices[0].message.content).toBe('OK');
    const output = []; for await (const chunk of provider.streamChatCompletion('test', messages, thinking)) output.push(chunk);
    expect(output.flatMap(c => c.choices.map(x => x.delta.content ?? '')).join('')).toBe('OK');
    expect(output.at(-1)?.choices[0].finish_reason).toBe('stop');
  });

  it.each([['<answer>', '</answer>'], ['<|begin_of_box|>', '<|end_of_box|>']])('handles %s split at every byte and preserves reasoning/finish/usage', async (open, close) => {
    const body = '<think>reasoning</think>\n' + open + 'OK' + close + '\n';
    const frames = [...body].map(c => frame(c));
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([...frames, frame('', thinking, 'stop'), { id: 'test', model: thinking, choices: [], usage: { total_tokens: 10 } }]));
    const output = []; for await (const c of new NovaiProvider().streamChatCompletion('test', messages, thinking)) output.push(c);
    expect(output.flatMap(c => c.choices.map(x => x.delta.content ?? '')).join('')).toBe('OK');
    expect(output.flatMap(c => c.choices.map(x => x.delta.reasoning_content ?? '')).join('')).toBe('reasoning');
    expect(output.some(c => c.choices[0]?.finish_reason === 'stop')).toBe(true);
    expect(output.at(-1)?.usage).toEqual({ total_tokens: 10 });
  });

  it('preserves an interior closing delimiter and flushes an incomplete final delimiter before finish', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([frame('<answer>A</answer>'), frame('B</ans'), frame('', thinking, 'stop')]));
    const output = []; for await (const c of new NovaiProvider().streamChatCompletion('test', messages, thinking)) output.push(c);
    expect(output.map(c => c.choices[0]?.delta.content ?? '').join('')).toBe('A</answer>B</ans');
    expect(output.at(-1)?.choices[0].finish_reason).toBe('stop');
  });

  it('preserves tool deltas alongside normalized text', async () => {
    const tool = { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } };
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([frame('<answer>OK</answer>'), { ...frame(''), choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: 'tool_calls' }] }]));
    const output = []; for await (const c of new NovaiProvider().streamChatCompletion('test', messages, thinking)) output.push(c);
    expect(output.at(-1)?.choices[0].delta.tool_calls).toEqual([tool]);
    expect(output.map(c => c.choices[0]?.delta.content ?? '').join('')).toBe('OK');
  });

  it('rejects substituted identities in both modes before forwarding content', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(response('wrong', 'another-model'))).mockResolvedValueOnce(sse([frame('wrong', 'another-model')]));
    const provider = new NovaiProvider();
    await expect(provider.chatCompletion('test', messages, thinking)).rejects.toMatchObject({ status: 502 });
    await expect(provider.streamChatCompletion('test', messages, thinking).next()).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves upstream throttle status and retry timing for failover', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => json({ error: { message: 'quota exceeded' } }, 429, { 'Retry-After': '60' }));
    const provider = new NovaiProvider();
    await expect(provider.chatCompletion('test', messages, flash)).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
    await expect(provider.streamChatCompletion('test', messages, flash).next()).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
  });
});
