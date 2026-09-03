import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers)
        ? { Authorization: `Bearer ${dashToken}` }
        : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  server.close();

  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {}

  return { status: res.status, body: json, raw };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

/** Build an SSE Response whose frames deliberately contain NO usage block. */
function sseResponseNoUsage(text = 'hi') {
  const encoder = new TextEncoder();
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    'data: [DONE]\n\n',
  ];
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    headers: new Headers(),
  };
}

/** SSE Response whose final frame carries an upstream usage block. */
function sseResponseWithUsage() {
  const encoder = new TextEncoder();
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n`,
    'data: [DONE]\n\n',
  ];
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    headers: new Headers(),
  };
}

/** SSE Response with usage-only frame emitted MID-STREAM (before the finish chunk). */
function sseResponseUsageMidStream() {
  const encoder = new TextEncoder();
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    'data: [DONE]\n\n',
  ];
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    headers: new Headers(),
  };
}

/** SSE Response with usage attached to a CONTENT frame (non-final position). */
function sseResponseUsageOnContentFrame() {
  const encoder = new TextEncoder();
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    'data: [DONE]\n\n',
  ];
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    }),
    headers: new Headers(),
  };
}

function usageFrames(raw: string) {
  return raw
    .split('\n\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((p) => p !== '[DONE]')
    .map((p) => JSON.parse(p))
    .filter((f) => f && f.usage);
}

describe('Streaming usage-frame fallback injection', () => {
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

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_stream_usage_test',
      label: 'stream-usage',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects an estimated usage frame when the upstream never echoes one and include_usage is requested', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return sseResponseNoUsage() as any;
      }
      return origFetch(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    // Usage-only frame: empty choices, estimated positive token counts.
    expect(frames[0].choices).toEqual([]);
    expect(frames[0].usage.prompt_tokens).toBeGreaterThan(0);
    expect(frames[0].usage.completion_tokens).toBeGreaterThan(0);
    expect(frames[0].usage.total_tokens).toBe(
      frames[0].usage.prompt_tokens + frames[0].usage.completion_tokens,
    );
    // Synthetic counts are flagged: a client doing cost accounting can tell
    // this block apart from an upstream's real one.
    expect(frames[0].usage.estimated).toBe(true);
  });

  it('injects an estimated usage frame when the upstream never echoes one, even without include_usage', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return sseResponseNoUsage() as any;
      }
      return origFetch(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, authHeaders());

    expect(status).toBe(200);
    // #1084: agents read `usage` for context-window display even when they
    // never requested include_usage; a missing frame used to show 0. The
    // estimate is injected regardless of the client's stream_options.
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0].choices).toEqual([]);
    expect(frames[0].usage.prompt_tokens).toBeGreaterThan(0);
    expect(frames[0].usage.completion_tokens).toBeGreaterThan(0);
    expect(frames[0].usage.estimated).toBe(true);
  });

  it('injects estimated usage into a NON-streaming response when the upstream omits usage', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-nousage',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'hi there' },
              finish_reason: 'stop',
            }],
            // No `usage` block — the #1084 scenario.
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(
      body.usage.prompt_tokens + body.usage.completion_tokens,
    );
    expect(body.usage.estimated).toBe(true);
  });

  it('passes through the upstream usage frame unchanged when one is present', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return sseResponseWithUsage() as any;
      }
      return origFetch(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0].usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
    });
    // Real upstream counts are never relabelled as estimates.
    expect(frames[0].usage).not.toHaveProperty('estimated');
  });

  it('does NOT inject an estimate when the upstream emits a usage frame mid-stream (non-final position)', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return sseResponseUsageMidStream() as any;
      }
      return origFetch(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    // The upstream's real mid-stream frame must be the ONLY usage frame —
    // no estimate injected on top of it.
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0].usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
    });
    // Stream must still carry the full content ("hel" + "lo").
    const allFrames = raw
      .split('\n\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((p) => p !== '[DONE]')
      .map((p) => JSON.parse(p));
    const content = allFrames
      .flatMap((f) => f.choices?.map((c: any) => c.delta?.content ?? '') ?? [])
      .join('');
    expect(content).toBe('hello');
  });

  it('does NOT inject an estimate when usage rides on a content frame (non-final position)', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return sseResponseUsageOnContentFrame() as any;
      }
      return origFetch(url, init);
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }, authHeaders());

    expect(status).toBe(200);
    // Real usage must be preserved and the estimate must NOT fire.
    const frames = usageFrames(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0].usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
    });
  });
});
