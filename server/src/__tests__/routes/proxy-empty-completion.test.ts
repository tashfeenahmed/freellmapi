import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Script the provider per-test: every platform resolves to this fake, so the
// first chain model gets emptyResult/emptyStream and the failover target gets
// a real completion. Mock BEFORE importing anything that pulls in the router.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

const EMPTY_RESULT = {
  choices: [{ message: { role: 'assistant', content: '' } }],
  usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
};
const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'a real answer' } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};

async function* emptyStream() { /* zero chunks */ }
async function* goodStream() {
  yield { choices: [{ delta: { content: 'streamed ' } }] };
  yield { choices: [{ delta: { content: 'answer' } }] };
}

describe('Empty-completion failover', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    // Clear cooldowns set by previous failovers so each test routes fresh.
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('/v1/chat/completions (non-stream): empty completion fails over to the next model', async () => {
    chatCompletion
      .mockResolvedValueOnce(EMPTY_RESULT)
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('a real answer');
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    // First model must differ from the one that answered.
    expect(chatCompletion.mock.calls[0][2]).not.toBe(chatCompletion.mock.calls[1][2]);
  });

  it('/v1/chat/completions (stream): zero-chunk stream fails over instead of emitting an empty stream', async () => {
    streamChatCompletion
      .mockReturnValueOnce(emptyStream())
      .mockReturnValueOnce(goodStream());

    const { status, raw } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, key);

    expect(status).toBe(200);
    expect(raw).toContain('streamed ');
    expect(raw).toContain('[DONE]');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('/v1/responses (non-stream): empty completion fails over', async () => {
    chatCompletion
      .mockResolvedValueOnce(EMPTY_RESULT)
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status, body } = await post(app, '/v1/responses', {
      input: 'hi',
    }, key);

    expect(status).toBe(200);
    expect(body.output_text).toBe('a real answer');
    expect(chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('/v1/responses (stream): empty stream fails over on the same SSE connection', async () => {
    streamChatCompletion
      .mockReturnValueOnce(emptyStream())
      .mockReturnValueOnce(goodStream());

    const { status, raw } = await post(app, '/v1/responses', {
      input: 'hi',
      stream: true,
    }, key);

    expect(status).toBe(200);
    expect(raw).toContain('response.completed');
    expect(raw).toContain('streamed answer');
    expect(raw).not.toContain('response.failed');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('logs the empty attempt as an error and the failover as success', async () => {
    chatCompletion
      .mockResolvedValueOnce(EMPTY_RESULT)
      .mockResolvedValueOnce(GOOD_RESULT);

    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, key);

    const rows = db.prepare('SELECT status, error FROM requests ORDER BY id').all() as Array<{ status: string; error: string | null }>;
    expect(rows.length).toBe(2);
    expect(rows[0].status).toBe('error');
    expect(rows[0].error).toContain('empty completion');
    expect(rows[1].status).toBe('success');
  });

  it('a tool-calls-only completion (no text) is NOT treated as empty', async () => {
    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});
