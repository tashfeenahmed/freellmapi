import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { encrypt } from '../../lib/crypto.js';
import { getDb, getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';

async function request(app: Express, path: string, body: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  server.close();
  return { status: response.status, text };
}

const frame = (delta: object, finish: string | null = null, extra: object = {}) =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const usage = { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 };

function mockGroqStream(sse: string): void {
  const originalFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return originalFetch(url, init);
  });
}

// Usage on its own choice-less frame (OpenAI include_usage shape).
const usageOwnFrame = frame({ content: 'Hello world' }, 'stop')
  + `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [], usage })}\n\n`
  + 'data: [DONE]\n\n';
// Usage bundled onto the last choice frame.
const usageLastFrame = frame({ content: 'Hello world' }) + frame({}, 'stop', { usage }) + 'data: [DONE]\n\n';
const noUsage = frame({ content: 'Hello world' }, 'stop') + 'data: [DONE]\n\n';

function loggedTokens() {
  return getDb().prepare(
    "SELECT input_tokens, output_tokens FROM requests WHERE status = 'success' ORDER BY id DESC LIMIT 1",
  ).get() as { input_tokens: number; output_tokens: number };
}

describe('streamed Gemini/Ollama turns report the upstream token usage', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    for (const table of ['api_keys', 'requests', 'rate_limit_usage', 'rate_limit_cooldowns']) {
      getDb().prepare(`DELETE FROM ${table}`).run();
    }
    const key = encrypt('gsk_inbound_usage_test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'usage-test', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);
    setSetting('ollama_emulation', 'open-loopback');
  });

  afterEach(() => vi.restoreAllMocks());

  const gemini = () => request(
    app,
    '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    { 'x-goog-api-key': getUnifiedApiKey() },
  );
  const geminiUsage = (text: string) => {
    const frames = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    return frames.at(-1).usageMetadata;
  };

  for (const [label, sse] of [['own frame', usageOwnFrame], ['last choice frame', usageLastFrame]] as const) {
    it(`gemini streamGenerateContent: usage on its ${label}`, async () => {
      mockGroqStream(sse);
      const { status, text } = await gemini();
      expect(status).toBe(200);
      expect(geminiUsage(text)).toEqual({ promptTokenCount: 1234, candidatesTokenCount: 56, totalTokenCount: 1290 });
      expect(loggedTokens()).toEqual({ input_tokens: 1234, output_tokens: 56 });
    });

    it(`ollama /api/chat stream: usage on its ${label}`, async () => {
      mockGroqStream(sse);
      const { status, text } = await request(app, '/api/chat', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      expect(status).toBe(200);
      const last = JSON.parse(text.trim().split('\n').at(-1)!);
      expect(last.done).toBe(true);
      expect({ prompt: last.prompt_eval_count, eval: last.eval_count }).toEqual({ prompt: 1234, eval: 56 });
      expect(loggedTokens()).toEqual({ input_tokens: 1234, output_tokens: 56 });
    });
  }

  // Usage on BOTH a choice frame and a later choice-less frame (some
  // relays repeat a cumulative block): the last block wins, never a sum.
  const usageBoth = frame({ content: 'Hello world' }, 'stop', { usage: { prompt_tokens: 1234, completion_tokens: 50, total_tokens: 1284 } })
    + `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'x', choices: [], usage })}\n\n`
    + 'data: [DONE]\n\n';

  it('usage on both a choice frame and a choice-less frame is counted once', async () => {
    mockGroqStream(usageBoth);
    const { status, text } = await gemini();
    expect(status).toBe(200);
    expect(geminiUsage(text)).toEqual({ promptTokenCount: 1234, candidatesTokenCount: 56, totalTokenCount: 1290 });
    expect(loggedTokens()).toEqual({ input_tokens: 1234, output_tokens: 56 });
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'success'").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  for (const [label, sse] of [['own frame', usageOwnFrame], ['last choice frame', usageLastFrame]] as const) {
    it(`ollama /api/generate stream: usage on its ${label}`, async () => {
      mockGroqStream(sse);
      const { status, text } = await request(app, '/api/generate', { model: 'auto', prompt: 'hi' });
      expect(status).toBe(200);
      const last = JSON.parse(text.trim().split('\n').at(-1)!);
      expect(last.done).toBe(true);
      expect({ prompt: last.prompt_eval_count, eval: last.eval_count }).toEqual({ prompt: 1234, eval: 56 });
      expect(loggedTokens()).toEqual({ input_tokens: 1234, output_tokens: 56 });
    });
  }

  // Control: without upstream usage the estimate (chars/4) still applies.
  it('keeps the estimate when the upstream stream reports none', async () => {
    mockGroqStream(noUsage);
    const { status, text } = await gemini();
    expect(status).toBe(200);
    expect(geminiUsage(text).candidatesTokenCount).toBe(Math.ceil('Hello world'.length / 4));
  });
});
