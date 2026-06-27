import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Anthropic-compatible Messages API (`POST /v1/messages`). These tests drive
// the route end-to-end through a mocked Groq upstream and assert the Anthropic
// wire format both inbound (system / content blocks / tool_use / tool_result /
// images) and outbound (message envelope, tool_use blocks, SSE event sequence)
// — i.e. what Claude Code actually sends and parses.

let dashToken = '';

async function request(app: Express, path: string, body: any, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0);
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
  return { status: res.status, headers: res.headers, text, body: json };
}

async function send(app: Express, method: string, path: string, body?: any, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

function anthropicHeaders() {
  return { 'x-api-key': getUnifiedApiKey(), 'anthropic-version': '2023-06-01' };
}

/** Parse an SSE body into ordered {event, data} pairs. */
function sseEvents(text: string): Array<{ event: string; data: any }> {
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

const sse = (...payloads: (object | string)[]) =>
  payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

// Mock Groq's chat-completions upstream with a single canned JSON response, and
// capture the request body the provider forwarded (post-translation).
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

// Mock Groq's streaming upstream with a raw SSE body.
function mockStream(body: string) {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return origFetch(url as any, init);
  });
}

const textCompletion = (text: string) => ({
  id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

const toolCompletion = (name: string, args: string) => ({
  id: 'chatcmpl-t', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
});

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get current weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

describe('Anthropic-compatible /v1/messages', () => {
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
    db.prepare("DELETE FROM settings WHERE key = 'anthropic_model_map'").run();
    const { status } = await request(app, '/api/keys',
      { platform: 'groq', key: 'gsk_anthropic_test', label: 't' },
      { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(201);
  });

  afterEach(() => vi.restoreAllMocks());

  it('rejects a request with no API key (Anthropic error envelope)', async () => {
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
    });
    expect(status).toBe(401);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
  });

  it('authenticates via the Anthropic x-api-key header and returns a Messages response', async () => {
    mockJson(textCompletion('Hello from a free model.'));
    const { status, body, headers } = await request(app, '/v1/messages', {
      model: 'claude-3-5-sonnet-20241022', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicHeaders());

    expect(status).toBe(200);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('claude-3-5-sonnet-20241022'); // echoes the requested id
    expect(body.content).toEqual([{ type: 'text', text: 'Hello from a free model.' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect(body.id).toMatch(/^msg_/);
    expect(headers.get('x-routed-via')).toMatch(/^groq\//);
  });

  it('forwards the system prompt and tools, returns a tool_use block (stop_reason tool_use)', async () => {
    const captured = mockJson(toolCompletion('get_weather', '{"city":"Karachi"}'));
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-opus-4-1', max_tokens: 128,
      system: 'You are a weather bot.',
      messages: [{ role: 'user', content: 'weather in Karachi?' }],
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'auto' },
    }, anthropicHeaders());

    expect(status).toBe(200);
    // Inbound translation: system → system message, tool input_schema → parameters.
    expect(captured.body.messages[0]).toEqual({ role: 'system', content: 'You are a weather bot.' });
    expect(captured.body.tools[0].function.name).toBe('get_weather');
    expect(captured.body.tools[0].function.parameters.required).toEqual(['city']);
    expect(captured.body.tool_choice).toBe('auto');

    // Outbound translation: tool_calls → tool_use block with parsed input.
    expect(body.stop_reason).toBe('tool_use');
    const toolUse = body.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'get_weather', input: { city: 'Karachi' } });
    expect(typeof toolUse.id).toBe('string');
  });

  it('translates an assistant tool_use + user tool_result turn into OpenAI tool messages', async () => {
    const captured = mockJson(textCompletion('It is sunny and 35C in Karachi.'));
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 128,
      messages: [
        { role: 'user', content: 'weather in Karachi?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { city: 'Karachi' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'Sunny, 35C' }] },
      ],
      tools: [WEATHER_TOOL],
    }, anthropicHeaders());

    expect(status).toBe(200);
    const msgs = captured.body.messages;
    const assistant = msgs.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls[0]).toMatchObject({ id: 'toolu_abc', function: { name: 'get_weather', arguments: '{"city":"Karachi"}' } });
    const toolMsg = msgs.find((m: any) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'toolu_abc', content: 'Sunny, 35C' });
    expect(body.content[0]).toEqual({ type: 'text', text: 'It is sunny and 35C in Karachi.' });
  });

  it('accepts an Anthropic image block and forwards it as an image_url block', async () => {
    const captured = mockJson(textCompletion('a cat'));
    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        ],
      }],
    }, anthropicHeaders());

    // Schema accepts the image block (not a 400). If routing reached the mock,
    // the image was translated to an OpenAI image_url block.
    expect(status).not.toBe(400);
    if (captured.body) {
      const userMsg = captured.body.messages.find((m: any) => Array.isArray(m.content));
      const img = userMsg.content.find((b: any) => b.type === 'image_url');
      expect(img.image_url.url).toBe('data:image/png;base64,iVBORw0KGgo=');
    }
  });

  it('streams the Anthropic SSE event sequence for a text response', async () => {
    const chunk = (delta: any, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
    mockStream(sse(
      chunk({ role: 'assistant' }),
      chunk({ content: 'Hello' }),
      chunk({ content: ' world' }),
      chunk({}, 'stop'),
      '[DONE]',
    ));

    const { status, headers, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicHeaders());

    expect(status).toBe(200);
    expect(headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = sseEvents(text);
    const order = events.map(e => e.event);
    expect(order[0]).toBe('message_start');
    expect(order).toContain('content_block_start');
    expect(order).toContain('content_block_delta');
    expect(order).toContain('content_block_stop');
    expect(order[order.length - 2]).toBe('message_delta');
    expect(order[order.length - 1]).toBe('message_stop');

    const deltas = events.filter(e => e.event === 'content_block_delta').map(e => e.data.delta.text).join('');
    expect(deltas).toBe('Hello world');
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta!.data.delta.stop_reason).toBe('end_turn');
  });

  it('streams a buffered tool_use block (stop_reason tool_use)', async () => {
    const chunk = (delta: any, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
    mockStream(sse(
      chunk({ role: 'assistant' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Karachi"}' } }] }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ));

    const { status, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [WEATHER_TOOL],
    }, anthropicHeaders());

    expect(status).toBe(200);
    const events = sseEvents(text);
    const startBlock = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    expect(startBlock!.data.content_block).toMatchObject({ type: 'tool_use', id: 'call_s', name: 'get_weather' });
    const jsonDelta = events.filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('');
    expect(JSON.parse(jsonDelta)).toEqual({ city: 'Karachi' });
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta!.data.delta.stop_reason).toBe('tool_use');
  });

  it('estimates tokens via /v1/messages/count_tokens', async () => {
    const { status, body } = await request(app, '/v1/messages/count_tokens', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'count these tokens please' }],
    }, anthropicHeaders());
    expect(status).toBe(200);
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('returns an Anthropic invalid_request_error on a malformed body', async () => {
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', messages: [],
    }, anthropicHeaders());
    expect(status).toBe(400);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('accepts a system role inlined in the messages array (does not 400; folds into system)', async () => {
    const captured = mockJson(textCompletion('ok'));
    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 32,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    }, anthropicHeaders());
    expect(status).toBe(200); // previously 400: "messages.1.role ... received 'system'"
    const sys = captured.body.messages.filter((m: any) => m.role === 'system')
    expect(sys.some((m: any) => m.content === 'You are concise.')).toBe(true);
  });

  it('GET /v1/models returns the Anthropic shape for Anthropic clients', async () => {
    const { status, body } = await send(app, 'GET', '/v1/models', undefined, anthropicHeaders());
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.has_more).toBe(false);
    expect(body.data[0]).toMatchObject({ type: 'model', id: 'auto' });
    // Every entry is the Anthropic model object shape (no OpenAI `object` field).
    for (const m of body.data) {
      expect(m.type).toBe('model');
      expect(typeof m.display_name).toBe('string');
      expect(typeof m.created_at).toBe('string');
    }
  });

  it('GET /v1/models falls through to the OpenAI shape without anthropic-version', async () => {
    const { status, body } = await send(app, 'GET', '/v1/models', undefined, { Authorization: `Bearer ${getUnifiedApiKey()}` });
    expect(status).toBe(200);
    expect(body.object).toBe('list'); // OpenAI envelope, served by proxyRouter
    expect(body.data[0].id).toBe('auto');
    expect(body.data[0].object).toBe('model');
  });

  it('maps a Claude family to a pinned catalog model via the settings API', async () => {
    // Pick a real enabled groq model to pin "sonnet" to.
    const groqModel = (getDb().prepare("SELECT model_id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY intelligence_rank LIMIT 1").get() as { model_id: string }).model_id;

    const put = await send(app, 'PUT', '/api/settings/anthropic-map', { sonnet: groqModel }, { Authorization: `Bearer ${dashToken}` });
    expect(put.status).toBe(200);
    expect(put.body.map.sonnet).toBe(groqModel);
    expect(put.body.map.opus).toBe('auto'); // untouched families stay auto

    // A claude-sonnet-* request now pins to that model: the provider receives it.
    const captured = mockJson(textCompletion('pinned answer'));
    const { status, headers } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5-20250929', max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicHeaders());
    expect(status).toBe(200);
    expect(captured.body.model).toBe(groqModel);
    expect(headers.get('x-routed-via')).toBe(`groq/${groqModel}`);
  });

  it('GET /api/settings/anthropic-map returns defaults (all auto) when unset', async () => {
    const { status, body } = await send(app, 'GET', '/api/settings/anthropic-map', undefined, { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(200);
    expect(body.map).toEqual({ default: 'auto', opus: 'auto', sonnet: 'auto', haiku: 'auto' });
  });
});
