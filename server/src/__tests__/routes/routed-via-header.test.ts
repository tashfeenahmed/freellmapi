import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// These tests auto-route to custom endpoints, which free-only routing
// (services/free-only.ts) keeps out of automatic routing unless the operator
// opts in. They test endpoint behaviour, not that policy, so they opt in;
// free-only-routing.test.ts covers the policy itself.
const savedFreeOnlySetting = process.env.FREE_ONLY_ALLOW_PLATFORMS;
beforeAll(() => { process.env.FREE_ONLY_ALLOW_PLATFORMS = 'custom'; });
afterAll(() => {
  if (savedFreeOnlySetting === undefined) delete process.env.FREE_ONLY_ALLOW_PLATFORMS;
  else process.env.FREE_ONLY_ALLOW_PLATFORMS = savedFreeOnlySetting;
});

// #619: relays hand out model ids that are not header-safe — Chinese names,
// bracketed variant suffixes, spaces. Splicing one straight into X-Routed-Via
// made Node throw ERR_INVALID_CHAR while writing the response, so a call that
// had already succeeded upstream came back as a failure. Every surface that
// stamps the header is exercised here, streaming and not.
const HOSTILE_MODEL = '我的模型[test] v2';
const BASE_URL = 'http://127.0.0.1:9411/v1';
const EXPECTED = `custom/${HOSTILE_MODEL}`;

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE or plain text */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

/** The header must be a valid RFC 7230 field value AND still name the route. */
function expectRoutedVia(headers: Headers): void {
  const value = headers.get('x-routed-via');
  expect(value).toBeTruthy();
  expect(value).toMatch(/^[\x20-\x7e]*$/);
  expect(decodeURIComponent(value!)).toBe(EXPECTED);
}

const chatCompletion = {
  id: 'chatcmpl-hostile',
  object: 'chat.completion',
  created: 1,
  model: HOSTILE_MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

const streamBody = [
  `data: {"id":"chatcmpl-hostile","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n`,
  `data: {"id":"chatcmpl-hostile","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  'data: [DONE]\n\n',
].join('');

/** Answer the custom relay with JSON or SSE depending on what was asked for. */
function mockRelay(): void {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('127.0.0.1:9411')) {
      const sent = JSON.parse(String((init as RequestInit)?.body ?? '{}'));
      if (sent.stream) {
        const encoder = new TextEncoder();
        return {
          ok: true,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(streamBody));
              controller.close();
            },
          }),
        } as any;
      }
      return { ok: true, headers: new Headers(), json: async () => chatCompletion } as any;
    }
    return origFetch(url as any, init);
  });
}

describe('X-Routed-Via with a header-hostile model id (#619)', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();

    const reg = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: BASE_URL,
      model: HOSTILE_MODEL,
      apiKey: 'relay-token',
    }, { Authorization: `Bearer ${dashToken}` });
    expect(reg.status).toBe(201);
    mockRelay();
  });

  afterEach(() => vi.restoreAllMocks());

  it('answers /v1/chat/completions instead of dying on the header', async () => {
    const { status, headers, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: HOSTILE_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('hello');
    expectRoutedVia(headers);
  });

  it('answers a streaming /v1/chat/completions', async () => {
    const { status, headers, text } = await request(app, 'POST', '/v1/chat/completions', {
      model: HOSTILE_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, authHeaders());

    expect(status).toBe(200);
    expect(text).toContain('data: [DONE]');
    expectRoutedVia(headers);
  });

  it('answers /v1/completions, streaming and not', async () => {
    const plain = await request(app, 'POST', '/v1/completions', {
      model: HOSTILE_MODEL,
      prompt: 'hi',
    }, authHeaders());
    expect(plain.status).toBe(200);
    expectRoutedVia(plain.headers);

    const streamed = await request(app, 'POST', '/v1/completions', {
      model: HOSTILE_MODEL,
      prompt: 'hi',
      stream: true,
    }, authHeaders());
    expect(streamed.status).toBe(200);
    expectRoutedVia(streamed.headers);
  });

  it('answers /v1/responses, streaming and not', async () => {
    const plain = await request(app, 'POST', '/v1/responses', {
      model: HOSTILE_MODEL,
      input: 'hi',
    }, authHeaders());
    expect(plain.status).toBe(200);
    expectRoutedVia(plain.headers);

    const streamed = await request(app, 'POST', '/v1/responses', {
      model: HOSTILE_MODEL,
      input: 'hi',
      stream: true,
    }, authHeaders());
    expect(streamed.status).toBe(200);
    expectRoutedVia(streamed.headers);
  });

  it('answers /v1/messages, streaming and not', async () => {
    const anthropicAuth = { 'x-api-key': getUnifiedApiKey(), 'anthropic-version': '2023-06-01' };

    const plain = await request(app, 'POST', '/v1/messages', {
      model: HOSTILE_MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
    }, anthropicAuth);
    expect(plain.status).toBe(200);
    expectRoutedVia(plain.headers);

    const streamed = await request(app, 'POST', '/v1/messages', {
      model: HOSTILE_MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, anthropicAuth);
    expect(streamed.status).toBe(200);
    expectRoutedVia(streamed.headers);
  });

  it('answers the native Gemini surface', async () => {
    const { status, headers } = await request(
      app,
      'POST',
      `/v1beta/models/gemini-2.5-flash:generateContent?key=${getUnifiedApiKey()}`,
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    );
    expect(status).toBe(200);
    expectRoutedVia(headers);
  });
});
