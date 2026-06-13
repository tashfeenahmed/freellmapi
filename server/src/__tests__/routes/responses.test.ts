import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock only routeRequest so we don't need real provider keys; keep the rest of
// the router module (recordSuccess / recordRateLimitHit) intact.
const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

function fakeRoute(provider: any) {
  return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model' };
}

async function post(app: Express, path: string, body: any, key?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  return { status: res.status, text, contentType: res.headers.get('content-type') ?? '', headers: res.headers };
}

describe('POST /v1/responses (#96)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('rejects requests without a valid unified key (401)', async () => {
    expect((await post(app, '/v1/responses', { input: 'hi' })).status).toBe(401);
    expect((await post(app, '/v1/responses', { input: 'hi' }, 'wrong')).status).toBe(401);
  });

  it('rejects an invalid body (missing input) with 400', async () => {
    expect((await post(app, '/v1/responses', { model: 'auto' }, key)).status).toBe(400);
  });

  // #118: image input isn't carried through the Responses translation yet, so
  // it must hard-fail clearly rather than silently answer blind to the image.
  it('rejects image input with a clear 422 pointing at /v1/chat/completions', async () => {
    const { status, text } = await post(app, '/v1/responses', {
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        ],
      }],
    }, key);
    expect(status).toBe(422);
    expect(JSON.parse(text).error.code).toBe('no_vision_model');
  });

  // #103: the x-api-key header (Anthropic wire format) must authenticate here
  // too, not just on /v1/chat/completions.
  it('accepts the unified key via the x-api-key header', async () => {
    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ input: 'hi' }),
    });
    server.close();
    // Auth passes (not 401); body validity / routing is covered elsewhere.
    expect(res.status).not.toBe(401);
  });

  it('non-stream: returns a completed Responses object with usage', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() {
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from fake' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));

    const { status, text, contentType } = await post(app, '/v1/responses', { input: 'hi', stream: false }, key);
    expect(status).toBe(200);
    expect(contentType).toContain('application/json');
    expect(text.length).toBeGreaterThan(0);
    const body = JSON.parse(text);
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.output_text).toBe('Hello from fake');
    expect(body.output[0]).toMatchObject({ type: 'message', role: 'assistant' });
    expect(body.usage.total_tokens).toBe(7);
  });

  it('stream: emits the Responses SSE event sequence', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() { throw new Error('should not be called'); },
      async *streamChatCompletion() {
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      },
    }));

    const { status, text, contentType } = await post(app, '/v1/responses', { input: 'hi', stream: true }, key);
    expect(status).toBe(200);
    expect(contentType).toContain('text/event-stream');
    for (const ev of ['response.created', 'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.done', 'response.output_item.done', 'response.completed']) {
      expect(text).toContain(`event: ${ev}`);
    }
    expect(text).toContain('"delta":"Hel"');
    expect(text).toContain('"delta":"lo"');
    // the terminal event carries the assembled text
    const completed = text.split('event: response.completed')[1];
    expect(completed).toContain('"output_text":"Hello"');
  });

  it('stream: tool-call deltas produce function_call events with assembled arguments', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() { throw new Error('nope'); },
      async *streamChatCompletion() {
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { arguments: 'ty":"SF"}' } }] }, finish_reason: 'tool_calls' }] };
      },
    }));

    const { text } = await post(app, '/v1/responses', { input: 'weather?', stream: true }, key);
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain('event: response.function_call_arguments.delta');
    expect(text).toContain('event: response.function_call_arguments.done');
    expect(text).toContain('"arguments":"{\\"city\\":\\"SF\\"}"');
  });
});
