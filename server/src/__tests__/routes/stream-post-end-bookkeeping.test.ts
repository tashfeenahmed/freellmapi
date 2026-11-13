import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Every streaming surface ends the response first and does its bookkeeping
// after (request log, cache store, sticky model). An exception there used to
// land in the mid-stream catch, which wrote an error frame to the ended
// response: Node emits ERR_STREAM_WRITE_AFTER_END on `res` a tick later, nothing
// listens, and the process safety net treats it as fatal. It also logged an
// 'error' row for an answer the client received in full.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getProvider: () => fakeProvider, resolveProvider: () => fakeProvider };
});

// Fails the 'success' row the way a busy or full SQLite would.
const logged: string[] = [];
let failSuccessLog = false;
vi.mock('../../lib/request-log.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    logRequest: (...args: any[]) => {
      logged.push(args[3]);
      if (failSuccessLog && args[3] === 'success') throw new Error('SQLITE_BUSY: database is locked');
      return actual.logRequest(...args);
    },
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');

async function post(app: Express, path: string, body: any, headers: Record<string, string>) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  // The write-after-end 'error' fires on the next tick; give it room to show.
  await new Promise(resolve => setTimeout(resolve, 20));
  server.close();
  return { status: res.status, raw };
}

function textTurn() {
  return async function* () {
    yield { choices: [{ delta: { role: 'assistant', content: 'hello there, the answer is 42' } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } };
  };
}

describe('bookkeeping that throws after a stream ended', () => {
  let app: Express;
  let key: string;
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => { uncaught.push(err); };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    streamChatCompletion.mockReset();
    streamChatCompletion.mockImplementation(textTurn());
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    logged.length = 0;
    uncaught.length = 0;
    failSuccessLog = true;
    process.on('uncaughtException', onUncaught);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    failSuccessLog = false;
    process.off('uncaughtException', onUncaught);
    vi.restoreAllMocks();
  });

  const bearer = () => ({ Authorization: `Bearer ${key}` });

  const surfaces: Array<{ name: string; path: string; body: any; headers: () => Record<string, string>; done: string }> = [
    { name: '/v1/chat/completions', path: '/v1/chat/completions', body: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }, headers: bearer, done: 'data: [DONE]' },
    { name: '/v1/completions', path: '/v1/completions', body: { model: 'auto', stream: true, prompt: 'hi' }, headers: bearer, done: 'data: [DONE]' },
    { name: '/v1/responses', path: '/v1/responses', body: { input: 'hi', stream: true }, headers: bearer, done: 'response.completed' },
    { name: '/v1/messages', path: '/v1/messages', body: { model: 'auto', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }, headers: () => ({ 'x-api-key': key }), done: 'message_stop' },
    { name: 'gemini streamGenerateContent (inbound-chat)', path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, headers: () => ({ 'x-goog-api-key': key }), done: 'STOP' },
  ];

  for (const surface of surfaces) {
    it(`${surface.name}: delivers the answer, writes nothing after the end, logs no error row`, async () => {
      const { status, raw } = await post(app, surface.path, surface.body, surface.headers());

      expect(status).toBe(200);
      expect(raw).toContain('hello there');
      expect(raw).toContain(surface.done);
      expect(logged).toContain('success');
      expect(logged).not.toContain('error');
      expect(uncaught).toEqual([]);
    });
  }
});
