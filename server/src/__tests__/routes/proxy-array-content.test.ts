import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('OpenAI multimodal array content', () => {
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
      key: 'gsk_array_content_test',
      label: 'array-content',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts content as a string (the legacy shape)', async () => {
    // Provider call will fail (no real key), but schema validation must pass —
    // we assert it isn't rejected with a 400 zod error.
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, authHeaders());
    expect(status).not.toBe(400);
    if (status === 400) {
      // Diagnostic if regression: show the validation error.
      throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    }
  });

  it('accepts content as a text-only multimodal array', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello from opencode-style client' }],
      }],
    }, authHeaders());
    expect(status).not.toBe(400);
    if (status === 400) {
      throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    }
  });

  it('accepts mixed text + image_url blocks (image blocks are silently dropped)', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
        ],
      }],
    }, authHeaders());
    expect(status).not.toBe(400);
  });

  it('successfully routes an array-content request and gets a 200 (mocked groq)', async () => {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        // Sanity check that the array shape made it through to the upstream call.
        const body = JSON.parse(String((init as RequestInit).body));
        expect(Array.isArray(body.messages[0].content)).toBe(true);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-array', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'got it' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      }],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('got it');
  });

  it('rejects an empty array as missing content', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [], // top-level empty messages
    }, authHeaders());
    expect(status).toBe(400);
  });

  it('accepts an assistant message with empty content and no tool_calls (#165)', async () => {
    // OpenAI accepts empty/null assistant turns in history; we coerce to "" and
    // forward rather than 400-ing a payload OpenAI would take. The request then
    // routes (and fails downstream on the fake key) — the point is it is NOT a
    // 400 schema rejection.
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [] },
        { role: 'user', content: 'continue' },
      ],
    }, authHeaders());
    expect(status).not.toBe(400);
    if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
  });

  // #200: code agents (AionUI, OpenCode, Qwen Code) fail on the SECOND request
  // of a session because their follow-up history carries shapes the strict
  // schema rejected. Each case below is a real second-turn payload pattern.
  describe('agent second-turn shapes (#200)', () => {
    it('accepts Gemini-part-style content blocks without a type field', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [
          { role: 'user', content: [{ text: 'hi' }] },
          { role: 'assistant', content: [{ text: 'hello!' }] },
          { role: 'user', content: [{ text: 'ok' }] },
        ],
      }, authHeaders());
      expect(status).not.toBe(400);
      if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    });

    it('accepts echoed tool_calls without type and with object arguments', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: null,
            // type dropped + arguments already parsed to an object — the way
            // Gemini-lineage agents replay our tool_calls back at us.
            tool_calls: [{ id: 'call_1', function: { name: 'ls', arguments: { path: '.' } } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'file1.ts' },
          { role: 'user', content: 'thanks' },
        ],
      }, authHeaders());
      expect(status).not.toBe(400);
      if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    });

    it('accepts the developer role (newer OpenAI SDK system prompt)', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [
          { role: 'developer', content: 'You are a coding agent.' },
          { role: 'user', content: 'hi' },
        ],
      }, authHeaders());
      expect(status).not.toBe(400);
      if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    });

    it('reports the failing path in 400 validation errors', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 42 }],
      }, authHeaders());
      expect(status).toBe(400);
      // Path-qualified detail ("messages.0...") instead of a bare "Invalid input"
      expect(body.error.message).toMatch(/messages\.0/);
    });

    it('accepts tool_calls with missing or empty ids and pairs tool results by order', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: null,
            // Gemini-lineage: no id at all on the first, empty id on the second.
            tool_calls: [
              { function: { name: 'ls', arguments: '{}' } },
              { id: '', function: { name: 'pwd', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: 'file1.ts' },
          { role: 'tool', tool_call_id: '', content: '/home' },
          { role: 'user', content: 'thanks' },
        ],
      }, authHeaders());
      expect(status).not.toBe(400);
      if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    });

    it('accepts a tool message with null content (tool returned nothing)', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [
          { role: 'user', content: 'do it' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'noop', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: null },
          { role: 'user', content: 'ok' },
        ],
      }, authHeaders());
      expect(status).not.toBe(400);
      if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    });

    it('accepts the legacy function role in history', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'function', name: 'get_weather', content: '{"temp": 20}' },
          { role: 'user', content: 'thanks' },
        ],
      }, authHeaders());
      expect(status).not.toBe(400);
      if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    });

    it('accepts max_tokens <= 0 (treated as no limit)', async () => {
      for (const value of [-1, 0]) {
        const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
          max_tokens: value,
          messages: [{ role: 'user', content: 'hi' }],
        }, authHeaders());
        expect(status).not.toBe(400);
        if (status === 400) throw new Error(`unexpected 400 for max_tokens ${value}: ${JSON.stringify(body)}`);
      }
    });

    it('accepts tool_choice "any" and tools without a type field', async () => {
      const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
        tool_choice: 'any',
        tools: [{ function: { name: 'ls', parameters: { type: 'object', properties: {} } } }],
        messages: [{ role: 'user', content: 'hi' }],
      }, authHeaders());
      expect(status).not.toBe(400);
      if (status === 400) throw new Error(`unexpected 400: ${JSON.stringify(body)}`);
    });
  });
});
