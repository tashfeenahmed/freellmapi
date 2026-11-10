import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { isLoopback } from '../../routes/ollama.js';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  server.close();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, body: json, headers: response.headers };
}

function seedGroq(): void {
  const key = encrypt('gsk_ollama_surface_test');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'ollama-test', ?, ?, ?, 'healthy', 1)
  `).run(key.encrypted, key.iv, key.authTag);
}

describe('Ollama emulation', () => {
  let app: Express;
  let dashboardToken: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashboardToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    setSetting('ollama_emulation', 'off');
    seedGroq();
  });

  afterEach(() => vi.restoreAllMocks());

  it('is closed by default and opens without auth only on loopback', async () => {
    expect((await request(app, 'GET', '/api/tags')).status).toBe(404);
    setSetting('ollama_emulation', 'open-loopback');
    const tags = await request(app, 'GET', '/api/tags');
    expect(tags.status).toBe(200);
    expect(tags.body.models.length).toBeGreaterThan(0);
    // Plain semver — a prerelease suffix compares below the base version for
    // clients that gate features on a minimum Ollama version.
    expect((await request(app, 'GET', '/api/version')).body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('closes open-loopback to every caller when DISABLE_LOCAL_TRUST=true; key-required still works', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    process.env.DISABLE_LOCAL_TRUST = 'true';
    try {
      expect((await request(app, 'GET', '/api/tags')).status).toBe(403);
      setSetting('ollama_emulation', 'key-required');
      expect((await request(app, 'GET', '/api/tags')).status).toBe(401);
      const keyed = await request(app, 'GET', '/api/tags', undefined, { Authorization: `Bearer ${getUnifiedApiKey()}` });
      expect(keyed.status).toBe(200);
    } finally {
      delete process.env.DISABLE_LOCAL_TRUST;
    }
  });

  it('advertises auto plus only available models, and accepts :latest names', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const tags = await request(app, 'GET', '/api/tags');
    expect(tags.status).toBe(200);
    expect(tags.body.models[0].name).toBe('auto');
    const shown = await request(app, 'POST', '/api/show', { model: `${tags.body.models[1].name}:latest` });
    expect(shown.status).toBe(200);
    expect(shown.body.modified_at).toBeTruthy();
  });

  it('answers load/unload probes without calling any provider', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const fetchSpy = vi.spyOn(global, 'fetch');
    const load = await request(app, 'POST', '/api/chat', { model: 'auto', messages: [] });
    expect(load.status).toBe(200);
    expect(load.body.done_reason).toBe('load');
    const unload = await request(app, 'POST', '/api/generate', { model: 'auto', prompt: '', keep_alive: 0 });
    expect(unload.body.done_reason).toBe('unload');
    expect(unload.body.response).toBe('');
    const upstreamCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).startsWith('http') && !String(url).includes('127.0.0.1'));
    expect(upstreamCalls).toHaveLength(0);
  });

  it('streams generate frames with a generate-shaped terminal frame', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        return new Response(
          'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return originalFetch(url, init);
    });
    const response = await request(app, 'POST', '/api/generate', { model: 'auto', prompt: 'say hi' });
    expect(response.status).toBe(200);
    const frames = response.text.trim().split('\n').map(line => JSON.parse(line));
    expect(frames[0].response).toBe('hi');
    const last = frames.at(-1);
    // Terminal frame must be generate-shaped: `response`, never `message`.
    expect(last.response).toBe('');
    expect(last.message).toBeUndefined();
    expect(last.done).toBe(true);
    expect(Array.isArray(last.context)).toBe(true);
    expect(last.eval_duration).toBeGreaterThan(0);
  });

  it('accepts the real legacy embeddings body ({model, prompt})', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const response = await request(app, 'POST', '/api/embeddings', { model: 'auto', prompt: 'embed me' });
    // No embedding provider is seeded, so upstream fails — but the request
    // must pass validation (not 400 invalid request).
    expect(response.status).not.toBe(400);
  });

  it('returns 401 for a stale dashboard session on the shared embeddings path', async () => {
    setSetting('ollama_emulation', 'off');
    const response = await request(app, 'POST', '/api/embeddings', {}, {
      Authorization: 'Bearer stale-session-token',
    });
    expect(response.status).toBe(401);
  });

  it('does not treat LAN peers as loopback clients', () => {
    const peer = (remoteAddress: string, forwarded?: string) => ({
      socket: { remoteAddress },
      httpVersion: '1.1',
      headers: { host: 'localhost:11434', ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) },
    }) as any;
    expect(isLoopback(peer('127.0.0.1'))).toBe(true);
    expect(isLoopback(peer('::1'))).toBe(true);
    expect(isLoopback(peer('::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopback(peer('192.168.1.20'))).toBe(false);
    expect(isLoopback(peer('10.0.0.5'))).toBe(false);
    expect(isLoopback(peer('127.0.0.1', '203.0.113.5'))).toBe(false);
    // A forwarded chain can only be verified through TRUST_PROXY; a bare
    // request object has none, so even a loopback claim is refused.
    expect(isLoopback(peer('127.0.0.1', '127.0.0.1'))).toBe(false);
    expect(isLoopback(peer('127.0.0.1', '127.0.0.1, 203.0.113.5'))).toBe(false);
  });

  // Regression: open-loopback served keyless inference to any client that
  // reached a same-host reverse proxy and wrote X-Forwarded-For: 127.0.0.1
  // (nginx appends the real address after it, so the first hop is the
  // attacker's). The real socket in this test is loopback, as it is behind
  // such a proxy.
  it('refuses keyless inference to spoofed loopback forwarding headers', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    for (const headers of [
      { 'X-Forwarded-For': '127.0.0.1, 203.0.113.5' },
      { 'X-Forwarded-For': '127.0.0.1' },
      { 'X-Real-IP': '127.0.0.1' },
      { Forwarded: 'for=127.0.0.1' },
    ] as Record<string, string>[]) {
      const tags = await request(app, 'GET', '/api/tags', undefined, headers);
      expect(tags.status, JSON.stringify(headers)).toBe(403);
      const chat = await request(app, 'POST', '/api/chat', {
        model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false,
      }, headers);
      expect(chat.status, JSON.stringify(headers)).toBe(403);
    }
    // A direct local client keeps working.
    expect((await request(app, 'GET', '/api/tags')).status).toBe(200);
  });

  it('emits Ollama-compatible NDJSON chat frames', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        return new Response(
          'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":"one"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":" two"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return originalFetch(url, init);
    });
    const response = await request(app, 'POST', '/api/chat', {
      model: 'auto',
      messages: [{ role: 'user', content: 'count' }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const frames = response.text.trim().split('\n').map(line => JSON.parse(line));
    expect(frames.slice(0, 2).map(frame => frame.message.content)).toEqual(['one', ' two']);
    expect(frames.at(-1).done).toBe(true);
    expect(frames.at(-1).done_reason).toBe('stop');
  });

  it('correlates Ollama tool results with the preceding OpenAI tool call', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    let upstreamBody: any;
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          id: 'chatcmpl-ollama-tool',
          object: 'chat.completion',
          created: 1,
          model: 'openai/gpt-oss-120b',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'The file is ready.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url, init);
    });

    const response = await request(app, 'POST', '/api/chat', {
      model: 'auto',
      stream: false,
      messages: [
        { role: 'user', content: 'Read README.md' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: {
              name: 'read_file',
              arguments: { path: 'README.md' },
            },
          }],
        },
        {
          role: 'tool',
          tool_name: 'read_file',
          content: '# FreeLLMAPI',
        },
      ],
    });

    expect(response.status).toBe(200);
    const assistant = upstreamBody.messages[1];
    const tool = upstreamBody.messages[2];
    expect(assistant.tool_calls[0].id).toBeTruthy();
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  it('requires the unified bearer key in key-required mode', async () => {
    setSetting('ollama_emulation', 'key-required');
    expect((await request(app, 'GET', '/api/tags')).status).toBe(401);
    expect((await request(app, 'GET', '/api/tags', undefined, {
      Authorization: `Bearer ${getUnifiedApiKey()}`,
    })).status).toBe(200);
  });

  it('preserves the dashboard side of the legacy embeddings path collision', async () => {
    setSetting('ollama_emulation', 'open-loopback');
    const ollama = await request(app, 'POST', '/api/embeddings', {});
    expect(ollama.status).toBe(400);
    expect(ollama.body.error).toContain('invalid request');

    const dashboard = await request(app, 'POST', '/api/embeddings', {}, {
      Authorization: `Bearer ${dashboardToken}`,
    });
    expect(dashboard.status).toBe(404);
    expect(dashboard.text).not.toContain('invalid request');
  });
});
