import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Characterization tests for the drifts the shared fallback loop
// (lib/fallback-loop.ts) converged on the Anthropic /v1/messages surface:
//   - drift #3: exhaustion now uses the shared body — a 400 invalid_request_error
//     when every routed provider rejected the request as invalid, not always a
//     429 rate_limit_error, and the message matches the other surfaces.
//   - drift #4: the inline tool-call dialect rescue (a model that serialized its
//     tool call as TEXT) now runs here too, on both the non-stream and stream
//     paths, translated to Anthropic tool_use blocks.
//   - drift #1: streaming commit is held until the first meaningful content, so a
//     dialect turn that opens the stream but turns out unparseable fails over.

const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

function fakeRoute(provider: any) {
  return {
    provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1,
    platform: 'fake', displayName: 'Fake Model', rpdLimit: null, tpdLimit: null,
  };
}

function jsonProvider(response: any) {
  return { async chatCompletion() { return response; }, async *streamChatCompletion(): AsyncGenerator<any> { /* unused */ } };
}

function streamProvider(gen: () => AsyncGenerator<any>) {
  return { async chatCompletion() { throw new Error('nope'); }, streamChatCompletion: gen };
}

async function post(app: Express, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, text, body: json };
}

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

const chunk = (delta: any, finish: string | null = null) => ({
  id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }],
});

const WEATHER_TOOL = {
  name: 'get_weather', description: 'Get current weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

describe('/v1/messages shared-loop convergence', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    mockRouteRequest.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('exhaustion returns a 400 invalid_request_error when every provider rejected the request (drift #3)', async () => {
    mockRouteRequest.mockImplementation((_estimated: number, skipKeys?: Set<string>) => {
      if (skipKeys?.size) throw Object.assign(new Error('All models exhausted'), { status: 429 });
      return fakeRoute({
        async chatCompletion() {
          throw Object.assign(new Error('Google API error 400: Invalid JSON payload received. Unknown name "x-google-enum-descriptions"'), { status: 400 });
        },
        async *streamChatCompletion(): AsyncGenerator<any> { /* unused */ },
      });
    });

    const { status, body } = await post(app, { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, key);
    expect(status).toBe(400); // was always 429 before the convergence
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('rejected the request as invalid');
  });

  it('exhaustion returns a 429 rate_limit_error (Anthropic-shaped) when every provider is rate-limited', async () => {
    mockRouteRequest.mockImplementation((_estimated: number, skipKeys?: Set<string>) => {
      if (skipKeys?.size) throw Object.assign(new Error('All models exhausted'), { status: 429 });
      return fakeRoute({
        async chatCompletion() { throw Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 }); },
        async *streamChatCompletion(): AsyncGenerator<any> { /* unused */ },
      });
    });

    const { status, body } = await post(app, { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, key);
    expect(status).toBe(429);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('rate_limit_error');
  });

  it('non-stream: rescues an inline tool-call dialect into an Anthropic tool_use block (drift #4)', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute(jsonProvider({
      id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '<function=get_weather{"city": "Paris"}</function>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
    })));

    const { status, body } = await post(app, {
      model: 'claude-sonnet-4-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: [WEATHER_TOOL],
    }, key);

    expect(status).toBe(200);
    expect(body.stop_reason).toBe('tool_use');
    const toolUse = body.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', name: 'get_weather', input: { city: 'Paris' } });
    // The raw dialect text is not leaked as a text block.
    expect(body.content.some((b: any) => b.type === 'text' && b.text.includes('<function='))).toBe(false);
  });

  it('stream: rescues a streamed inline dialect into a tool_use block (drift #4 + #1 hold window)', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute(streamProvider(async function* () {
      yield chunk({ role: 'assistant' });
      yield chunk({ content: '<function=get_weather{"city":' });
      yield chunk({ content: ' "Berlin"}</function>' });
      yield chunk({}, 'stop');
    })));

    const { status, text } = await post(app, {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [WEATHER_TOOL],
    }, key);

    expect(status).toBe(200);
    const events = sseEvents(text);
    const toolStart = events.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    expect(toolStart!.data.content_block).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    const jsonDelta = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('');
    expect(JSON.parse(jsonDelta)).toEqual({ city: 'Berlin' });
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect(msgDelta!.data.delta.stop_reason).toBe('tool_use');
    // The raw dialect never reached the client as a text_delta.
    expect(text).not.toContain('<function=');
  });

  it('stream: preserves provider thought_signature on tool_use blocks (#487)', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute(streamProvider(async function* () {
      yield chunk({ role: 'assistant' });
      yield chunk({
        tool_calls: [{
          index: 0,
          id: 'call_stream_sig',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
          thought_signature: 'sig_stream_tool_1',
        }],
      });
      yield chunk({}, 'tool_calls');
    })));

    const { status, text } = await post(app, {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [WEATHER_TOOL],
    }, key);

    expect(status).toBe(200);
    const events = sseEvents(text);
    const toolStart = events.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
    expect(toolStart!.data.content_block).toMatchObject({
      id: 'call_stream_sig',
      name: 'get_weather',
      thought_signature: 'sig_stream_tool_1',
    });
    const jsonDelta = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('');
    expect(JSON.parse(jsonDelta)).toEqual({ city: 'Oslo' });
  });

  it('stream: an unparseable dialect that opens the stream fails over invisibly (drift #1)', async () => {
    mockRouteRequest
      .mockReturnValueOnce(fakeRoute(streamProvider(async function* () {
        yield chunk({ role: 'assistant' });
        // Detected-but-unparseable dialect (degraded id token) — must not commit.
        yield chunk({ content: '<|tool_call_begin|> chatcmpl-tool-bde5 <|tool_call_argument_begin|> {"city": "X"}' });
        yield chunk({}, 'stop');
      })))
      .mockReturnValueOnce(fakeRoute(streamProvider(async function* () {
        yield chunk({ role: 'assistant', content: 'Recovered by the next model.' });
        yield chunk({}, 'stop');
      })));

    const { status, text } = await post(app, {
      model: 'claude-sonnet-4-5', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
    }, key);

    expect(status).toBe(200);
    const events = sseEvents(text);
    // Exactly one message_start — the first (unparseable) attempt never committed.
    expect(events.filter(e => e.event === 'message_start')).toHaveLength(1);
    const deltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta').map(e => e.data.delta.text).join('');
    expect(deltas).toBe('Recovered by the next model.');
    expect(text).not.toContain('<|tool_call_begin|>');
  });
});
