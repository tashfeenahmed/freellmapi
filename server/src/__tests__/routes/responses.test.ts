import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Mock only routeRequest so we don't need real provider keys; keep the rest of
// the router module (recordSuccess / recordRateLimitHit) intact.
const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { setStickyModel } from '../../routes/proxy.js';

function fakeRoute(provider: any) {
  return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model' };
}

async function post(app: Express, path: string, body: any, key?: string, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
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

  it('stream: records ttfb on the first reasoning token, not the first visible text (#764)', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() { throw new Error('should not be called'); },
      async *streamChatCompletion() {
        // Reasoning models stream thinking before any visible text. ttfb must
        // count the first token of ANY kind; a real delay between the
        // reasoning frame and the first text frame makes the two moments
        // measurable in the requests row.
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { reasoning_content: 'thinking hard…', content: null }, finish_reason: null }] };
        await new Promise(r => setTimeout(r, 400));
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] };
        yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      },
    }));

    const { status, text } = await post(app, '/v1/responses', { input: 'hi', stream: true }, key);
    expect(status).toBe(200);
    expect(text).toContain('event: response.completed');
    const rows = getDb().prepare("SELECT status, latency_ms, ttfb_ms FROM requests ORDER BY id DESC LIMIT 1").all() as any[];
    expect(rows[0].status).toBe('success');
    expect(rows[0].ttfb_ms).not.toBeNull();
    // ttfb must be the reasoning-head moment (well before the text token that
    // triggers the commit), not the flush time ≈ latency.
    expect(rows[0].ttfb_ms).toBeLessThan(rows[0].latency_ms - 250);
    // The completed Response reports the thinking tokens truthfully instead of
    // a hardcoded 0: 'thinking hard…' is 14 chars → ceil(14/4) = 4.
    const completed = text.split('event: response.completed')[1];
    const payload = JSON.parse(completed.slice(completed.indexOf('{')));
    expect(payload.response.usage.output_tokens_details.reasoning_tokens).toBe(4);
  });

  it('non-stream: reports reasoning_tokens from the provider usage when advertised', async () => {
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() {
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'answer', reasoning_content: 'thinking' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 6, total_tokens: 9, completion_tokens_details: { reasoning_tokens: 2 } },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));

    const { status, text } = await post(app, '/v1/responses', { input: 'hi', stream: false }, key);
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.usage.output_tokens_details.reasoning_tokens).toBe(2);
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

  it('routes built-in Responses tools through tool-capable models', async () => {
    mockRouteRequest.mockClear();
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() {
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));

    const { status } = await post(app, '/v1/responses', {
      input: 'say hello',
      tools: [{
        type: 'local_shell',
        name: 'exec_command',
        description: 'Run a local shell command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
      }],
    }, key);

    expect(status).toBe(200);
    const lastCall = mockRouteRequest.mock.calls.at(-1);
    expect(lastCall?.[4]).toBe(true);
  });

  it('non-stream: returns invalid_request_error when provider API 400s exhaust routing', async () => {
    mockRouteRequest.mockImplementation((_estimated, skipKeys) => {
      if (skipKeys?.size) {
        throw Object.assign(new Error('All models exhausted'), { status: 429 });
      }
      return fakeRoute({
        async chatCompletion() {
          throw Object.assign(
            new Error('Google API error 400: Invalid JSON payload received. Unknown name "x-google-enum-descriptions"'),
            { status: 400 },
          );
        },
        async *streamChatCompletion() { /* unused */ },
      });
    });

    const { status, text } = await post(app, '/v1/responses', { input: 'hi', stream: false }, key);
    const body = JSON.parse(text);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('rejected the request as invalid');
  });
});

// #579 gave this endpoint the same model resolution /v1/chat/completions has —
// explicit model > sticky session > auto — but shipped without a regression
// test. This is it. routeRequest is mocked, so the assertions read the routing
// DECISION off its arguments: [2] is the preferred (pinned/sticky) model db id
// and [6] is the strict chain an explicit model resolves to.
describe('POST /v1/responses model routing priority (#579)', () => {
  let app: Express;
  let key: string;
  let pinnedId = 0;
  let stickyId = 0;
  let disabledId = 0;

  // Unique model ids make each model its own unify group, so an explicit
  // request resolves to exactly one row and the chain assertion is unambiguous.
  function addModel(modelId: string, priority: number, enabled = true): number {
    const db = getDb();
    const inserted = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools
      )
      VALUES ('groq', ?, ?, ?, ?, 'Small', NULL, NULL, NULL, NULL, '~1M', 128000, ?, 0, 1)
    `).run(modelId, `Responses Priority ${modelId}`, priority, priority, enabled ? 1 : 0);
    const id = Number(inserted.lastInsertRowid);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
    const profile = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
    if (profile) {
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
        .run(Number(profile.value), id, priority);
    }
    return id;
  }

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    const db = getDb();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    pinnedId = addModel('pinned-responses-model', 1);
    stickyId = addModel('sticky-responses-model', 2);
    disabledId = addModel('disabled-responses-model', 3, false);
  });

  beforeEach(() => {
    mockRouteRequest.mockReset();
    mockRouteRequest.mockReturnValue(fakeRoute({
      async chatCompletion() {
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
      async *streamChatCompletion() { /* unused */ },
    }));
  });

  // With a session header the sticky key is the header itself, so the message
  // list here is irrelevant — but the REQUEST must carry an assistant turn for
  // getStickyModel to read the map at all.
  const followUp = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'again' },
  ];

  function routingCall() {
    const call = mockRouteRequest.mock.calls.at(-1);
    return { preferredModelDbId: call?.[2] as number | undefined, chain: call?.[6] as { model_db_id: number }[] | undefined };
  }

  it('an explicit model wins over a sticky session', async () => {
    setStickyModel([], stickyId, 'sess-explicit-wins');
    const { status } = await post(app, '/v1/responses', {
      model: 'pinned-responses-model',
      input: followUp,
    }, key, { 'x-session-id': 'sess-explicit-wins' });

    expect(status).toBe(200);
    const { preferredModelDbId, chain } = routingCall();
    expect(chain?.map(row => row.model_db_id)).toEqual([pinnedId]);
    expect(preferredModelDbId).not.toBe(stickyId);
  });

  it('a sticky session wins over auto routing when no model is sent', async () => {
    setStickyModel([], stickyId, 'sess-sticky-wins');
    const { status } = await post(app, '/v1/responses', {
      input: followUp,
    }, key, { 'x-session-id': 'sess-sticky-wins' });

    expect(status).toBe(200);
    const { preferredModelDbId, chain } = routingCall();
    expect(preferredModelDbId).toBe(stickyId);
    expect(chain).toBeUndefined();
  });

  it('auto routing applies when there is neither an explicit model nor a sticky session', async () => {
    const { status } = await post(app, '/v1/responses', {
      input: followUp,
    }, key, { 'x-session-id': 'sess-no-sticky' });

    expect(status).toBe(200);
    const { preferredModelDbId, chain } = routingCall();
    expect(preferredModelDbId).toBeUndefined();
    expect(chain).toBeUndefined();
  });

  it.each([
    ['unknown', 'no-such-model-anywhere'],
    ['disabled', 'disabled-responses-model'],
  ])('returns 400 model_not_found for an %s explicit model', async (_flavor, model) => {
    void disabledId;
    const { status, text } = await post(app, '/v1/responses', { model, input: 'hi' }, key);
    expect(status).toBe(400);
    const body = JSON.parse(text);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.type).toBe('invalid_request_error');
    expect(mockRouteRequest).not.toHaveBeenCalled();
  });
});
