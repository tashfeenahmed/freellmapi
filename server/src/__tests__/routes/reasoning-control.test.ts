import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { effortFromAnthropicThinking } from '../../routes/anthropic.js';

// Request-side reasoning control (reasoning_effort / reasoning:{effort} /
// Anthropic thinking:{budget_tokens}) and inline <think> extraction, driven
// end-to-end through the real routes with a mocked Groq upstream (P2 #16).

let dashToken = '';

async function request(app: Express, path: string, body: any, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, text, body: json };
}

function openaiHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function anthropicHeaders() {
  return { 'x-api-key': getUnifiedApiKey(), 'anthropic-version': '2023-06-01' };
}

// Mock Groq's upstream with a canned JSON response and capture the forwarded body.
function mockJson(response: any) {
  const origFetch = global.fetch;
  const captured: { body: any } = { body: null };
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
      captured.body = JSON.parse(String((init as RequestInit).body));
      return { ok: true, json: () => Promise.resolve(response) } as any;
    }
    return origFetch(url as any, init);
  });
  return captured;
}

function mockStream(body: string) {
  const origFetch = global.fetch;
  const captured: { body: any } = { body: null };
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
      captured.body = JSON.parse(String((init as RequestInit).body));
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return origFetch(url as any, init);
  });
  return captured;
}

const textCompletion = (text: string) => ({
  id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

const sse = (...payloads: (object | string)[]) =>
  payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 's1', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-120b',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** Parse the OpenAI SSE body into its data payloads. */
function sseData(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') continue;
    try { out.push(JSON.parse(data)); } catch { /* ignore */ }
  }
  return out;
}

/** Parse an Anthropic SSE body into ordered {event, data} pairs. */
function anthropicEvents(text: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    let event: string | null = null;
    let data: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event && data) { try { events.push({ event, data: JSON.parse(data) }); } catch { /* ignore */ } }
  }
  return events;
}

describe('request-side reasoning control (end-to-end)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    const { status } = await request(app, '/api/keys',
      { platform: 'groq', key: 'gsk_reasoning_control_test', label: 't' },
      { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(201);
  });

  afterEach(() => vi.restoreAllMocks());

  it('accepts reasoning_effort and forwards it to a supporting platform', async () => {
    const captured = mockJson(textCompletion('ok'));
    const { status } = await request(app, '/v1/chat/completions', {
      model: 'auto', reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    expect(captured.body.reasoning_effort).toBe('low');
  });

  it('tolerates the object form and normalizes it to reasoning_effort on the wire', async () => {
    const captured = mockJson(textCompletion('ok'));
    const { status } = await request(app, '/v1/chat/completions', {
      model: 'auto', reasoning: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    expect(captured.body.reasoning_effort).toBe('high');
    expect(captured.body).not.toHaveProperty('reasoning');
  });

  it('a no-knob request sends nothing reasoning-related upstream (default unchanged)', async () => {
    const captured = mockJson(textCompletion('ok'));
    const { status } = await request(app, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    expect(JSON.stringify(captured.body)).not.toContain('reasoning');
  });

  it("clamps an off-scale effort to the nearest supported one instead of 400-ing (#619)", async () => {
    const captured = mockJson(textCompletion('ok'));
    const { status } = await request(app, '/v1/chat/completions', {
      model: 'auto', reasoning_effort: 'max',
      messages: [{ role: 'user', content: 'hi' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    expect(captured.body.reasoning_effort).toBe('high');
  });

  it('drops an unrecognizable effort and completes on the provider default', async () => {
    const captured = mockJson(textCompletion('ok'));
    const { status } = await request(app, '/v1/chat/completions', {
      model: 'auto', reasoning_effort: 'turbo-plus',
      messages: [{ role: 'user', content: 'hi' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    expect(captured.body).not.toHaveProperty('reasoning_effort');
  });

  it('accepts thinking_budget without leaking it to openai-compat upstreams', async () => {
    const captured = mockJson(textCompletion('ok'));
    const { status } = await request(app, '/v1/chat/completions', {
      model: 'auto', reasoning_effort: 'high', thinking_budget: 12000,
      messages: [{ role: 'user', content: 'hi' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    expect(captured.body.reasoning_effort).toBe('high');
    expect(captured.body).not.toHaveProperty('thinking_budget');
  });

  it('non-streaming: inline <think> is extracted into reasoning_content in the response', async () => {
    mockJson(textCompletion('<think>let me add</think>The answer is 4.'));
    const { status, body } = await request(app, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: '2+2?' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    const msg = body.choices[0].message;
    expect(msg.content).toBe('The answer is 4.');
    expect(msg.reasoning_content).toBe('let me add');
  });

  it('streaming: think text arrives as delta.reasoning_content, never as content', async () => {
    mockStream(sse(
      chunk({ role: 'assistant' }),
      chunk({ content: '<think>step ' }),
      chunk({ content: 'one</thi' }),
      chunk({ content: 'nk>Final answer' }),
      chunk({}, 'stop'),
      '[DONE]',
    ));
    const { status, text } = await request(app, '/v1/chat/completions', {
      model: 'auto', stream: true,
      messages: [{ role: 'user', content: 'q' }],
    }, openaiHeaders());
    expect(status).toBe(200);
    const frames = sseData(text);
    const reasoning = frames.map(f => f.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    const content = frames.map(f => f.choices?.[0]?.delta?.content ?? '').join('');
    expect(reasoning).toBe('step one');
    expect(content).toBe('Final answer');
    expect(content).not.toContain('<think>');
  });
});

describe('Anthropic surface: thinking knob + thinking blocks', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    const { status } = await request(app, '/api/keys',
      { platform: 'groq', key: 'gsk_reasoning_anthropic_test', label: 't' },
      { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(201);
  });

  afterEach(() => vi.restoreAllMocks());

  it('maps thinking:{budget_tokens} onto the internal effort scale', () => {
    expect(effortFromAnthropicThinking(undefined)).toBeUndefined();
    expect(effortFromAnthropicThinking(null)).toBeUndefined();
    expect(effortFromAnthropicThinking({ type: 'disabled' })).toBe('none');
    expect(effortFromAnthropicThinking({ type: 'enabled' })).toBe('medium');
    expect(effortFromAnthropicThinking({ type: 'enabled', budget_tokens: 1024 })).toBe('low');
    expect(effortFromAnthropicThinking({ type: 'enabled', budget_tokens: 8000 })).toBe('medium');
    expect(effortFromAnthropicThinking({ type: 'enabled', budget_tokens: 32000 })).toBe('high');
  });

  it("accepts thinking types outside the enabled/disabled enum (#632)", () => {
    // 'adaptive' means the model manages its own budget — no knob forwarded.
    expect(effortFromAnthropicThinking({ type: 'adaptive' })).toBeUndefined();
    expect(effortFromAnthropicThinking({ type: 'auto' })).toBeUndefined();
    // An explicit budget still wins, whatever the mode is called.
    expect(effortFromAnthropicThinking({ type: 'adaptive', budget_tokens: 32000 })).toBe('high');
    expect(effortFromAnthropicThinking({ type: 'off' })).toBe('none');
  });

  it("a thinking:{type:'adaptive'} request completes instead of 400-ing (#632)", async () => {
    const captured = mockJson(textCompletion('done'));
    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicHeaders());
    expect(status).toBe(200);
    expect(captured.body).not.toHaveProperty('reasoning_effort');
  });

  it('forwards the mapped effort to the provider', async () => {
    const captured = mockJson(textCompletion('done'));
    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      thinking: { type: 'enabled', budget_tokens: 32000 },
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicHeaders());
    expect(status).toBe(200);
    expect(captured.body.reasoning_effort).toBe('high');
  });

  it('sends nothing when the client sent no thinking knob', async () => {
    const captured = mockJson(textCompletion('done'));
    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicHeaders());
    expect(status).toBe(200);
    expect(JSON.stringify(captured.body)).not.toContain('reasoning');
  });

  it('non-streaming: reasoning output renders as a thinking block before the text block', async () => {
    mockJson(textCompletion('<think>consider the sum</think>It is 4.'));
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: '2+2?' }],
    }, anthropicHeaders());
    expect(status).toBe(200);
    expect(body.content).toEqual([
      { type: 'thinking', thinking: 'consider the sum', signature: '' },
      { type: 'text', text: 'It is 4.' },
    ]);
  });

  it('streaming: thinking block precedes the text block in the SSE sequence', async () => {
    mockStream(sse(
      chunk({ role: 'assistant' }),
      chunk({ content: '<think>plan</think>Answer text' }),
      chunk({}, 'stop'),
      '[DONE]',
    ));
    const { status, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'q' }],
    }, anthropicHeaders());
    expect(status).toBe(200);
    const events = anthropicEvents(text);
    const starts = events.filter(e => e.event === 'content_block_start');
    expect(starts.map(s => s.data.content_block.type)).toEqual(['thinking', 'text']);
    const thinkingText = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
      .map(e => e.data.delta.thinking).join('');
    expect(thinkingText).toBe('plan');
    const answerText = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
      .map(e => e.data.delta.text).join('');
    expect(answerText).toBe('Answer text');
    expect(answerText).not.toContain('<think>');
  });
});
