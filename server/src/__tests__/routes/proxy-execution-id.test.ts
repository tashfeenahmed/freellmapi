import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// #1102 follow-up: `execution_id` must be on EVERY JSON body the chat
// completion route sends — success and error alike — or clients cannot rely on
// it. A field that is present only when the call succeeds is worse than no
// field: the failing case is exactly the one you need the id for. It always
// carries the same value as the X-Request-ID header. Streamed frames are
// deliberately excluded (the id rides the header there).

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

const sse = (...payloads: (object | string)[]) =>
  payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

/** Mock the groq upstream: a clean answer, or a hard non-retryable failure. */
function mockUpstream(opts: { fail?: boolean; stream?: boolean } = {}) {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (!urlStr.includes('api.groq.com/openai/v1/chat/completions')) return origFetch(url as any, init as any);
    if (opts.fail) {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers(),
        json: () => Promise.resolve({ error: { message: 'invalid api key' } }),
      } as any;
    }
    if (opts.stream) {
      const chunk = (delta: object, finish: string | null) => ({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'groq/compound-mini',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      return new Response(
        sse(chunk({ role: 'assistant' }, null), chunk({ content: 'hi' }, null), chunk({}, 'stop'), '[DONE]'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-exec', object: 'chat.completion', created: 1, model: 'groq/compound-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('execution_id on chat completion bodies (#1102)', () => {
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
    const addKey = await request(app, 'POST', '/api/keys',
      { platform: 'groq', key: 'gsk_execution_id_test_key', label: 'execution-id' });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('non-streaming success carries execution_id matching the X-Request-ID header', async () => {
    mockUpstream();
    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/compound-mini', messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(typeof body.execution_id).toBe('string');
    expect(body.execution_id).toBe(headers.get('x-request-id'));
    // Additive only: the OpenAI-shaped payload is untouched.
    expect(body.choices[0].message.content).toBe('hello');
  });

  it('the 400 validation rejection carries execution_id', async () => {
    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/compound-mini', messages: 'not-an-array',
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.execution_id).toBe(headers.get('x-request-id'));
  });

  it('the 502 provider-error body carries execution_id', async () => {
    mockUpstream({ fail: true });
    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/compound-mini', messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(status).toBe(502);
    expect(body.error).toBeTruthy();
    expect(body.execution_id).toBe(headers.get('x-request-id'));
  });

  it('streamed frames stay clean — the id rides the header, not every chunk', async () => {
    mockUpstream({ stream: true });
    const r = await request(app, 'POST', '/v1/chat/completions', {
      model: 'groq/compound-mini', stream: true, messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());

    expect(r.status).toBe(200);
    expect(r.headers.get('x-request-id')).toBeTruthy();
    const frames = r.text.split('\n')
      .filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]')
      .map(l => JSON.parse(l.slice(6)));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.execution_id).toBeUndefined();
  });
});
