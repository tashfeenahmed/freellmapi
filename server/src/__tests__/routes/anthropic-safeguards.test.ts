import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { extractAnthropicCompat, requestsAutoModeReview, safeguardResultsFor } from '../../routes/anthropic.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Upstream safeguard response metadata compatibility (related to #1589).
//
// FreeLLMAPI converts Anthropic → internal OpenAI-shaped chat and routes it
// through the normal fallback loop; it is not a raw proxy to api.anthropic.com,
// so an upstream that DOES return `safeguard_results` needs the field carried
// through the response, and the client's `safeguards` request field + the
// `anthropic-beta` header need to survive intake instead of being dropped by
// the conversion. These tests drive the route end to end through a mocked
// Groq upstream. The beta header value below is a TEST FIXTURE, not a real
// Anthropic value. The suite checks metadata extraction, not eligibility for
// Anthropic's server-side classifier or no-charge requests.

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
  return { status: res.status, headers: res.headers, text, body: json };
}

function anthropicHeaders(extra: Record<string, string> = {}) {
  return { 'x-api-key': getUnifiedApiKey(), 'anthropic-version': '2023-06-01', ...extra };
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
  const captured: { body: any; headers: any } = { body: null, headers: null };
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
      captured.body = JSON.parse(String((init as RequestInit).body));
      captured.headers = (init as RequestInit).headers;
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

const SAFEGUARD_RESULTS = [
  { classifier: 'test-classifier', verdict: 'allow', checked_at: '2026-11-05T00:00:00Z' },
];

const SAFEGUARDS_REQUEST = [{ type: 'test-safeguard', config: { mode: 'auto' } }];

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get current weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

describe('Anthropic safeguards passthrough (#1589)', () => {
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

  it('extractAnthropicCompat keeps safeguards + the anthropic-beta header, tolerates unknown shapes', () => {
    const compat = extractAnthropicCompat(
      { safeguards: SAFEGUARDS_REQUEST },
      { 'anthropic-beta': 'test-beta-fixture' },
    );
    expect(compat.safeguards).toEqual(SAFEGUARDS_REQUEST);
    expect(compat.anthropicBeta).toBe('test-beta-fixture');
    // Absent fields stay absent; a safeguards value of an unexpected shape is
    // carried as unknown, never rejected.
    expect(extractAnthropicCompat({}, {})).toEqual({});
    expect(extractAnthropicCompat({ safeguards: 'a-string' }, {}).safeguards).toBe('a-string');
    expect(extractAnthropicCompat({}, { 'anthropic-beta': ['a', 'b'] }).anthropicBeta).toBe('a, b');
    expect(extractAnthropicCompat({}, { 'anthropic-beta': [] })).toEqual({});
    expect(extractAnthropicCompat({}, { 'anthropic-beta': '' })).toEqual({});
  });

  it('accepts safeguards + anthropic-beta without forwarding either to an OpenAI upstream', async () => {
    const captured = mockJson(textCompletion('Hello.'));
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: SAFEGUARDS_REQUEST,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    expect(body.type).toBe('message');
    // The OpenAI-compatible upstream would 400 on an unknown top-level field,
    // so the safeguards payload is stripped from the outbound body by
    // construction (the provider builds the body from known fields only)
    // while the route keeps it in the request's compat metadata.
    expect(captured.body).not.toHaveProperty('safeguards');
    expect(new Headers(captured.headers).has('anthropic-beta')).toBe(false);
  });

  it('plumbs upstream safeguard_results into the JSON response unchanged', async () => {
    mockJson({ ...textCompletion('Hello.'), safeguard_results: SAFEGUARD_RESULTS });
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: SAFEGUARDS_REQUEST,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    expect(body.safeguard_results).toEqual(SAFEGUARD_RESULTS);
  });

  it('does not fabricate safeguard_results when the upstream sends none', async () => {
    mockJson(textCompletion('Hello.'));
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: SAFEGUARDS_REQUEST,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    expect(body).not.toHaveProperty('safeguard_results');
  });

  it('plumbs upstream safeguard_results into the SSE message_delta unchanged', async () => {
    const chunk = (delta: any, finish: string | null = null, extra: any = {}) => ({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
    });
    mockStream(sse(
      chunk({ role: 'assistant' }),
      chunk({ content: 'Hello world' }, 'stop', { safeguard_results: SAFEGUARD_RESULTS }),
      '[DONE]',
    ));
    const { status, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: SAFEGUARDS_REQUEST,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    const msgDelta = sseEvents(text).find(e => e.event === 'message_delta');
    // Inside `delta`, where Claude Code reads it (#2011).
    expect(msgDelta!.data.delta.safeguard_results).toEqual(SAFEGUARD_RESULTS);
    expect(msgDelta!.data).not.toHaveProperty('safeguard_results');
  });

  it('keeps safeguard_results from a choice-less final metadata frame', async () => {
    mockStream(sse(
      { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] },
      { id: 'c1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, safeguard_results: SAFEGUARD_RESULTS },
      '[DONE]',
    ));
    const { status, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicHeaders());

    expect(status).toBe(200);
    const deltas = sseEvents(text).filter(e => e.event === 'message_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta.safeguard_results).toEqual(SAFEGUARD_RESULTS);
    expect(deltas[0].data.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
  });

  it('does not fabricate safeguard_results in a stream without upstream results', async () => {
    mockStream(sse(
      { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] },
      '[DONE]',
    ));
    const { status, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: SAFEGUARDS_REQUEST,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    const deltas = sseEvents(text).filter(e => e.event === 'message_delta');
    expect(deltas).toHaveLength(1);
    for (const event of sseEvents(text)) {
      expect(event.data).not.toHaveProperty('safeguard_results');
      if (event.data.delta) expect(event.data.delta).not.toHaveProperty('safeguard_results');
    }
  });

  it('keeps the upstream tool_use id unchanged (no rewriting or prefixing)', async () => {
    mockJson({
      id: 'chatcmpl-t', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_upstream_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Karachi"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-opus-4-1', max_tokens: 128,
      messages: [{ role: 'user', content: 'weather in Karachi?' }],
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'auto' },
    }, anthropicHeaders());

    expect(status).toBe(200);
    const toolUse = body.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.id).toBe('call_upstream_1');
  });

  it('keeps the client tool_use id in the messages sent upstream', async () => {
    const captured = mockJson(textCompletion('Sunny, 35C.'));
    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5', max_tokens: 128,
      messages: [
        { role: 'user', content: 'weather in Karachi?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_client_9', name: 'get_weather', input: { city: 'Karachi' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_client_9', content: 'Sunny, 35C' }] },
      ],
      tools: [WEATHER_TOOL],
    }, anthropicHeaders());

    expect(status).toBe(200);
    const assistant = captured.body.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls[0].id).toBe('toolu_client_9');
    const toolMsg = captured.body.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('toolu_client_9');
  });

  // #2011: the request shape Claude Code 2.1.330 sends in auto mode (captured
  // from a real run against a local mock; classifier_context trimmed).
  const AUTO_MODE_SAFEGUARDS = [{ type: 'dangerous_tool_use', classifier_context: { rules: 'trimmed' } }];
  const UNSUPPORTED = [{ type: 'dangerous_tool_use', status: { type: 'unsupported' } }];

  it('requestsAutoModeReview only matches the dangerous_tool_use safeguard', () => {
    expect(requestsAutoModeReview({ safeguards: AUTO_MODE_SAFEGUARDS })).toBe(true);
    expect(requestsAutoModeReview({ safeguards: [{ type: 'other' }, { type: 'dangerous_tool_use' }] })).toBe(true);
    expect(requestsAutoModeReview({ safeguards: SAFEGUARDS_REQUEST })).toBe(false);
    expect(requestsAutoModeReview({ safeguards: 'dangerous_tool_use' })).toBe(false);
    expect(requestsAutoModeReview({ safeguards: [null, 3] })).toBe(false);
    expect(requestsAutoModeReview({})).toBe(false);
    expect(requestsAutoModeReview(undefined)).toBe(false);
  });

  it('safeguardResultsFor: upstream results win, else unsupported when asked, else nothing', () => {
    const asked = { safeguards: AUTO_MODE_SAFEGUARDS };
    expect(safeguardResultsFor(asked, SAFEGUARD_RESULTS)).toBe(SAFEGUARD_RESULTS);
    expect(safeguardResultsFor(asked, undefined)).toEqual(UNSUPPORTED);
    expect(safeguardResultsFor({}, undefined)).toBeUndefined();
    expect(safeguardResultsFor(undefined, undefined)).toBeUndefined();
    // Never a verdict: no `available` status, no tool_uses map.
    expect(JSON.stringify(safeguardResultsFor(asked, undefined))).not.toMatch(/available|evaluated|tool_uses/);
  });

  it('answers an auto-mode review request with the unsupported status (JSON)', async () => {
    const captured = mockJson(textCompletion('Hello.'));
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: AUTO_MODE_SAFEGUARDS,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    expect(body.safeguard_results).toEqual(UNSUPPORTED);
    // Still never forwarded to the OpenAI-compatible upstream.
    expect(captured.body).not.toHaveProperty('safeguards');
    expect(new Headers(captured.headers).has('anthropic-beta')).toBe(false);
  });

  it('answers an auto-mode review request with the unsupported status in message_delta.delta (SSE)', async () => {
    mockStream(sse(
      { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }] },
      '[DONE]',
    ));
    const { status, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: AUTO_MODE_SAFEGUARDS,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    const events = sseEvents(text);
    const deltas = events.filter(e => e.event === 'message_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta).toEqual({ stop_reason: 'end_turn', stop_sequence: null, safeguard_results: UNSUPPORTED });
    expect(deltas[0].data).not.toHaveProperty('safeguard_results');
    // The full event sequence still ends with message_stop.
    expect(events.at(-1)!.event).toBe('message_stop');
  });

  it('answers unsupported on a tool_use turn too, without touching the tool_use id', async () => {
    mockStream(sse(
      { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_up_7', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lahore"}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ));
    const { status, text } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'weather in Lahore?' }],
      tools: [WEATHER_TOOL],
      safeguards: AUTO_MODE_SAFEGUARDS,
    }, anthropicHeaders({ 'anthropic-beta': 'test-beta-fixture' }));

    expect(status).toBe(200);
    const events = sseEvents(text);
    const start = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    expect(start!.data.content_block.id).toBe('call_up_7');
    const delta = events.find(e => e.event === 'message_delta')!.data.delta;
    expect(delta.stop_reason).toBe('tool_use');
    expect(delta.safeguard_results).toEqual(UNSUPPORTED);
  });

  it('prefers upstream safeguard_results over the unsupported status', async () => {
    mockJson({ ...textCompletion('Hello.'), safeguard_results: SAFEGUARD_RESULTS });
    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      safeguards: AUTO_MODE_SAFEGUARDS,
    }, anthropicHeaders());

    expect(status).toBe(200);
    expect(body.safeguard_results).toEqual(SAFEGUARD_RESULTS);
  });
});
